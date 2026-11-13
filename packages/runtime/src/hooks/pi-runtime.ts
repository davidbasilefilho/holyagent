import { Effect } from "effect"

import { describeFailure } from "../cli/errors.ts"
import type { Result } from "../cli/program.ts"
import { loadConfig } from "../config/load.ts"
import type { Env } from "../setup/environment.ts"
import { StateIo } from "../state/errors.ts"
import { projectOf } from "./pi-project.ts"

/**
 * The first argument that makes {@link piEntry} print the loaded config instead of running a CLI
 * command: `config <state-folder>...`, where the folders are the project's `.holyagent` folders in
 * the order to try.
 */
export const PI_CONFIG_COMMAND = "config"

/** A failure as the CLI prints it: `error: <tag>: <message>` and `hint:` on stderr, its exit code. */
const failureResult = (error: unknown): Result => {
  const { tag, message, hint, code } = describeFailure(error)
  return { stdout: "", stderr: `error: ${tag}: ${message}\nhint: ${hint}\n`, code }
}

/** Makes `directory` the working directory, or fails as a state error that names it. */
export const enterProject = (directory: string): Effect.Effect<void, StateIo> =>
  Effect.try({
    try: () => process.chdir(directory),
    catch: (cause) => new StateIo({ path: directory, cause }),
  })

/**
 * Loads the HolyAgent config through the runtime loader and prints it as one line of JSON, every
 * default filled in. A bad config file fails as the CLI fails: `error: ConfigInvalid: <message>`,
 * where the message names the file and the field, and `hint:` on stderr, with the CLI's exit code.
 * The loader reads files with Bun, so the Pi extension, which runs under Node, calls this through
 * the package's `scripts/holyagent` wrapper.
 */
export const configResult = (folders: ReadonlyArray<string>, env: Env): Effect.Effect<Result> =>
  loadConfig({ projectDirectories: folders, env }).pipe(
    Effect.map((config): Result => ({
      stdout: `${JSON.stringify(config)}\n`,
      stderr: "",
      code: 0,
    })),
    Effect.catch((error) => Effect.succeed(failureResult(error))),
  )

// The Pi package's `scripts/holyagent.js` is this file bundled: `--project` and `config` are answered
// here and every other command line is the CLI, unchanged, so the wrapper serves both. Importing the
// module (the tests do) runs nothing.
/** Runs the Pi CLI, optionally enabling the public interactive setup screen. */
export const piEntry = (interactiveSetup = false): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { directory, rest } = projectOf(Bun.argv.slice(2))
      const entered =
        directory === undefined
          ? undefined
          : yield* enterProject(directory).pipe(
              Effect.as(undefined),
              Effect.catch((error) => Effect.succeed(failureResult(error))),
            )
      if (entered !== undefined) {
        process.stderr.write(entered.stderr)
        process.exitCode = entered.code
      } else if (rest[0] === PI_CONFIG_COMMAND) {
        const result = yield* configResult(rest.slice(1), process.env)
        process.stdout.write(result.stdout)
        process.stderr.write(result.stderr)
        process.exitCode = result.code
      } else {
        // Enter the project and remove its flag before the CLI reads the process arguments.
        Bun.argv.splice(2, Bun.argv.length - 2, ...rest)
        const { main } = yield* Effect.promise(() => import("../cli/entry.ts"))
        yield* Effect.promise(() => main(interactiveSetup))
      }
    }),
  )
