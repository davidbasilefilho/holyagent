import { homedir } from "node:os"
import { delimiter, join } from "node:path"

import { $ } from "bun"
import { Config, Context, Effect, Layer, Option } from "effect"

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
export const pathKey = (
  env: Readonly<Record<string, string | undefined>>,
  insensitive: boolean = process.platform === "win32",
): string => {
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
  env: Readonly<Record<string, string | undefined>>,
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

/** Options for {@link Shell}'s `run`. */
export interface RunOptions {
  /** Environment variables to remove for this command only. */
  readonly unsetEnv?: ReadonlyArray<string>
  /** The working directory for this command; the current one when unset. */
  readonly cwd?: string
}

/**
 * The external commands the CLI drives (`claude`, `bun`, `ctx7`). Commands see Bun's global bin
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
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      options?: RunOptions,
    ) => Effect.Effect<ShellResult>
  }
>()("holyagent/Shell") {
  /** The real implementation, backed by the Bun Shell. */
  static readonly layer = Layer.effect(
    Shell,
    Effect.gen(function* () {
      // HOME, else USERPROFILE (Windows), else what the operating system says.
      const home = yield* Config.option(Config.String("HOME"))
      const profile = yield* Config.option(Config.String("USERPROFILE"))
      const bunInstall = yield* Config.option(Config.String("BUN_INSTALL"))
      // A plain copy, because Windows hands out `process.env` with case-insensitive names that a
      // spread flattens to the real one (`Path`).
      const bunBin = pathWithBunBin(
        { ...process.env },
        {
          home: [home, profile].map(Option.getOrUndefined).find(Boolean) ?? homedir(),
          bunInstall: Option.getOrUndefined(bunInstall),
        },
      )

      return Shell.of({
        which: (command, options) =>
          Effect.sync(() =>
            Option.fromNullishOr(
              Bun.which(command, {
                PATH: options?.includeBunBin ? bunBin.value : (process.env[bunBin.key] ?? ""),
              }),
            ),
          ),
        run: (command, args, options) =>
          Effect.tryPromise({
            try: () => {
              const env: Record<string, string | undefined> = {
                ...process.env,
                [bunBin.key]: bunBin.value,
              }
              for (const name of options?.unsetEnv ?? []) env[name] = undefined
              const pending = $`${command} ${args}`.env(env)
              return (options?.cwd === undefined ? pending : pending.cwd(options.cwd))
                .quiet()
                .nothrow()
                .then((result) => ({
                  exitCode: result.exitCode,
                  stdout: result.stdout.toString(),
                  stderr: result.stderr.toString(),
                }))
            },
            catch: (error) => String(error),
          }).pipe(
            Effect.catch((message) =>
              Effect.succeed({ exitCode: 127, stdout: "", stderr: message }),
            ),
          ),
      })
    }),
  )
}
