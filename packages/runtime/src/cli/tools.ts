import { join } from "node:path"

import { $ } from "bun"
import { Data, Effect } from "effect"

import { type Command, Verbatim } from "./types.ts"

/** The search programs the plugin bundles, by the command that runs each. */
export const TOOLS = ["rg", "fd"] as const

/** One of the bundled search programs: ripgrep (`rg`) or fd (`fd`). */
export type Tool = (typeof TOOLS)[number]

/** A platform the plugin bundles the tools for. */
export interface Target {
  /** The folder name below the vendor folder, `<os>-<arch>`. */
  readonly id: string
  /** The `process.platform` value of the operating system. */
  readonly platform: string
  /** The `process.arch` value of the processor. */
  readonly arch: string
  /** The extension of an executable file on this platform. */
  readonly suffix: "" | ".exe"
}

/** Every platform the tools are bundled for. */
export const TARGETS: ReadonlyArray<Target> = [
  { id: "darwin-arm64", platform: "darwin", arch: "arm64", suffix: "" },
  { id: "linux-x64", platform: "linux", arch: "x64", suffix: "" },
  { id: "windows-x64", platform: "win32", arch: "x64", suffix: ".exe" },
]

/**
 * The folder of the bundled tools: `vendor/` beside the CLI script, since the plugin build puts the
 * bundle and the vendor folder in the same `scripts/` folder.
 */
export const BUNDLED_TOOLS: string = join(import.meta.dir, "vendor")

/** No bundled tool exists for the platform the CLI runs on. */
export class UnsupportedPlatform extends Data.TaggedError("UnsupportedPlatform")<{
  readonly platform: string
  readonly arch: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `No bundled search tools exist for ${this.platform} ${this.arch}; they exist for ${TARGETS.map((target) => target.id).join(", ")}`
  }
}

/** The bundled program is not in the vendor folder. */
export class ToolMissing extends Data.TaggedError("ToolMissing")<{
  readonly tool: Tool
  readonly path: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `The bundled ${this.tool} is missing: ${this.path} does not exist`
  }
}

/** The target for a platform and processor, or UnsupportedPlatform. */
export const selectTarget = (platform: string, arch: string) => {
  const target = TARGETS.find(
    (candidate) => candidate.platform === platform && candidate.arch === arch,
  )
  return target === undefined
    ? Effect.fail(new UnsupportedPlatform({ platform, arch }))
    : Effect.succeed(target)
}

/** The path of a bundled program: `<directory>/<target id>/<tool>` plus the target's suffix. */
export const toolPath = (directory: string, tool: Tool, target: Target): string =>
  join(directory, target.id, `${tool}${target.suffix}`)

/**
 * Runs a bundled program in a directory with the stdio of this process and returns its exit code.
 * The arguments reach the program unchanged. Fails with ToolMissing when the program is not there.
 */
export const runTool = (options: {
  readonly tool: Tool
  readonly directory: string
  readonly target: Target
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}) =>
  Effect.gen(function* () {
    const path = toolPath(options.directory, options.tool, options.target)
    if (!(yield* Effect.promise(() => Bun.file(path).exists())))
      return yield* new ToolMissing({ tool: options.tool, path })
    const env = Object.fromEntries(
      Object.entries(options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    )
    const output = yield* Effect.promise(() =>
      $`${path} ${options.args}`.cwd(options.cwd).env(env).nothrow(),
    )
    return output.exitCode
  })

const toolCommand = (tool: Tool, summary: string): Command => ({
  path: [tool],
  usage: `${tool} <${tool === "rg" ? "ripgrep" : "fd"} arguments…>`,
  summary,
  notes: [
    `the arguments, stdin, stdout, stderr and exit code are the program's own, so \`holyagent ${tool} --help\` prints its help and its exit codes keep their meaning`,
    "a failure of holyagent itself (ToolMissing, UnsupportedPlatform) exits 4 with an `error:` line on stderr",
  ],
  flags: {},
  stateless: true,
  raw: true,
  passthrough: true,
  positionals: 0,
  run: (call) =>
    Effect.gen(function* () {
      const target = yield* selectTarget(process.platform, process.arch)
      const code = yield* runTool({
        tool,
        directory: call.tools,
        target,
        args: call.args.positionals,
        cwd: call.cwd,
        env: call.env,
      })
      return new Verbatim("", "", code)
    }),
})

/**
 * The `rg` and `fd` commands: the search programs bundled with the plugin, so that every agent
 * searches with the same versions on every machine.
 */
export const TOOL_COMMANDS: ReadonlyArray<Command> = [
  toolCommand(
    "rg",
    "Search file contents with the ripgrep bundled with the plugin; runs it for this platform with your arguments",
  ),
  toolCommand(
    "fd",
    "Find files and folders by name with the fd bundled with the plugin; runs it for this platform with your arguments",
  ),
]
