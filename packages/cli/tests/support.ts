import { BunServices } from "@effect/platform-bun"
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Layer,
  Option,
  type Path,
  Schema,
  type Scope,
} from "effect"

import { Shell, type ShellResult } from "../src/shell.ts"

const JsonObjectText = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/** Parses a JSON object, failing the test on anything else. */
export const parseJson = Schema.decodeUnknownSync(JsonObjectText)

/** Runs a test effect with the real file system and a scope that removes temporary directories. */
export const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)))

/** Creates a temporary directory that is removed when the test's scope closes. */
export const tempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "holyagent-test-" })
})

/** An environment for commands that read it through `Config`, without touching the real one. */
export const envLayer = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }))

/** One call the fake shell received. */
export interface Call {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly unsetEnv: ReadonlyArray<string>
  readonly line: string
}

const packageCommands: Record<string, string> = { ctx7: "ctx7" }

/**
 * A fake {@link Shell} that records every `run` and knows which commands are on PATH. A `bun add -g
 * <package>` makes the package's command available, like the real one.
 */
export const fakeShell = (options: {
  readonly commands: ReadonlyArray<string>
  /** Overrides the result of a command line (for example `claude plugin list --json`). */
  readonly respond?: (line: string, calls: ReadonlyArray<Call>) => Partial<ShellResult> | undefined
}) => {
  const available = new Set(options.commands)
  const calls: Array<Call> = []
  const layer = Layer.succeed(
    Shell,
    Shell.of({
      which: (command) =>
        Effect.succeed(
          available.has(command) ? Option.some(`/fake/bin/${command}`) : Option.none(),
        ),
      run: (command, args, runOptions) =>
        Effect.sync(() => {
          const line = [command, ...args].join(" ")
          calls.push({ command, args, unsetEnv: runOptions?.unsetEnv ?? [], line })
          const global =
            command === "bun" && args[0] === "add" && args[1] === "-g" ? args[2] : undefined
          const installed = global === undefined ? undefined : packageCommands[global]
          if (installed !== undefined) available.add(installed)
          return { exitCode: 0, stdout: "", stderr: "", ...options.respond?.(line, calls) }
        }),
    }),
  )
  return { layer, calls, lines: () => calls.map((call) => call.line) }
}
