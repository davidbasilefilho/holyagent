import { join } from "node:path"

import { Effect, Schema } from "effect"

import { CorruptRecord } from "../state/errors.ts"
import { readText } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"

/** The `vcs` section of `.holyagent/config.json`. */
export const VcsSettings = Schema.Struct({
  /** False keeps commits off the GitHub API, so identity mismatches fall back to git. */
  api: Schema.optionalKey(Schema.Boolean),
  /** Phrases of the message check that this project's domain uses legitimately. */
  allowWords: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** The `vcs` section of `.holyagent/config.json`. */
export type VcsSettings = typeof VcsSettings.Type

const File = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/**
 * Reads the `vcs` section of the project's config file. A missing file or section reads as the
 * defaults; other sections belong to other readers and are ignored, but a mistake inside `vcs` is
 * reported with the file's path.
 */
export const readSettings = (root: string) => {
  const path = join(root, STATE_DIRECTORY, "config.json")
  const corrupt = (reason: string) => new CorruptRecord({ path, reason })
  return readText(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed<VcsSettings>({})
        : Schema.decodeUnknownEffect(File)(text).pipe(
            Effect.mapError((error) => corrupt(error.message)),
            Effect.flatMap((file) =>
              Schema.decodeUnknownEffect(VcsSettings, { onExcessProperty: "error" })(
                file["vcs"] ?? {},
              ).pipe(Effect.mapError((error) => corrupt(`vcs: ${error.message}`))),
            ),
          ),
    ),
  )
}
