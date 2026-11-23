// The shared service and lookup policy live in Core; the CLI retains its Bun process host.
export * from "../../../core/src/setup/shell.ts"

import { $ } from "bun"
import { Effect, Layer } from "effect"

import { findCommand, pathWithBunBin, Shell } from "../../../core/src/setup/shell.ts"
import { definedEnv, type Env, homeDirectory } from "./environment.ts"

/** Supplies the CLI's Bun-backed process adapter to shared setup operations. */
export const shellLive = (env: Env) => {
  const bunBin = pathWithBunBin(
    { ...env },
    { home: homeDirectory(env), bunInstall: env.BUN_INSTALL },
  )
  return Layer.succeed(
    Shell,
    Shell.of({
      which: (command, options) => Effect.sync(() => findCommand(env, command, options, Bun.which)),
      run: (command, args, options) =>
        Effect.tryPromise({
          try: () =>
            $`${command} ${args}`
              .cwd(options.cwd)
              .env(definedEnv({ ...env, ...options.env, [bunBin.key]: bunBin.value }))
              .quiet()
              .nothrow()
              .then((result) => ({
                exitCode: result.exitCode,
                stdout: result.stdout.toString(),
                stderr: result.stderr.toString(),
              })),
          catch: (error) => String(error),
        }).pipe(
          Effect.catch((message) => Effect.succeed({ exitCode: 127, stdout: "", stderr: message })),
        ),
    }),
  )
}
