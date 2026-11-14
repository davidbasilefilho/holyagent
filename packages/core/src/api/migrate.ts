import { copyFile, lstat, mkdir, readdir } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { Data, Effect, Schema } from "effect"

import { StateIo } from "../state/errors.ts"
import { commitFile, hasCode, io, readText } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { type Gathered, gatherLegacy, LEGACY_FOLDERS } from "../state/legacy.ts"
import { withStateLock } from "../state/lock.ts"
import { spawn } from "../state/process.ts"
import { loadProject } from "../state/store.ts"
import { commitState, gitEnvironment } from "../state/tree.ts"
import { type Context, decode, requireCapability, withState } from "./context.ts"

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

const exists = (path: string) =>
  io(path, () => lstat(path)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  )

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

/**
 * Writes the records, Intents first, then copies the notes; returns the records and the paths of
 * the copied files. Call it under the lock.
 */
const writeAll = (found: ReadonlyArray<Gathered>) =>
  Effect.gen(function* () {
    const records = found.flatMap((gathered) => gathered.records)
    for (const kind of ["intent", "assignment"] as const)
      for (const record of records.filter((candidate) => candidate.kind === kind))
        yield* commitFile(record.file.path, record.file.content)
    const notes = found.flatMap((gathered) => gathered.notes)
    for (const note of notes) {
      yield* io(note.to, () => mkdir(dirname(note.to), { recursive: true }))
      yield* io(note.to, () => copyFile(note.from, note.to))
    }
    return { records, copied: notes.map((note) => note.to) }
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
    const output = yield* spawn(
      "git",
      ["grep", "-I", "-l", "-F", "--untracked", ...patterns, "--", ".", ...excluded],
      { cwd: root, env: gitEnvironment({}) },
    ).pipe(Effect.catchDefect((cause) => Effect.fail(new StateIo({ path: root, cause }))))
    if (output.code === 0 || output.code === 1)
      return new TextDecoder()
        .decode(output.stdout)
        .split("\n")
        .filter((line) => line !== "")
        .toSorted()
    const names = yield* io(root, () =>
      readdir(root, { withFileTypes: true }).then((entries) =>
        entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      ),
    )
    const hits: Array<string> = []
    for (const name of names.toSorted()) {
      const text = yield* readText(join(root, name))
      if (text !== undefined && folders.some((folder) => text.includes(folder))) hits.push(name)
    }
    return hits
  })

/** Strict migration operation input. */
export const schema = Schema.Struct({ dryRun: Schema.optionalKey(Schema.Boolean) })

/** Converts legacy state after checking all conflicts, without deleting legacy data. */
export const migrate = (context: Context, input: typeof schema.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schema, input)
    return yield* withState(
      context,
      "migrate",
      request.dryRun ? "ifPresent" : "create",
      ({ directory, root }) =>
        Effect.gen(function* () {
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
          if (request.dryRun)
            return { dryRun: true, counts, unconvertible, stops, conflicts, mentions, problems }
          if (problems.length > 0) return yield* new MigrationRefused({ problems })
          return yield* withStateLock(
            directory,
            Effect.gen(function* () {
              const again = yield* conflictsOf(root, directory, found)
              if (again.length > 0) return yield* new MigrationRefused({ problems: again })
              yield* requireCapability(context, "migrate")
              return yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  const { records, copied } = yield* writeAll(found)
                  yield* commitState(
                    directory,
                    context.env,
                    "chore(state): convert the legacy state",
                    copied,
                  )
                  const loaded = yield* reload(directory, records)
                  return { migrated: true, counts, reloaded: loaded, mentions }
                }),
              )
            }),
          )
        }),
    )
  })
