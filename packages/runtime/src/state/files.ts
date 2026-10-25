// `rename` is the one node: import. Bun has no rename or move API, and the atomic replace is what
// makes a write all-or-nothing. The rest is Bun: Bun.file reads and Bun.write makes directories.
import { rename, rm } from "node:fs/promises"

import { Effect, Schema } from "effect"

import { CorruptRecord, StateIo } from "./errors.ts"

/** Runs a file operation, reporting a failure as StateIo for the path. */
export const io = <A>(path: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new StateIo({ path, cause }) })

/** True when the cause is a system error with the given code. */
export const hasCode = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

/** Reads a file as text; a missing file reads as undefined. */
export const readText = (path: string) =>
  io(path, () => Bun.file(path).exists()).pipe(
    Effect.flatMap((exists) =>
      exists ? io(path, () => Bun.file(path).text()) : Effect.succeed(undefined),
    ),
  )

const strict = { onExcessProperty: "error" } as const

/**
 * Reads and strictly decodes a JSON file. A missing file reads as undefined. A file that is not
 * valid JSON for the schema is reported as CorruptRecord with its path, so the user is pointed at
 * the file and not at the command.
 */
export const readJson = <S extends Schema.Decoder<unknown>>(schema: S, path: string) =>
  readText(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(undefined)
        : Schema.decodeUnknownEffect(
            Schema.fromJsonString(schema),
            strict,
          )(text).pipe(
            Effect.mapError((error) => new CorruptRecord({ path, reason: error.message })),
          ),
    ),
  )

/**
 * Encodes a value as the text of its file: two-space indent, a trailing newline and keys in the
 * schema's field order, so the same record is always the same bytes.
 */
export const encodeJson = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: S["Type"],
) =>
  Schema.encodeEffect(schema)(value).pipe(
    Effect.map((encoded) => `${JSON.stringify(encoded, null, 2)}\n`),
  )

/**
 * Writes a file through a temporary neighbour and a rename, so a reader sees the old content or the
 * new, never half. A failure leaves no temporary file. Missing directories are created.
 */
export const commitFile = (path: string, content: string) => {
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  return io(path, () => Bun.write(temporary, content)).pipe(
    Effect.andThen(io(path, () => rename(temporary, path))),
    Effect.tapError(() => io(temporary, () => rm(temporary, { force: true })).pipe(Effect.ignore)),
  )
}

/** A file ready to be written: its path and its encoded text. */
export interface File {
  readonly path: string
  readonly content: string
}
