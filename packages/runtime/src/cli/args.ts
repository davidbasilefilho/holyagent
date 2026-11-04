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

/** How a flag takes its value: once, repeated, or not at all (a switch). */
export interface FlagShape {
  readonly kind: "one" | "many" | "switch"
  /** The one-letter form, written `-m`. */
  readonly short?: string
}

/** The command line after its flags were read; values are in the order given. */
export interface FlagArgs {
  readonly positionals: ReadonlyArray<string>
  readonly values: Readonly<Record<string, ReadonlyArray<string>>>
  readonly switches: ReadonlySet<string>
}

/**
 * Reads `--name value`, `--name=value`, a declared short `-m value`, repeated flags and `--`, after
 * which every argument is a positional (a path may start with a dash). A value that starts like a
 * flag is a forgotten value; `--name=--text` passes one on purpose. An unknown flag, a switch given
 * a value, a flag without its value and a single-value flag given twice are refused with the
 * usage.
 */
export const readFlags = (
  args: ReadonlyArray<string>,
  spec: Readonly<Record<string, FlagShape>>,
  usage: string,
) =>
  Effect.gen(function* () {
    const hint = `Usage: holyagent ${usage}`
    const positionals: Array<string> = []
    const values: Record<string, Array<string>> = {}
    const switches = new Set<string>()
    const lookup = (flag: string) =>
      Object.entries(spec).find(([name, shape]) =>
        flag.startsWith("--") ? flag.slice(2) === name : flag === `-${shape.short}`,
      )
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? ""
      if (arg === "--") {
        positionals.push(...args.slice(index + 1))
        break
      }
      if (!arg.startsWith("-") || arg === "-") {
        positionals.push(arg)
        continue
      }
      const equals = arg.startsWith("--") ? arg.indexOf("=") : -1
      const flag = equals === -1 ? arg : arg.slice(0, equals)
      const found = lookup(flag)
      if (found === undefined) return yield* new Usage({ message: `Unknown flag ${flag}`, hint })
      const [name, shape] = found
      if (shape.kind === "switch") {
        if (equals !== -1) return yield* new Usage({ message: `Flag ${flag} takes no value`, hint })
        switches.add(name)
        continue
      }
      const next = args[index + 1]
      const value =
        equals === -1 ? (next?.startsWith("--") ? undefined : next) : arg.slice(equals + 1)
      if (equals === -1 && value !== undefined) index += 1
      if (value === undefined)
        return yield* new Usage({ message: `Flag ${flag} needs a value`, hint })
      if (shape.kind === "one" && values[name] !== undefined)
        return yield* new Usage({ message: `Flag ${flag} was given twice`, hint })
      ;(values[name] ??= []).push(value)
    }
    return { positionals, values, switches } satisfies FlagArgs
  })

/** Splits arguments into positionals and flags, accepting `--name value` and `--name=value`. */
export const parseArgs = (args: ReadonlyArray<string>, spec: FlagSpec, usage: string) =>
  readFlags(
    args,
    Object.fromEntries(
      Object.entries(spec).map(([name, kind]): [string, FlagShape] => [
        name,
        { kind: kind === "boolean" ? "switch" : "one" },
      ]),
    ),
    usage,
  ).pipe(
    Effect.map(({ positionals, values, switches }): Parsed => ({
      positionals,
      flags: {
        ...Object.fromEntries(Object.entries(values).map(([name, list]) => [name, list[0] ?? ""])),
        ...Object.fromEntries([...switches].map((name) => [name, true])),
      },
    })),
  )

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
