import { Effect } from "effect"

import type { FlagArgs } from "../cli/args.ts"
import { Usage } from "../cli/errors.ts"

/** The command line of a `vcs` command after the flags were read. */
export type VcsArgs = FlagArgs

/** The single value of a flag, or undefined. */
export const valueOf = (args: VcsArgs, name: string): string | undefined => args.values[name]?.[0]

/** The value of a flag the command cannot run without. */
export const requiredValue = (args: VcsArgs, name: string, usage: string) => {
  const value = valueOf(args, name)
  return value === undefined
    ? Effect.fail(
        new Usage({
          message: `Missing --${name}`,
          hint: `Usage: holyagent ${usage}`,
        }),
      )
    : Effect.succeed(value)
}
