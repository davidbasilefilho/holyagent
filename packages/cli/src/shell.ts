import { $ } from "bun"
import { Config, Context, Effect, Layer, Option } from "effect"

/** The outcome of a finished command; a command that cannot start has exit code 127. */
export interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Options for {@link Shell}'s `run`. */
export interface RunOptions {
  /** Environment variables to remove for this command only. */
  readonly unsetEnv?: ReadonlyArray<string>
}

/**
 * The external commands the CLI drives (`claude`, `bun`, `bili`, `ctx7`). Commands see Bun's global
 * bin directory on PATH, because a `bun add -g` in the same run puts new commands there.
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
      const home = yield* Config.option(Config.String("HOME"))
      const bunInstall = yield* Config.option(Config.String("BUN_INSTALL"))
      const bunBin = `${Option.getOrElse(bunInstall, () => `${Option.getOrElse(home, () => "")}/.bun`)}/bin`
      const withBunBin = `${process.env.PATH ?? ""}:${bunBin}`

      return Shell.of({
        which: (command, options) =>
          Effect.sync(() =>
            Option.fromNullishOr(
              Bun.which(command, {
                PATH: options?.includeBunBin ? withBunBin : (process.env.PATH ?? ""),
              }),
            ),
          ),
        run: (command, args, options) =>
          Effect.tryPromise({
            try: () => {
              const env: Record<string, string | undefined> = { ...process.env, PATH: withBunBin }
              for (const name of options?.unsetEnv ?? []) env[name] = undefined
              return $`${command} ${args}`
                .env(env)
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
