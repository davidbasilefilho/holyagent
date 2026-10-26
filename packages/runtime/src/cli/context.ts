import { $ } from "bun"
import { Clock, Effect, Schema } from "effect"

import { InvalidDraft } from "../domain/errors.ts"
import { StateIo } from "../state/errors.ts"
import { StdinMissing, Usage } from "./errors.ts"
import type { Host } from "./types.ts"

/** The current time as ISO 8601 text, the form the records store. */
export const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => new Date(millis).toISOString()),
)

const NOT_A_REPOSITORY = /not a git repository|command not found/i

/**
 * The state root: the git top-level of the directory, else the directory itself when it is not in a
 * repository (or git is not installed). Any other git failure is reported, so state is not silently
 * written somewhere else.
 */
export const stateRoot = (cwd: string) =>
  Effect.tryPromise({
    try: () => $`git rev-parse --show-toplevel`.cwd(cwd).quiet().nothrow(),
    catch: (cause) => new StateIo({ path: cwd, cause }),
  }).pipe(
    Effect.flatMap((output) => {
      const top = output.text().trim()
      if (output.exitCode === 0 && top !== "") return Effect.succeed(top)
      const complaint = output.stderr.toString().trim()
      return NOT_A_REPOSITORY.test(complaint)
        ? Effect.succeed(cwd)
        : Effect.fail(new StateIo({ path: cwd, cause: `git: ${complaint}` }))
    }),
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
 * The JSON text a command was given: the inline `--input` value when present, else stdin. An inline
 * value must not be blank, and stdin must then be empty, so one command never has two payloads.
 */
const payloadOf = (host: Host, inline: string | undefined) =>
  Effect.gen(function* () {
    if (inline === undefined) return { source: "stdin", text: yield* readReport(host) }
    const hint = "Give the JSON once: `--input '<json>'`, or on stdin without --input."
    if (inline.trim() === "") return yield* new Usage({ message: "--input is empty", hint })
    const piped = yield* host.stdin.pipe(Effect.orElseSucceed(() => ""))
    if (piped.trim() !== "")
      return yield* new Usage({ message: "Got JSON on both stdin and --input", hint })
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
