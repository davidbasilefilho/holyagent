import { Effect } from "effect"

import { definedEnv } from "../state/portable.ts"
import { spawn as spawnProcess } from "../state/process.ts"

/** Environment passed to the process adapter. */
export type Env = Readonly<Record<string, string | undefined>>

/** Runs an executable directly; interruption terminates its process group. */
export const spawn = (
  program: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Env; readonly stdin?: string | undefined },
) =>
  spawnProcess(program, args, { ...options, env: definedEnv(options.env) }).pipe(
    Effect.catchDefect((cause) =>
      Effect.succeed({ code: 127, stdout: new Uint8Array(), stderr: String(cause) }),
    ),
  )
