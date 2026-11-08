#!/usr/bin/env bun
import { Effect } from "effect"

import { describeFailure } from "../cli/errors.ts"
import type { Result } from "../cli/program.ts"
import { loadConfig } from "../config/load.ts"
import type { Env } from "../setup/environment.ts"

/**
 * The first argument that makes {@link piEntry} print the loaded config instead of running a CLI
 * command: `config <state-folder>...`, where the folders are the project's `.holyagent` folders in
 * the order to try.
 */
export const PI_CONFIG_COMMAND = "config"

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
    Effect.catch((error) => {
      const { tag, message, hint, code } = describeFailure(error)
      return Effect.succeed<Result>({
        stdout: "",
        stderr: `error: ${tag}: ${message}\nhint: ${hint}\n`,
        code,
      })
    }),
  )

// The Pi package's `scripts/holyagent.js` is this file bundled: `config` is answered here and every
// other command line is the CLI, unchanged, so the wrapper serves both. Importing the module (the
// tests do) runs nothing.
if (import.meta.main) {
  const [command, ...folders] = Bun.argv.slice(2)
  if (command === PI_CONFIG_COMMAND) {
    const result = await Effect.runPromise(configResult(folders, process.env))
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exitCode = result.code
  } else await import("../cli/main.ts")
}
