import { Effect, Option } from "effect"

import { hint, pass, present } from "./report.ts"
import { Shell, type WhichOptions } from "./shell.ts"

/** The search programs behind `holyagent rg` and `holyagent fd`; the user installs both. */
export const TOOLS = ["rg", "fd"] as const

/** One of the search programs: ripgrep (`rg`) or fd (`fd`). */
export type Tool = (typeof TOOLS)[number]

/** What a search program is called and which executables can be it. */
export interface SearchTool {
  /** The program's name in words. */
  readonly title: string
  /** The executables to try in order, the first on PATH wins. */
  readonly commands: ReadonlyArray<string>
}

/** The search programs by the command that runs each. fd is `fdfind` on Debian and Ubuntu. */
export const SEARCH_TOOLS: Readonly<Record<Tool, SearchTool>> = {
  rg: { title: "ripgrep", commands: ["rg"] },
  fd: { title: "fd", commands: ["fd", "fdfind"] },
}

/** How to install both programs, by platform: the platform and the commands to run, in order. */
export const INSTALL_COMMANDS: ReadonlyArray<readonly [platform: string, ...commands: string[]]> = [
  ["macOS", "brew install ripgrep fd"],
  ["Debian/Ubuntu", "sudo apt install ripgrep fd-find"],
  ["Fedora", "sudo dnf install ripgrep fd-find"],
  ["Arch", "sudo pacman -S ripgrep fd"],
  ["Windows", "winget install BurntSushi.ripgrep.MSVC", "winget install sharkdp.fd"],
]

/**
 * The install commands as one sentence part, for a message or a report line. A Windows terminal
 * reads PATH when it starts, so the advice ends with opening a new one.
 */
export const installAdvice: string = `install ripgrep and fd with your package manager (${INSTALL_COMMANDS.map(
  ([platform, ...commands]) =>
    `${platform}: ${commands.map((command) => `\`${command}\``).join(" and ")}`,
).join("; ")}), then open a new terminal so PATH picks them up`

/**
 * What stops working while a program is missing, for the lines that report it: the `holyagent`
 * search command of the root and the specialists.
 */
const stopsWithout = (tool: Tool): string => `\`holyagent ${tool}\` (the agents' search) fails`

/**
 * Finds a search program with `which`, trying the executables of {@link SEARCH_TOOLS} in order.
 * Returns the path of the first one found. Every caller (the search commands, doctor and setup)
 * asks through here, with the strict lookup of the call's working directory: the programs run with
 * arguments the model controls, so PATH is trusted only as far as {@link StrictLookup} allows.
 */
export const locateTool = <E, R>(
  tool: Tool,
  cwd: string,
  which: (command: string, options: WhichOptions) => Effect.Effect<Option.Option<string>, E, R>,
) =>
  Effect.gen(function* () {
    for (const command of SEARCH_TOOLS[tool].commands) {
      const found = yield* which(command, { strict: { cwd } })
      if (Option.isSome(found)) return found
    }
    return Option.none<string>()
  })

/** One report line for a search program: where it was found, or none. */
export type SearchToolLine = (tool: Tool, found: Option.Option<string>) => string

/** Doctor's line: `ok` with the path, else a `~` warning naming what stops and how to install. */
export const doctorToolLine: SearchToolLine = (tool, found) =>
  Option.isSome(found)
    ? pass(tool, found.value)
    : hint(
        `${tool}: ${SEARCH_TOOLS[tool].commands.join(" or ")} not found on PATH, so ${stopsWithout(tool)}; ${installAdvice}`,
      )

/** Setup's line: `=` when found, else a `~` hint with the install commands. */
export const setupToolLine: SearchToolLine = (tool, found) =>
  Option.isSome(found)
    ? present(`${tool}: found at ${found.value}`)
    : hint(`${tool}: not installed, so ${stopsWithout(tool)}; ${installAdvice}`)

/**
 * One report line on each search program, formatted by `format` ({@link doctorToolLine} or
 * {@link setupToolLine}), looked up for a call in `cwd`. A missing program is no failure, since only
 * the search commands depend on it, and nothing is installed here: the programs belong to the
 * system's package manager.
 */
export const searchToolLines = (cwd: string, format: SearchToolLine) =>
  Effect.gen(function* () {
    const shell = yield* Shell
    return yield* Effect.forEach(TOOLS, (tool) =>
      locateTool(tool, cwd, shell.which).pipe(Effect.map((found) => format(tool, found))),
    )
  })
