import { $ } from "bun"
import { Clock, Effect, Schema } from "effect"

import { InvalidDraft } from "../domain/errors.ts"
import { StateIo } from "../state/errors.ts"
import { StdinMissing } from "./errors.ts"
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
 * Reads stdin as JSON and decodes it with the schema `pick` chooses from the parsed value, failing
 * on a missing or excess property. Choosing by value lets a command accept two shapes and report
 * only the one that was meant.
 */
export const readInputBy = <S extends Schema.Decoder<unknown>>(
  host: Host,
  pick: (raw: unknown) => S,
) =>
  Effect.gen(function* () {
    const invalid = (error: { readonly message: string }) =>
      new InvalidDraft({ message: compact(`stdin: ${error.message}`) })
    const raw = yield* readReport(host).pipe(
      Effect.flatMap((text) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text),
      ),
      Effect.mapError((error) => (error._tag === "StdinMissing" ? error : invalid(error))),
    )
    return yield* Schema.decodeUnknownEffect(pick(raw), { onExcessProperty: "error" })(raw).pipe(
      Effect.mapError(invalid),
    )
  })

/** Reads stdin as JSON and decodes it with the schema, failing on a missing or excess property. */
export const readInput = <S extends Schema.Decoder<unknown>>(host: Host, schema: S) =>
  readInputBy(host, () => schema)
