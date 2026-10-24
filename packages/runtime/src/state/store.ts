import { join } from "node:path"

import { Effect, Schedule } from "effect"

import { Assignment } from "../domain/assignment.ts"
import { Intent } from "../domain/intent.ts"
import type { Change, Project } from "../domain/project.ts"
import { CorruptRecord, StateIo } from "./errors.ts"
import { commitFile, encodeJson, type File, hasCode, io, readJson } from "./files.ts"
import { assignmentFile, intentFile, intentFolder } from "./layout.ts"
import { encodeLocal, type Local, type LocalChange, readLocal } from "./local.ts"
import { withStateLock } from "./lock.ts"

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

/**
 * Reads and validates every Intent and Assignment under the state folder. Each file must decode
 * strictly and sit at the path its own fields name (`intents/<slug>-<id>/intent.json`,
 * `.../assignments/<role-task>-<slug>-<id>.json`), and an Assignment must belong to an Intent that
 * exists; a file that does not is reported with its path. A folder with nothing in it is an empty
 * project.
 */
export const loadProject = (directory: string) =>
  Effect.gen(function* () {
    const intents: Array<Intent> = []
    for (const relative of yield* scan(directory, "intents/*/intent.json")) {
      const path = join(directory, relative)
      const intent = yield* readJson(Intent, path)
      if (intent === undefined) continue
      yield* requireLocation(path, intentFile(directory, intent))
      intents.push(intent)
    }
    const assignments: Array<Assignment> = []
    for (const relative of yield* scan(directory, "intents/*/assignments/*.json")) {
      const path = join(directory, relative)
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
    return { intents, assignments } satisfies Project
  })

/** Everything the CLI reads: the versioned project and this clone's local state. */
export interface Snapshot extends Local {
  readonly project: Project
}

const readSnapshot = (directory: string) =>
  Effect.all({ project: loadProject(directory), local: readLocal(directory) }).pipe(
    Effect.map(({ project, local }): Snapshot => ({ ...local, project })),
  )

/**
 * Reads the whole state without locking. A writer may be between two of its files, which reads as a
 * corrupt record for a moment, so a corrupt read is repeated a few times before it is reported.
 */
export const readState = (directory: string) =>
  readSnapshot(directory).pipe(
    Effect.retry({
      schedule: Schedule.spaced("25 millis"),
      times: 3,
      while: (error) => error._tag === "CorruptRecord",
    }),
  )

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
    files.push(
      ...(yield* encodeLocal(directory, {
        ...(change.activeIntent === undefined ? {} : { activeIntent: change.activeIntent }),
        ...(change.registry === undefined ? {} : { specialists: change.registry }),
        ...(change.vcs === undefined ? {} : { vcs: change.vcs }),
      })),
    )
    for (const file of files) yield* commitFile(file.path, file.content)
  })

/**
 * Applies a transition under the state lock: lock, read, run the transition on what was read, and
 * write only the records and local files it changed. A transition that fails, or a record that
 * cannot be encoded, writes nothing. The files are then written one by one, so a crash between two
 * leaves the earlier ones written; every file on its own is whole.
 */
export const updateState = <A extends StateChange, E>(
  directory: string,
  transition: (snapshot: Snapshot) => Effect.Effect<A, E>,
) =>
  withStateLock(
    directory,
    Effect.gen(function* () {
      const snapshot = yield* readSnapshot(directory)
      const result = yield* transition(snapshot)
      yield* persist(directory, snapshot.project, result)
      return result
    }),
  )
