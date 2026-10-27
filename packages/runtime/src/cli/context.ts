import { Clock, Effect, Schema } from "effect"

import { InvalidDraft } from "../domain/errors.ts"
import { StdinMissing, Usage } from "./errors.ts"
import type { Host } from "./types.ts"

/** The current time as ISO 8601 text, the form the records store. */
export const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString()),
)

/** Reads stdin as raw text, failing with StdinMissing when it is a terminal or blank. */
export const readReport = (host: Host) =>
  host.stdin.pipe(
    Effect.filterOrFail(
      (text) => text.trim() !== "",
      () => new StdinMissing({ reason: "stdin was empty" }),
    ),
  )

const LITERAL_RUN = /(?:"[^"]*" \| ){4,}"[^"]*"/g

/** Shortens a run of quoted literal choices to its first three, so a bad enum value is one line. */
const compact = (message: string): string =>
  message.replace(LITERAL_RUN, (run) => {
    const choices = run.split(" | ")
    return `${choices.slice(0, 3).join(" | ")} | … (${choices.length} choices)`
  })

/**
 * The JSON text a command was given: the inline `--input` value when present, else stdin. With the
 * flag, stdin is never read: a pipe that stays open (an agent's shell tool) would block the command
 * forever, and an open pipe cannot be told from an empty one without reading it.
 */
const payloadOf = (host: Host, inline: string | undefined) =>
  Effect.gen(function* () {
    if (inline === undefined) return { source: "stdin", text: yield* readReport(host) }
    if (inline.trim() === "")
      return yield* new Usage({
        message: "--input is empty",
        hint: "Give the JSON as `--input '<json>'`, or on stdin without --input.",
      })
    return { source: "--input", text: inline }
  })

/**
 * Reads the payload as JSON (inline `--input` when given, else stdin) and decodes it with the
 * schema `pick` chooses from the parsed value, failing on a missing or excess property. Choosing by
 * value lets a command accept two shapes and report only the one that was meant.
 */
export const readInputBy = <S extends Schema.Decoder<unknown>>(
  host: Host,
  pick: (raw: unknown) => S,
  inline?: string,
) =>
  Effect.gen(function* () {
    const { source, text } = yield* payloadOf(host, inline)
    const invalid = (error: { readonly message: string }) =>
      new InvalidDraft({ message: compact(`${source}: ${error.message}`) })
    const raw = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
      Effect.mapError(invalid),
    )
    return yield* Schema.decodeUnknownEffect(pick(raw), { onExcessProperty: "error" })(raw).pipe(
      Effect.mapError(invalid),
    )
  })

/**
 * Reads the payload as JSON and decodes it with the schema, failing on a missing or excess
 * property.
 */
export const readInput = <S extends Schema.Decoder<unknown>>(
  host: Host,
  schema: S,
  inline?: string,
) => readInputBy(host, () => schema, inline)
