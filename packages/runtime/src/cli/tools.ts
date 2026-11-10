import { $ } from "bun"
import { Data, Effect, Option } from "effect"

import { definedEnv } from "../setup/environment.ts"
import { installAdvice, locateTool, SEARCH_TOOLS, type Tool } from "../setup/search-tools.ts"
import { findCommand } from "../setup/shell.ts"
import { type Command, Verbatim } from "./types.ts"

/** A search program is not installed: none of its executables is on PATH. */
export class ToolMissing extends Data.TaggedError("ToolMissing")<{
  readonly tool: Tool
}> {
  /** The description shown to the user, with the install commands per platform. */
  override get message() {
    const { title, commands } = SEARCH_TOOLS[this.tool]
    return `${title} (${commands.join(" or ")}) is not on PATH; ${installAdvice}`
  }
}

/**
 * Runs a search program found on PATH in a directory with the stdio of this process and returns its
 * exit code. The arguments reach the program unchanged. Fails with ToolMissing when none of the
 * program's executables is on the PATH of `env`.
 */
const runTool = (options: {
  readonly tool: Tool
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}) =>
  Effect.gen(function* () {
    const found = yield* locateTool(options.tool, options.cwd, (command, whichOptions) =>
      Effect.sync(() => findCommand(options.env, command, whichOptions)),
    )
    if (Option.isNone(found)) return yield* new ToolMissing({ tool: options.tool })
    const path = found.value
    const output = yield* Effect.promise(() =>
      $`${path} ${options.args}`.cwd(options.cwd).env(definedEnv(options.env)).nothrow(),
    )
    return output.exitCode
  })

const toolCommand = (tool: Tool, summary: string): Command => ({
  path: [tool],
  usage: `${tool} <${SEARCH_TOOLS[tool].title} arguments…>`,
  summary,
  notes: [
    `the arguments, stdin, stdout, stderr and exit code are the program's own, so \`holyagent ${tool} --help\` prints its help and its exit codes keep their meaning`,
    "the program is the one on PATH (fd also as fdfind, its name on Debian and Ubuntu); when it is not installed, holyagent itself fails with ToolMissing, exits 4 and prints an `error:` line on stderr with the install commands",
  ],
  flags: {},
  stateless: true,
  raw: true,
  passthrough: true,
  positionals: 0,
  run: (call) =>
    runTool({ tool, args: call.args.positionals, cwd: call.cwd, env: call.env }).pipe(
      Effect.map((code) => new Verbatim("", "", code)),
    ),
})

/**
 * The `rg` and `fd` commands: the search programs installed on the machine, behind one interface so
 * that every agent searches the same way.
 */
export const TOOL_COMMANDS: ReadonlyArray<Command> = [
  toolCommand(
    "rg",
    "Search file contents with the ripgrep installed on this machine; runs it with your arguments",
  ),
  toolCommand(
    "fd",
    "Find files and folders by name with the fd installed on this machine (fdfind on Debian and Ubuntu); runs it with your arguments",
  ),
]
