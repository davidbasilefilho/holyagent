import { Context, Effect, Schema } from "effect"

import { IntentId } from "../domain/ids.ts"
import { Text } from "../domain/primitives.ts"
import { type Registry, SpecialistEntry } from "../domain/specialists.ts"
import { StateIo } from "./errors.ts"
import { commitFile, encodeJson, type File, io, readJson } from "./files.ts"
import { localFile } from "./layout.ts"

// Per-clone state: files under `local/` that version control never sees. They hold what means
// nothing on another machine, such as the ids of launched specialists.

const ActiveIntentFile = Schema.Struct({ intentId: IntentId })
const SpecialistsFile = Schema.Struct({ specialists: Schema.Array(SpecialistEntry) })

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

/** The file that holds the Intent in use of a work tree, named by a hash of the work tree's path. */
const activeIntentFile = (directory: string, workTree: string): string =>
  localFile(
    directory,
    `active-intent/${new Bun.CryptoHasher("sha1").update(workTree).digest("hex").slice(0, 16)}.json`,
  )

/** The file the Intent in use was kept in before it was kept per work tree: one for the clone. */
const LEGACY_ACTIVE_INTENT = "active-intent.json"

/** What this clone knows of its version control, for the CLI to fill in. */
export const Vcs = Schema.Struct({
  branch: Schema.optionalKey(Text),
  base: Schema.optionalKey(Text),
  pullRequest: Schema.optionalKey(Text),
  /**
   * What an earlier version of the CLI kept about how commits are made. It is read as anything and
   * kept as it was, so an older file never breaks the other commands.
   */
  detection: Schema.optionalKey(Schema.Unknown),
})
/** The version control facts of this clone. */
export type Vcs = typeof Vcs.Type

/** The per-clone state. */
export interface Local {
  /**
   * The Intent the calling work tree works on, absent when it made no choice; it may have closed or
   * gone since.
   */
  readonly activeIntent?: string
  readonly specialists: Registry
  readonly vcs: Vcs
}

/**
 * Makes the `local/` folder and, on first use, its `.gitignore` holding `*`, so nothing in it is
 * ever committed (the ignore file ignores itself too).
 */
export const ensureLocalDirectory = (directory: string) => {
  const ignore = localFile(directory, ".gitignore")
  return io(ignore, () => Bun.file(ignore).exists()).pipe(
    Effect.flatMap((exists) => (exists ? Effect.void : commitFile(ignore, "*\n"))),
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
    const vcs = yield* readJson(Vcs, localFile(directory, "vcs.json"))
    return {
      ...(active === undefined ? {} : { activeIntent: active.intentId }),
      specialists: specialists?.specialists ?? [],
      vcs: vcs ?? {},
    } satisfies Local
  })

/**
 * What to change in the per-clone state; an absent field stays as it is. The Intent in use is set
 * for the current {@link WorkTree}.
 */
export interface LocalChange {
  readonly activeIntent?: string
  readonly specialists?: Registry
  readonly vcs?: Vcs
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
    if (change.vcs !== undefined)
      files.push({
        path: localFile(directory, "vcs.json"),
        content: yield* encodeJson(Vcs, change.vcs),
      })
    return files
  })
