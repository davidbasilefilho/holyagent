import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"

/** How a flag takes its value: once, repeated, or not at all. */
export type FlagShape = { readonly kind: "one" | "many" | "switch"; readonly short?: string }

/** The command line of a `vcs` command after the flags were read. */
export interface VcsArgs {
  readonly positionals: ReadonlyArray<string>
  readonly values: Readonly<Record<string, ReadonlyArray<string>>>
  readonly switches: ReadonlySet<string>
}

/**
 * Reads `--name value`, `--name=value`, a short `-m value`, repeated flags and `--`, after which
 * every argument is a positional (a path may start with a dash).
 */
export const readArguments = (
  args: ReadonlyArray<string>,
  spec: Readonly<Record<string, FlagShape>>,
  usage: string,
) =>
  Effect.gen(function* () {
    const hint = `Usage: holyagent-runtime ${usage}`
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
        switches.add(name)
        continue
      }
      const value = equals === -1 ? args[++index] : arg.slice(equals + 1)
      if (value === undefined)
        return yield* new Usage({ message: `Flag ${flag} needs a value`, hint })
      if (shape.kind === "one" && values[name] !== undefined)
        return yield* new Usage({ message: `Flag ${flag} was given twice`, hint })
      ;(values[name] ??= []).push(value)
    }
    return { positionals, values, switches } satisfies VcsArgs
  })

/** The single value of a flag, or undefined. */
export const valueOf = (args: VcsArgs, name: string): string | undefined => args.values[name]?.[0]

/** The value of a flag the command cannot run without. */
export const requiredValue = (args: VcsArgs, name: string, usage: string) => {
  const value = valueOf(args, name)
  return value === undefined
    ? Effect.fail(
        new Usage({
          message: `Missing --${name}`,
          hint: `Usage: holyagent-runtime ${usage}`,
        }),
      )
    : Effect.succeed(value)
}
