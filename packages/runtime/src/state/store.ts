import { join, relative } from "node:path"

import { Effect, Schedule } from "effect"

import { Assignment } from "../domain/assignment.ts"
import { Intent } from "../domain/intent.ts"
import { BranchRecord, type Links, PullRecord } from "../domain/links.ts"
import type { Change, Project } from "../domain/project.ts"
import { CorruptRecord, StateIo } from "./errors.ts"
import { commitFile, encodeJson, type File, hasCode, io, readJson } from "./files.ts"
import { assignmentFile, branchFile, intentFile, intentFolder, pullFile } from "./layout.ts"
import { encodeLocal, type Local, type LocalChange, readLocal } from "./local.ts"
import { withStateLock } from "./lock.ts"
import { commitState, type Environment } from "./tree.ts"

/** The relative paths below the state folder that match, in a stable order. */
const scan = (directory: string, pattern: string) =>
  io(directory, () => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: directory }))).pipe(
    Effect.map((paths) => paths.toSorted()),
    // A project that never stored anything has no state folder yet.
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed([] as ReadonlyArray<string>),
    ),
  )

/** Fails unless the file sits where the record says it belongs, since a write would go there. */
const requireLocation = (path: string, expected: string) =>
  path === expected
    ? Effect.void
    : Effect.fail(new CorruptRecord({ path, reason: `the record belongs in ${expected}` }))

const loadIntents = (directory: string) =>
  Effect.gen(function* () {
    const intents: Array<Intent> = []
    for (const file of yield* scan(directory, "intents/*/intent.json")) {
      const path = join(directory, file)
      const intent = yield* readJson(Intent, path)
      if (intent === undefined) continue
      yield* requireLocation(path, intentFile(directory, intent))
      intents.push(intent)
    }
    return intents
  })

const loadAssignments = (
  directory: string,
  relatives: ReadonlyArray<string>,
  intents: ReadonlyArray<Intent>,
) =>
  Effect.gen(function* () {
    const assignments: Array<Assignment> = []
    for (const file of relatives) {
      const path = join(directory, file)
      const assignment = yield* readJson(Assignment, path)
      if (assignment === undefined) continue
      const intent = intents.find((candidate) => candidate.id === assignment.intentId)
      if (intent === undefined)
        return yield* new CorruptRecord({
          path,
          reason: `Intent ${assignment.intentId} does not exist`,
        })
      yield* requireLocation(path, assignmentFile(intentFolder(directory, intent), assignment))
      assignments.push(assignment)
    }
    return assignments
  })

const loadLinks = (directory: string, intents: ReadonlyArray<Intent>) =>
  Effect.gen(function* () {
    const branches: Array<BranchRecord> = []
    const pulls: Array<PullRecord> = []
    for (const intent of intents) {
      const folder = intentFolder(directory, intent)
      const prefix = relative(directory, folder)
      for (const file of yield* scan(directory, join(prefix, "branches/*.json"))) {
        const path = join(directory, file)
        const record = yield* readJson(BranchRecord, path)
        if (record === undefined) continue
        yield* requireLocation(path, branchFile(folder, record))
        if (record.intentId !== intent.id)
          return yield* new CorruptRecord({ path, reason: `the record belongs to ${intent.id}` })
        branches.push(record)
      }
      for (const file of yield* scan(directory, join(prefix, "pulls/*.json"))) {
        const path = join(directory, file)
        const record = yield* readJson(PullRecord, path)
        if (record === undefined) continue
        yield* requireLocation(path, pullFile(folder, record))
        if (record.intentId !== intent.id)
          return yield* new CorruptRecord({ path, reason: `the record belongs to ${intent.id}` })
        pulls.push(record)
      }
    }
    return { branches, pulls } satisfies Links
  })

/**
 * Reads and validates every Intent and Assignment under the state folder. Each file must decode
 * strictly and sit at the path its own fields name (`intents/<slug>-<id>/intent.json`,
 * `.../assignments/<role-task>-<slug>-<id>.json`), and an Assignment must belong to an Intent that
 * exists; a file that does not is reported with its path. A folder with nothing in it is an empty
 * project.
 */
export const loadProject = (directory: string) =>
  Effect.gen(function* () {
    const intents = yield* loadIntents(directory)
    const assignments = yield* loadAssignments(
      directory,
      yield* scan(directory, "intents/*/assignments/*.json"),
      intents,
    )
    return { intents, assignments } satisfies Project
  })

/**
 * Like {@link loadProject}, but for the open Intents only: every Intent file is read to see its
 * state, while Assignment files are read only under the open ones, so the cost does not grow with
 * closed history. The checks on what is read are the same; closed Intents and their Assignments are
 * left out and not validated.
 */
export const loadOpenProject = (directory: string) =>
  Effect.gen(function* () {
    const intents = (yield* loadIntents(directory)).filter((intent) => intent.state === "Open")
    const relatives = yield* Effect.forEach(intents, (intent) =>
      scan(
        directory,
        join(relative(directory, intentFolder(directory, intent)), "assignments/*.json"),
      ),
    )
    const assignments = yield* loadAssignments(directory, relatives.flat(), intents)
    return { intents, assignments } satisfies Project
  })

/**
 * Everything the CLI reads: the versioned project, the branch and pull request records of its
 * Intents and this clone's local state.
 */
