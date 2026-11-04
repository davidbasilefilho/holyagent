import { $ } from "bun"
import { Effect } from "effect"

import { definedEnv } from "../setup/environment.ts"

/** What a finished process left behind. */
export interface Spawned {
  readonly code: number
  readonly stdout: Uint8Array
  readonly stderr: string
}

/** The environment a process of this CLI runs in. */
export type Env = Readonly<Record<string, string | undefined>>

/**
 * Runs a program to the end in a directory without throwing on a non-zero exit. `stdin` is fed to
 * the program as given, which keeps large payloads out of the argument list.
 */
export const spawn = (
  program: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Env; readonly stdin?: string | undefined },
) =>
  Effect.promise(() => {
    const command =
      options.stdin === undefined
        ? $`${program} ${args}`
        : $`${program} ${args} < ${new Response(options.stdin)}`
    return command.cwd(options.cwd).env(definedEnv(options.env)).quiet().nothrow()
  }).pipe(
    Effect.map((output): Spawned => ({
      code: output.exitCode,
      stdout: output.stdout,
      stderr: output.stderr.toString(),
    })),
  )
