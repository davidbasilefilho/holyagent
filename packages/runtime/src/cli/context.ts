import { $ } from "bun"
import { Clock, Effect, Schema } from "effect"

import { InvalidDraft } from "../domain/errors.ts"
import { StdinMissing } from "./errors.ts"
import type { Host } from "./types.ts"

/** The current time as ISO 8601 text, the form the records store. */
export const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString()),
)

/**
 * The state root: the git top-level of the directory, else the directory itself. A directory git
 * cannot read, or a machine without git, falls back to the directory too.
 */
export const stateRoot = (cwd: string) =>
  Effect.tryPromise(() => $`git rev-parse --show-toplevel`.cwd(cwd).quiet().nothrow()).pipe(
    Effect.map((output) => (output.exitCode === 0 ? output.text().trim() : "")),
    Effect.orElseSucceed(() => ""),
    Effect.map((top) => (top === "" ? cwd : top)),
  )

/** Reads stdin as raw text, failing with StdinMissing when it is a terminal or blank. */
export const readReport = (host: Host) =>
  host.stdin.pipe(
    Effect.filterOrFail(
      (text) => text.trim() !== "",
      () => new StdinMissing({ reason: "stdin was empty" }),
    ),
  )

/** Reads stdin as JSON and decodes it with the schema, failing on a missing or excess property. */
export const readInput = <S extends Schema.Decoder<unknown>>(host: Host, schema: S) =>
  readReport(host).pipe(
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema), {
        onExcessProperty: "error",
      })(text).pipe(
        Effect.mapError((error) => new InvalidDraft({ message: `stdin: ${error.message}` })),
      ),
    ),
  )
