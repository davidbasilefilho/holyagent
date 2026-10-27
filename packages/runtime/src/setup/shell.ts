import { delimiter, join } from "node:path"

import { $ } from "bun"
import { Context, Effect, Layer, Option } from "effect"

import { type Env, homeDirectory } from "./environment.ts"

/** The outcome of a finished command; a command that cannot start has exit code 127. */
export interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * The name the search path has in an environment. Windows keeps it as `Path` and matches names
 * without regard to case, so `insensitive` finds it however it is spelled (an exact `PATH` wins);
 * elsewhere names are exact. A missing variable is `PATH`.
 */
export const pathKey = (env: Env, insensitive: boolean = process.platform === "win32"): string => {
  if (!insensitive || env.PATH !== undefined) return "PATH"
  return Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
}

/**
 * The search path with Bun's global bin directory appended: the variable's name, so a Windows
 * `Path` is extended in place instead of gaining a second `PATH`, and its value. The directory is
 * `$BUN_INSTALL/bin`, else `bin` in `.bun` of the home directory, joined with the platform's
 * separator, and the entries are joined with its list delimiter (`;` on Windows).
 */
export const pathWithBunBin = (
  env: Env,
  options: {
    readonly home: string
    readonly bunInstall?: string | undefined
    readonly delimiter?: string
    readonly insensitive?: boolean
  },
): { readonly key: string; readonly value: string; readonly bunBin: string } => {
  const key = pathKey(env, options.insensitive)
  const root = options.bunInstall ? options.bunInstall : join(options.home, ".bun")
  const bunBin = join(root, "bin")
  return { key, value: `${env[key] ?? ""}${options.delimiter ?? delimiter}${bunBin}`, bunBin }
}

/**
 * Finds a command on the search path of an environment, plus Bun's global bin directory when
 * `includeBunBin` is set. A lookup only: nothing is spawned.
 */
export const findCommand = (
  env: Env,
  command: string,
  options?: { readonly includeBunBin?: boolean },
): Option.Option<string> => {
  const bunBin = pathWithBunBin(
    { ...env },
    { home: homeDirectory(env), bunInstall: env.BUN_INSTALL },
  )
  return Option.fromNullishOr(
    Bun.which(command, {
      PATH: options?.includeBunBin ? bunBin.value : (env[bunBin.key] ?? ""),
    }),
  )
}

/**
 * The external commands setup drives (`bun`, `bili`, `ctx7`). Commands see Bun's global bin
 * directory on PATH, because a `bun add -g` in the same run puts new commands there.
 */
export class Shell extends Context.Service<
  Shell,
  {
    /** Finds a command on PATH, plus Bun's global bin directory when `includeBunBin` is set. */
    readonly which: (
      command: string,
      options?: { readonly includeBunBin?: boolean },
    ) => Effect.Effect<Option.Option<string>>
    /** Runs a command to completion without a terminal; stdout and stderr are captured. */
    readonly run: (command: string, args: ReadonlyArray<string>) => Effect.Effect<ShellResult>
  }
>()("holyagent/Shell") {
  /** The real implementation, backed by the Bun Shell, for the environment of the process. */
  static readonly live = (env: Env) => {
    // A plain copy of the names and values, because Windows hands out `process.env` with
    // case-insensitive names that a spread flattens to the real one (`Path`).
    const bunBin = pathWithBunBin(
      { ...env },
      { home: homeDirectory(env), bunInstall: env.BUN_INSTALL },
    )
    return Layer.succeed(
      Shell,
      Shell.of({
        which: (command, options) => Effect.sync(() => findCommand(env, command, options)),
        run: (command, args) =>
          Effect.tryPromise({
            try: () =>
              $`${command} ${args}`
                .env(
                  Object.fromEntries(
                    Object.entries({ ...env, [bunBin.key]: bunBin.value }).filter(
                      (entry): entry is [string, string] => entry[1] !== undefined,
                    ),
                  ),
                )
                .quiet()
                .nothrow()
                .then((result) => ({
                  exitCode: result.exitCode,
                  stdout: result.stdout.toString(),
                  stderr: result.stderr.toString(),
                })),
            catch: (error) => String(error),
          }).pipe(
            Effect.catch((message) =>
              Effect.succeed({ exitCode: 127, stdout: "", stderr: message }),
            ),
          ),
      }),
    )
  }
}
