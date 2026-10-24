import { Effect, Schema } from "effect"

import { IntentId } from "../domain/ids.ts"
import { Text } from "../domain/primitives.ts"
import { type Registry, SpecialistEntry } from "../domain/specialists.ts"
import { commitFile, encodeJson, type File, io, readJson } from "./files.ts"
import { localFile } from "./layout.ts"

// Per-clone state: files under `local/` that version control never sees. They hold what means
// nothing on another machine, such as the ids of launched specialists.

const ActiveIntentFile = Schema.Struct({ intentId: IntentId })
const SpecialistsFile = Schema.Struct({ specialists: Schema.Array(SpecialistEntry) })

/** What this clone knows of its version control, for the CLI to fill in. */
export const Vcs = Schema.Struct({
  branch: Schema.optionalKey(Text),
  base: Schema.optionalKey(Text),
  pullRequest: Schema.optionalKey(Text),
  /**
   * What `vcs detect` keeps (see DetectionCache in vcs/model.ts). It is read as anything here and
   * validated by its owner, so a file in an old shape never breaks the other commands.
   */
  detection: Schema.optionalKey(Schema.Unknown),
})
/** The version control facts of this clone. */
export type Vcs = typeof Vcs.Type

/** The per-clone state. */
export interface Local {
  /** The Intent this clone works on; it may have closed or gone since. */
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

/** Reads the per-clone state; a file that was never written reads as empty. */
export const readLocal = (directory: string) =>
  Effect.gen(function* () {
    const active = yield* readJson(ActiveIntentFile, localFile(directory, "active-intent.json"))
    const specialists = yield* readJson(SpecialistsFile, localFile(directory, "specialists.json"))
    const vcs = yield* readJson(Vcs, localFile(directory, "vcs.json"))
    return {
      ...(active === undefined ? {} : { activeIntent: active.intentId }),
      specialists: specialists?.specialists ?? [],
      vcs: vcs ?? {},
    } satisfies Local
  })

/** What to change in the per-clone state; an absent field stays as it is. */
export interface LocalChange {
  readonly activeIntent?: string
  readonly specialists?: Registry
  readonly vcs?: Vcs
}

/** Encodes the per-clone files named in the change, without writing anything. */
export const encodeLocal = (directory: string, change: LocalChange) =>
  Effect.gen(function* () {
    const files: Array<File> = []
    if (change.activeIntent !== undefined)
      files.push({
        path: localFile(directory, "active-intent.json"),
        content: yield* encodeJson(ActiveIntentFile, { intentId: change.activeIntent }),
      })
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
