import { createHash } from "node:crypto"

import { Context, Effect, Schema } from "effect"

import { AssignmentId, IntentId } from "../domain/ids.ts"
import { Text } from "../domain/primitives.ts"
import { type Registry, SpecialistEntry } from "../domain/specialists.ts"
import { StateIo } from "./errors.ts"
import { commitFile, encodeJson, type File, readJson, readText } from "./files.ts"
import { localFile } from "./layout.ts"

// Per-clone state: files under `local/` that version control never sees. They hold what means
// nothing on another machine, such as the ids of launched specialists.

const ActiveIntentFile = Schema.Struct({ intentId: IntentId })
const SpecialistsFile = Schema.Struct({ specialists: Schema.Array(SpecialistEntry) })
const WorkTreesFile = Schema.Struct({ workTrees: Schema.Record(AssignmentId, Text) })

/**
 * The top-level folder of the work tree a command runs in. The Intent in use is kept per work tree,
 * so sessions in different work trees of one clone never switch each other's Intent, while all
 * other state stays shared. It is a reference so the reads and writes of one command all see the
 * same work tree without every caller passing it; the CLI sets it for the run of a command, and
 * without it no Intent is in use.
 */
export const WorkTree = Context.Reference<string | undefined>("holyagent/state/WorkTree", {
  defaultValue: () => undefined,
})

/**
 * A short key for the top-level folder of a work tree: a hash of its path, which names the file of
 * its Intent in use and marks the work tree an Assignment runs in.
 */
export const workTreeKey = (workTree: string): string =>
  createHash("sha1").update(workTree).digest("hex").slice(0, 16)

/** The file that holds the Intent in use of a work tree, named by its {@link workTreeKey}. */
const activeIntentFile = (directory: string, workTree: string): string =>
  localFile(directory, `active-intent/${workTreeKey(workTree)}.json`)

/** The file the Intent in use was kept in before it was kept per work tree: one for the clone. */
const LEGACY_ACTIVE_INTENT = "active-intent.json"

/** The per-clone state. */
export interface Local {
  /**
   * The Intent the calling work tree works on, absent when it made no choice; it may have closed or
   * gone since.
   */
  readonly activeIntent?: string
  readonly specialists: Registry
  /**
   * The key of the work tree each Running Assignment was dispatched from (see {@link workTreeKey}),
   * by Assignment id. It lives here and not in the Assignment record, because an older plugin
   * refuses a record with a key it does not know, and a work tree means nothing on another clone.
   */
  readonly workTrees: Readonly<Record<string, string>>
}

/**
 * Makes the `local/` folder and, on first use, its `.gitignore` holding `*`, so nothing in it is
 * ever committed (the ignore file ignores itself too).
 */
export const ensureLocalDirectory = <E = never>(
  directory: string,
  authorize: Effect.Effect<void, E> = Effect.void,
) => {
  const ignore = localFile(directory, ".gitignore")
  return readText(ignore).pipe(
    Effect.flatMap((text) =>
      text !== undefined ? Effect.void : authorize.pipe(Effect.andThen(commitFile(ignore, "*\n"))),
    ),
  )
}

/**
 * Reads the per-clone state, with the Intent in use of the current {@link WorkTree}, else the one
 * shared choice an older version kept; a file that was never written reads as empty.
 */
export const readLocal = (directory: string) =>
  Effect.gen(function* () {
    const workTree = yield* WorkTree
    const own =
      workTree === undefined
        ? undefined
        : yield* readJson(ActiveIntentFile, activeIntentFile(directory, workTree))
    // A clone that came from a version with one shared choice keeps it until a work tree makes its own.
    const active =
      own ?? (yield* readJson(ActiveIntentFile, localFile(directory, LEGACY_ACTIVE_INTENT)))
    const specialists = yield* readJson(SpecialistsFile, localFile(directory, "specialists.json"))
    const workTrees = yield* readJson(WorkTreesFile, localFile(directory, "work-trees.json"))
    return {
      ...(active === undefined ? {} : { activeIntent: active.intentId }),
      specialists: specialists?.specialists ?? [],
      workTrees: workTrees?.workTrees ?? {},
    } satisfies Local
  })

/**
 * What to change in the per-clone state; an absent field stays as it is. The Intent in use is set
 * for the current {@link WorkTree}.
 */
export interface LocalChange {
  readonly activeIntent?: string
  readonly specialists?: Registry
  readonly workTrees?: Readonly<Record<string, string>>
}

/** Encodes the per-clone files named in the change, without writing anything. */
export const encodeLocal = (directory: string, change: LocalChange) =>
  Effect.gen(function* () {
    const files: Array<File> = []
    if (change.activeIntent !== undefined) {
      const workTree = yield* WorkTree
      if (workTree === undefined)
        return yield* new StateIo({
          path: directory,
          cause: "No work tree to keep the Intent in use for",
        })
      files.push({
        path: activeIntentFile(directory, workTree),
        content: yield* encodeJson(ActiveIntentFile, { intentId: change.activeIntent }),
      })
    }
    if (change.specialists !== undefined)
      files.push({
        path: localFile(directory, "specialists.json"),
        content: yield* encodeJson(SpecialistsFile, { specialists: change.specialists }),
      })
    if (change.workTrees !== undefined)
      files.push({
        path: localFile(directory, "work-trees.json"),
        content: yield* encodeJson(WorkTreesFile, { workTrees: change.workTrees }),
      })
    return files
  })
