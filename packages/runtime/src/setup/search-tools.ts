import { Effect, Option } from "effect"

import { hint, pass, present } from "./report.ts"
import { Shell } from "./shell.ts"

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

/** How to install both programs, by platform. */
export const INSTALL_COMMANDS: ReadonlyArray<readonly [platform: string, command: string]> = [
  ["macOS", "brew install ripgrep fd"],
  ["Debian/Ubuntu", "sudo apt install ripgrep fd-find"],
  ["Fedora", "sudo dnf install ripgrep fd-find"],
  ["Arch", "sudo pacman -S ripgrep fd"],
  ["Windows", "winget install BurntSushi.ripgrep.MSVC sharkdp.fd"],
]

/** The install commands as one sentence part, for a message or a report line. */
export const installAdvice: string = `install ripgrep and fd with your package manager (${INSTALL_COMMANDS.map(
  ([platform, command]) => `${platform}: \`${command}\``,
).join("; ")})`

/**
 * What stops working while a program is missing, for the lines that report it: the `holyagent`
 * search command of the root and the specialists.
 */
const stopsWithout = (tool: Tool): string => `\`holyagent ${tool}\` (the agents' search) fails`

/**
 * Finds a search program with `which`, trying the executables of {@link SEARCH_TOOLS} in order.
 * Returns the path of the first one found.
 */
export const locateTool = <E, R>(
  tool: Tool,
  which: (command: string) => Effect.Effect<Option.Option<string>, E, R>,
) =>
  Effect.gen(function* () {
    for (const command of SEARCH_TOOLS[tool].commands) {
      const found = yield* which(command)
      if (Option.isSome(found)) return found
    }
    return Option.none<string>()
  })

/**
 * Doctor's line on each search program: `ok` with the path when found, else a `~` warning that
 * names what stops working and how to install it. A missing program is no failure, since only the
 * search commands depend on it.
 */
export const checkSearchTools = Effect.gen(function* () {
  const shell = yield* Shell
  return yield* Effect.forEach(TOOLS, (tool) =>
    locateTool(tool, shell.which).pipe(
      Effect.map((found) =>
        Option.isSome(found)
          ? pass(tool, found.value)
          : hint(
              `${tool}: ${SEARCH_TOOLS[tool].commands.join(" or ")} not found on PATH, so ${stopsWithout(tool)}; ${installAdvice}`,
            ),
      ),
    ),
  )
})

/**
 * Setup's lines on the search programs: `=` when found, else a `~` hint with the install commands.
 * Setup installs nothing here, since the programs belong to the system's package manager.
 */
export const reportSearchTools = Effect.gen(function* () {
  const shell = yield* Shell
  return yield* Effect.forEach(TOOLS, (tool) =>
    locateTool(tool, shell.which).pipe(
      Effect.map((found) =>
        Option.isSome(found)
          ? present(`${tool}: found at ${found.value}`)
          : hint(`${tool}: not installed, so ${stopsWithout(tool)}; ${installAdvice}`),
      ),
    ),
  )
})