export interface Snapshot extends Local {
  readonly project: Project
  readonly links: Links
}

const readSnapshot = (directory: string, load: typeof loadProject = loadProject) =>
  Effect.gen(function* () {
    const project = yield* load(directory)
    const links = yield* loadLinks(directory, project.intents)
    const local = yield* readLocal(directory)
    return { ...local, project, links } satisfies Snapshot
  })

const retryCorrupt = {
  schedule: Schedule.spaced("25 millis"),
  times: 3,
  while: (error: { readonly _tag: string }) => error._tag === "CorruptRecord",
} as const

/**
 * Reads the whole state without locking. A writer may be between two of its files, which reads as a
 * corrupt record for a moment, so a corrupt read is repeated a few times before it is reported.
 */
export const readState = (directory: string) =>
  readSnapshot(directory).pipe(Effect.retry(retryCorrupt))

/**
 * Reads the state of the open Intents only (see {@link loadOpenProject}), repeating as `readState`
 * does.
 */
export const readOpenState = (directory: string) =>
  readSnapshot(directory, loadOpenProject).pipe(Effect.retry(retryCorrupt))

/** What to write: the changed records of a transition and the per-clone files to update. */
export type StateChange = Change & Omit<LocalChange, "specialists">

/**
 * Writes the changed records and local files. Everything is encoded and checked before the first
 * file is written, so a record that cannot be stored fails the whole change instead of leaving it
 * half done. Call it under the lock.
 */
const persist = (directory: string, project: Project, change: StateChange) =>
  Effect.gen(function* () {
    const intents = [...(change.intents ?? []), ...project.intents]
    const files: Array<File> = []
    for (const intent of change.intents ?? [])
      files.push({
        path: intentFile(directory, intent),
        content: yield* encodeJson(Intent, intent),
      })
    for (const assignment of change.assignments ?? []) {
      const intent = intents.find((candidate) => candidate.id === assignment.intentId)
      if (intent === undefined)
        return yield* new StateIo({
          path: directory,
          cause: `Assignment ${assignment.id} names unknown Intent ${assignment.intentId}`,
        })
      files.push({
        path: assignmentFile(intentFolder(directory, intent), assignment),
        content: yield* encodeJson(Assignment, assignment),
      })
    }
    for (const record of change.branches ?? []) {
      const intent = intents.find((candidate) => candidate.id === record.intentId)
      if (intent === undefined)
        return yield* new StateIo({
          path: directory,
          cause: `Branch record ${record.id} names unknown Intent ${record.intentId}`,
        })
      files.push({
        path: branchFile(intentFolder(directory, intent), record),
        content: yield* encodeJson(BranchRecord, record),
      })
    }
    for (const record of change.pulls ?? []) {
      const intent = intents.find((candidate) => candidate.id === record.intentId)
      if (intent === undefined)
        return yield* new StateIo({
          path: directory,
          cause: `Pull request record ${record.id} names unknown Intent ${record.intentId}`,
        })
      files.push({
        path: pullFile(intentFolder(directory, intent), record),
        content: yield* encodeJson(PullRecord, record),
      })
    }
    files.push(
      ...(yield* encodeLocal(directory, {
        ...(change.activeIntent === undefined ? {} : { activeIntent: change.activeIntent }),
        ...(change.registry === undefined ? {} : { specialists: change.registry }),
        ...(change.vcs === undefined ? {} : { vcs: change.vcs }),
      })),
    )
    for (const file of files) yield* commitFile(file.path, file.content)
  })

const MAX_LISTED = 4

/** The subject of the state commit for a change: the records it wrote, by kind and id. */
const describe = (change: StateChange): string => {
  const records = [
    ...(change.intents ?? []).map((intent) => `intent ${intent.id}`),
    ...(change.assignments ?? []).map((row) => `assignment ${row.id} ${row.state}`),
    ...(change.branches ?? []).map((row) => `branch ${row.branch} of ${row.intentId}`),
    ...(change.pulls ?? []).map((row) => `pull request ${row.number} of ${row.intentId}`),
  ]
  const shown = records.slice(0, MAX_LISTED).join(", ")
  const more = records.length - MAX_LISTED
  return `chore(state): record ${records.length === 0 ? "state" : shown}${more > 0 ? ` and ${more} more` : ""}`
}

/**
 * Applies a transition under the state lock: lock, read, run the transition on what was read, write
 * only the records and local files it changed, and commit the changed records on the state branch
 * (see {@link commitState}; nothing is committed outside the state worktree or when only local files
 * changed). A transition that fails, or a record that cannot be encoded, writes nothing. The files
 * are then written one by one, so a crash between two leaves the earlier ones written; every file
 * on its own is whole. `env` is the environment git runs with for the commit; git's own (the
 * process environment) is always the base.
 */
export const updateState = <A extends StateChange, E>(
  directory: string,
  transition: (snapshot: Snapshot) => Effect.Effect<A, E>,
  env: Environment = {},
) =>
  withStateLock(
    directory,
    Effect.gen(function* () {
      const snapshot = yield* readSnapshot(directory)
      const result = yield* transition(snapshot)
      yield* persist(directory, snapshot.project, result)
      if (
        result.intents !== undefined ||
        result.assignments !== undefined ||
        result.branches !== undefined ||
        result.pulls !== undefined
      )
        yield* commitState(directory, env, describe(result))
      return result
    }),
  )
