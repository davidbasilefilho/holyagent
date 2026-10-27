import { join, relative } from "node:path"

import { $ } from "bun"
import { Data, Effect } from "effect"

import { StateIo } from "../state/errors.ts"
import { commitFile, io, readText } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { type Gathered, gatherLegacy, LEGACY_FOLDERS } from "../state/legacy.ts"
import { withStateLock } from "../state/lock.ts"
import { loadProject } from "../state/store.ts"
import { commitState } from "../state/tree.ts"
import { booleanFlag } from "./args.ts"
import type { Command } from "./types.ts"
import { present } from "./views.ts"

/** No legacy state folder holds anything to migrate. */
export class NothingToMigrate extends Data.TaggedError("NothingToMigrate")<{
  readonly root: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.root} has no ${LEGACY_FOLDERS.holyclaude}/ or ${LEGACY_FOLDERS.holycodex}/ folder with state in it`
  }
}

/** The migration found something it will not write over or around, so it wrote nothing. */
export class MigrationRefused extends Data.TaggedError("MigrationRefused")<{
  readonly problems: ReadonlyArray<string>
}> {
  /** The description shown to the user. */
  override get message() {
    const shown = this.problems.slice(0, 10)
    const more = this.problems.length - shown.length
    return `Nothing was written, ${this.problems.length} problem(s) stop the migration: ${shown.join("; ")}${
      more > 0 ? `; and ${more} more (run \`holyagent migrate --dry-run\` for the full list)` : ""
    }. Fix them and run the command again`
  }
}

/** The records were written but the project does not load back as they were written. */
export class MigrationUnverified extends Data.TaggedError("MigrationUnverified")<{
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `The records were written but reloading .holyagent/ failed: ${this.detail}. Delete the files written by this run (git status lists them) before trying again`
  }
}

const exists = (path: string) => io(path, () => Bun.file(path).exists())

/** The counts of one source, as the dry run and the run print them. */
const countsOf = (gathered: Gathered) => ({
  intents: gathered.records.filter((record) => record.kind === "intent").length,
  assignments: gathered.records.filter((record) => record.kind === "assignment").length,
  notes: gathered.notes.length,
})

/**
 * What stops the files from being written: an id already in `.holyagent/`, an id two legacy records
 * share, and a target file that exists. Nothing is overwritten, so each one is a refusal.
 */
const conflictsOf = (root: string, directory: string, found: ReadonlyArray<Gathered>) =>
  Effect.gen(function* () {
    const project = yield* loadProject(directory)
    const known = new Set([
      ...project.intents.map((intent) => intent.id),
      ...project.assignments.map((assignment) => assignment.id),
    ])
    const seen = new Map<string, string>()
    const problems: Array<string> = []
    const shown = (path: string) => relative(root, path)
    for (const record of found.flatMap((gathered) => gathered.records)) {
      const first = seen.get(record.id)
      seen.set(record.id, record.from)
      // A record already in .holyagent/ is one conflict, however many of its files exist.
      if (known.has(record.id))
        problems.push(`${record.kind} ${record.id} (${record.from}) already exists in .holyagent/`)
      else {
        if (first !== undefined)
          problems.push(`${record.kind} ${record.id} is in both ${first} and ${record.from}`)
        if (yield* exists(record.file.path))
          problems.push(`${shown(record.file.path)} already exists`)
      }
    }
    for (const note of found.flatMap((gathered) => gathered.notes))
      if (yield* exists(note.to)) problems.push(`${shown(note.to)} already exists`)
    return problems
  })

/** Writes the records, Intents first, then copies the notes. Call it under the lock. */
const writeAll = (found: ReadonlyArray<Gathered>) =>
  Effect.gen(function* () {
    const records = found.flatMap((gathered) => gathered.records)
    for (const kind of ["intent", "assignment"] as const)
      for (const record of records.filter((candidate) => candidate.kind === kind))
        yield* commitFile(record.file.path, record.file.content)
    for (const note of found.flatMap((gathered) => gathered.notes))
      yield* io(note.to, () => Bun.write(note.to, Bun.file(note.from)))
    return records
  })

/** Reloads `.holyagent/` and checks that every record that was written is in it. */
const reload = (directory: string, written: ReadonlyArray<{ kind: string; id: string }>) =>
  loadProject(directory).pipe(
    Effect.mapError((error) => new MigrationUnverified({ detail: error.message })),
    Effect.flatMap((project) => {
      const ids = new Set([
        ...project.intents.map((intent) => intent.id),
        ...project.assignments.map((assignment) => assignment.id),
      ])
      const missing = written.filter((record) => !ids.has(record.id))
      return missing.length === 0
        ? Effect.succeed({
            intents: project.intents.length,
            assignments: project.assignments.length,
          })
        : Effect.fail(
            new MigrationUnverified({
              detail: `${missing.map((record) => `${record.kind} ${record.id}`).join(", ")} did not load`,
            }),
          )
    }),
  )

/**
 * The project files that name a legacy folder, so the root can point them at `.holyagent/`. In a
 * repository it asks `git grep` (tracked and untracked files, not ignored ones); elsewhere it reads
 * the files at the top of the project. State folders are left out.
 */
const mentionsOf = (root: string, folders: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const patterns = folders.flatMap((folder) => ["-e", folder])
    const excluded = [STATE_DIRECTORY, ...folders].map((folder) => `:(exclude)${folder}`)
    const output = yield* Effect.tryPromise({
      try: () =>
        $`git grep -I -l -F --untracked ${patterns} -- . ${excluded}`.cwd(root).quiet().nothrow(),
      catch: (cause) => new StateIo({ path: root, cause }),
    })
    if (output.exitCode === 0 || output.exitCode === 1)
      return output
        .text()
        .split("\n")
        .filter((line) => line !== "")
        .toSorted()
    const names = yield* io(root, () =>
      Array.fromAsync(new Bun.Glob("*").scan({ cwd: root, dot: true, onlyFiles: true })),
    )
    const hits: Array<string> = []
    for (const name of names.toSorted()) {
      const text = yield* readText(join(root, name))
      if (text !== undefined && folders.some((folder) => text.includes(folder))) hits.push(name)
    }
    return hits
  })

const NOTES: ReadonlyArray<string> = [
  "reads .holyclaude/ and .holycodex/ at the state root, whichever exist, and writes .holyagent/ records the CLI loads. It deletes nothing: the records are committed on the state branch (the legacy folders are read at the work tree root, the records written in the state worktree), and removing the legacy folders is left to the root. It lists the project files that name a legacy folder (lint and format ignore lists, for example) without editing them, so the root can point them at .holyagent/",
  "--dry-run prints the counts per source (intents, assignments, notes), every record it cannot convert with the reason, and everything a real run would refuse; it writes nothing. A real run first checks the same things and writes nothing unless all are clear: every record converts, no target file or id exists in .holyagent/ (nothing is overwritten), no Assignment is Running (holyclaude) or executing (holycodex) and no holycodex transaction is pending. A Running or executing Assignment is named with how to settle it: finish or cancel it with the legacy tool, then migrate again. It then reloads .holyagent/ and fails if any record does not decode",
  "records are decoded strictly: a field the legacy schema does not list makes the record unconvertible, and every record is written through the holyagent schemas, so one that breaks a holyagent rule is reported with that rule. Files ending in .tmp are skipped",
  "holyclaude, Intent: the id and revision are kept; the slug comes from the objective; requirements become one entry (none when blank); the state is Open, or Closed with its close_reason (closed_at is dropped); createdAt is the time in the id (the epoch for an early counter id such as intent-0001, which carries none). Notes in the Intent folder (resume-notes.md, notes/) are copied unchanged",
  "holyclaude, Assignment: the role becomes the roleTask and the slug comes from the objective; each acceptance criterion becomes a blocking criterion of dimension behavior (the objective when there are none); required_evidence becomes the evidence labels; a path in ownership_paths that is not portable (absolute, with .., a trailing dot and so on) moves into scope as text and is not enforced, so a Ready writer left without a portable path needs paths before it can be dispatched; related_assignments move into scope as text; dependencies and independent_from keep only the ids of Assignments migrated for the same Intent (the others move into scope as text); symbols, domains, clone_id and mutability (the route decides it) are dropped; a state other than Ready gets the legacy result or a placeholder text; a Succeeded Assignment keeps its acceptance (rationale, criteria_evidence, required_evidence) at its intent_revision, so it needs no new acceptance; createdAt is the time in the id",
  "holyclaude, not migrated: local/ (agent ids, workers, observations), state.json* and the legacy .gitignore; the CLI makes its own .holyagent/local/.gitignore",
  "holycodex, Intent: the id and revision are kept (an id not shaped intent-* gets the prefix); objective is the title; requirements are the goal followed by each acceptance criterion; complete and abandoned become Closed with a closeReason naming the state, every other state becomes Open (the exact state, blockers, gates, evidence, baseline and plan pointers are dropped); createdAt is created_at and updated_at is dropped. intent.toon of schema holycodex-intent-0 is read too",
  "holycodex, Assignment: roleTask is owner.role.owner.task, and an owner holyagent has no route for (Reviewer.plan) is unconvertible; pending becomes Ready, completed Succeeded (with no acceptance, so the root still accepts it), failed Failed, blocked and needs_root_input Failed, superseded Cancelled; the result is the last invocation summary, then the blocker, then the holycodex status for blocked, needs_root_input and superseded, or a placeholder; intentRevision is the revision of the Intent (the Assignment's own revision, invocations, evidence, supersession links and remaining risk are dropped); acceptance criteria become blocking behavior criteria (the objective when there are none); scope is kept as text and, for a writing route only, its portable entries are also the ownership paths; constraints are followed by the exclusions, each prefixed Exclusion:; dependencies that name an Assignment migrated for the same Intent are kept (an id not shaped assignment-* gets the prefix) and the others move into scope as text; createdAt is created_at",
  "holycodex, notes: plan.toon, plan.old-NNN.toon and every other file of an Intent folder are copied unchanged. Not migrated: the current pointer and .intent-store. A pending .holycodex-transaction.toon stops the run: run a holycodex-agent command that reads the work state (for example holycodex-agent intent current) so it recovers the write, then migrate again",
]

/** The `migrate` command. */
export const MIGRATE_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["migrate"],
    usage: "migrate [--dry-run]",
    summary:
      "Convert the legacy .holyclaude/ and .holycodex/ state of the project into .holyagent/ records",
    notes: NOTES,
    flags: { "dry-run": "boolean" },
    positionals: 0,
    state: (args) => (booleanFlag(args, "dry-run") ? "ifPresent" : "create"),
    run: ({ args, directory, root, env }) =>
      Effect.gen(function* () {
        const dryRun = booleanFlag(args, "dry-run")
        const found = yield* gatherLegacy(root, directory)
        if (found.length === 0) return yield* new NothingToMigrate({ root })
        const folders = found.map((gathered) => LEGACY_FOLDERS[gathered.source])
        const counts = Object.fromEntries(
          found.map((gathered) => [gathered.source, countsOf(gathered)]),
        )
        const unconvertible = found.flatMap((gathered) => gathered.unconvertible)
        const stops = found.flatMap((gathered) => gathered.stops)
        const conflicts = yield* conflictsOf(root, directory, found)
        const mentions = yield* mentionsOf(root, folders)
        const problems = [
          ...unconvertible.map(({ path, reason }) => `${path} cannot be converted: ${reason}`),
          ...stops.map(({ path, message }) => `${path}: ${message}`),
          ...conflicts,
        ]
        if (dryRun)
          return present({
            dryRun: true,
            ...counts,
            unconvertible,
            stops,
            conflicts,
            mentions,
            verdict:
              problems.length === 0
                ? "a real run would write these records"
                : "a real run would refuse until the problems above are cleared",
          })
        if (problems.length > 0) return yield* new MigrationRefused({ problems })
        const written = yield* withStateLock(
          directory,
          Effect.gen(function* () {
            const again = yield* conflictsOf(root, directory, found)
            if (again.length > 0) return yield* new MigrationRefused({ problems: again })
            const records = yield* writeAll(found)
            yield* commitState(directory, env, "chore(state): convert the legacy state")
            return records
          }),
        )
        const loaded = yield* reload(directory, written)
        return present({
          migrated: true,
          ...counts,
          reloaded: loaded,
          mentions,
          next: `Nothing was deleted; in a git repository the records are committed on the state branch. Check the result with \`holyagent intent list\`, point the files under mentions at .holyagent/, then delete ${folders.join(" and ")} (the root does it)`,
        })
      }),
  },
]
