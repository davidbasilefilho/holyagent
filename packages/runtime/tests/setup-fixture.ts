import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Option } from "effect"

import { applyDefaults } from "../src/setup/json-file.ts"
import { userSettingsDefaults } from "../src/setup/settings.ts"
import { Shell, type ShellResult } from "../src/setup/shell.ts"

/** The file name a program has in a bin directory: Windows finds programs by extension. */
export const programName = (name: string): string =>
  process.platform === "win32" ? `${name}.exe` : name

/** Puts empty, executable `bili` and `ctx7` files in Bun's global bin directory of a home. */
export const installPrograms = async (home: string): Promise<string> => {
  const bin = join(home, ".bun", "bin")
  await mkdir(bin, { recursive: true })
  for (const name of ["bili", "ctx7"])
    await writeFile(join(bin, programName(name)), "", { mode: 0o755 })
  return bin
}

/** Writes the user settings of a Claude Code folder with every recommended key set. */
export const writeCompleteSettings = async (claudeDirectory: string): Promise<string> => {
  await mkdir(claudeDirectory, { recursive: true })
  const file = join(claudeDirectory, "settings.json")
  await writeFile(file, JSON.stringify(applyDefaults({}, userSettingsDefaults("1h")).merged))
  return file
}

/**
 * Makes a home directory look set up: `bili` and `ctx7` in Bun's global bin directory and the
 * recommended keys in the user settings. The SessionStart hook then adds no setup line.
 */
export const completeSetup = async (home: string): Promise<void> => {
  await installPrograms(home)
  await writeCompleteSettings(join(home, ".claude"))
}

/** A temporary directory, removed by the returned function. */
export const scratch = async (prefix: string) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  return { directory, remove: () => rm(directory, { recursive: true, force: true }) }
}

/** One command the fake shell was asked to run. */
export interface Ran {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly line: string
  /** The working directory the command was asked to run in. */
  readonly cwd: string
}

const packageCommands: Readonly<Record<string, string>> = {
  "billion-context": "bili",
  ctx7: "ctx7",
}

/**
 * A fake {@link Shell} that records every `run` and knows which commands are on PATH. A `bun add -g
 * <package>` makes the package's command available, like the real one. `respond` overrides the
 * result of a command line.
 */
export const fakeShell = (options: {
  readonly commands: ReadonlyArray<string>
  /** Commands found only in Bun's global bin directory, not on PATH. */
  readonly bunBinCommands?: ReadonlyArray<string>
  readonly respond?: (line: string) => Partial<ShellResult> | undefined
}) => {
  const available = new Set(options.commands)
  const inBunBin = new Set(options.bunBinCommands ?? [])
  const calls: Array<Ran> = []
  const layer = Layer.succeed(
    Shell,
    Shell.of({
      which: (command, whichOptions) =>
        Effect.succeed(
          available.has(command)
            ? Option.some(`/fake/bin/${command}`)
            : whichOptions?.includeBunBin && inBunBin.has(command)
              ? Option.some(`/fake/.bun/bin/${command}`)
              : Option.none(),
        ),
      run: (command, args, runOptions) =>
        Effect.sync(() => {
          const line = [command, ...args].join(" ")
          calls.push({ command, args, line, cwd: runOptions.cwd })
          const result = { exitCode: 0, stdout: "", stderr: "", ...options.respond?.(line) }
          const add = command === "bun" ? args.indexOf("add") : -1
          const global = add >= 0 && args[add + 1] === "-g" ? args[add + 2] : undefined
          const installed = global === undefined ? undefined : packageCommands[global]
          if (installed !== undefined && result.exitCode === 0) available.add(installed)
          return result
        }),
    }),
  )
  return { layer, calls, lines: () => calls.map((call) => call.line) }
}
