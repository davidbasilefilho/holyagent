import { join } from "node:path"

import { Effect, Schema } from "effect"

import { CorruptRecord } from "../state/errors.ts"
import { readText } from "../state/files.ts"

/** The `vcs` section of `.holyagent/config.json`. */
export const VcsSettings = Schema.Struct({
  /** No longer used: commits always go through git. Accepted so an older config file still reads. */
  api: Schema.optionalKey(Schema.Boolean),
  /** Phrases of the message check that this project's domain uses legitimately. */
  allowWords: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The branch that holds the Intent state, `holyagent/state` unless this names another. */
  stateBranch: Schema.optionalKey(Schema.String),
})
/** The `vcs` section of `.holyagent/config.json`. */
export type VcsSettings = typeof VcsSettings.Type

const File = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/**
 * Reads the `vcs` section of the config file in the first of the state folders that has one. A
 * missing file or section reads as the defaults; other sections belong to other readers and are
 * ignored, but a mistake inside `vcs` is reported with the file's path.
 */
export const readSettings = (directories: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    for (const directory of directories) {
      const path = join(directory, "config.json")
      const text = yield* readText(path)
      if (text === undefined) continue
      const corrupt = (reason: string) => new CorruptRecord({ path, reason })
      const file = yield* Schema.decodeUnknownEffect(File)(text).pipe(
        Effect.mapError((error) => corrupt(error.message)),
      )
      return yield* Schema.decodeUnknownEffect(VcsSettings, { onExcessProperty: "error" })(
        file["vcs"] ?? {},
      ).pipe(Effect.mapError((error) => corrupt(`vcs: ${error.message}`)))
    }
    const defaults: VcsSettings = {}
    return defaults
  })
