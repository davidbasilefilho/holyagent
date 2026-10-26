import { Effect, Schema } from "effect"

import { Usage } from "./errors.ts"

/** The flag that passes a command's JSON payload inline instead of on stdin. */
export const INPUT_FLAG = "input"

/** The kind of value a flag takes. */
export type FlagKind = "string" | "boolean"

/** Flags a command accepts, by name without the leading dashes. */
export type FlagSpec = Readonly<Record<string, FlagKind>>

/** Positional arguments and flag values of one command line. */
export interface Parsed {
  readonly positionals: ReadonlyArray<string>
  readonly flags: Readonly<Record<string, string | boolean>>
}

/** Splits arguments into positionals and flags, accepting `--name value` and `--name=value`. */
export const parseArgs = (args: ReadonlyArray<string>, spec: FlagSpec, usage: string) =>
  Effect.gen(function* () {
    const hint = `Usage: holyagent ${usage}`
    const positionals: Array<string> = []
    const flags: Record<string, string | boolean> = {}
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? ""
      if (!arg.startsWith("--")) {
        positionals.push(arg)
        continue
      }
      const equals = arg.indexOf("=")
      const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals)
      const kind = Object.hasOwn(spec, name) ? spec[name] : undefined
      if (kind === undefined) return yield* new Usage({ message: `Unknown flag --${name}`, hint })
      if (kind === "boolean") {
        if (equals !== -1)
          return yield* new Usage({ message: `Flag --${name} takes no value`, hint })
        flags[name] = true
        continue
      }
      // A value that starts like a flag is a forgotten value; `--name=--text` passes one on purpose.
      const next = args[index + 1]
      const value =
        equals === -1 ? (next?.startsWith("--") ? undefined : next) : arg.slice(equals + 1)
      if (equals === -1 && value !== undefined) index += 1
      if (value === undefined)
        return yield* new Usage({ message: `Flag --${name} needs a value`, hint })
      flags[name] = value
    }
    return { positionals, flags } satisfies Parsed
  })

/** The value of a string flag, or undefined when it was not given. */
export const stringFlag = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags[name]
  return typeof value === "string" ? value : undefined
}

/** True when a boolean flag was given. */
export const booleanFlag = (parsed: Parsed, name: string): boolean => parsed.flags[name] === true

/** The value of a string flag the command cannot run without. */
export const requiredFlag = (parsed: Parsed, name: string, usage: string) => {
  const value = stringFlag(parsed, name)
  return value === undefined
    ? Effect.fail(new Usage({ message: `Missing --${name}`, hint: `Usage: holyagent ${usage}` }))
    : Effect.succeed(value)
}

/** Decodes a flag value that must be one of a closed set, such as an outcome or a state. */
export const choiceFlag = <S extends Schema.Decoder<unknown>>(
  schema: S,
  name: string,
  value: unknown,
  usage: string,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      () =>
        new Usage({
          message: `Invalid value for --${name}: ${String(value)}`,
          hint: `Usage: holyagent ${usage}`,
        }),
    ),
  )
