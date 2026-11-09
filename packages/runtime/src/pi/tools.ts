import type { Config, RouteKey } from "../config/schema.ts"
import { type Capability, routeFor } from "../domain/route.ts"
import { type ProviderProfile, providerProfile, webChoice } from "./provider.ts"

/** Pi's built-in tools that read: they replace `Read`, `Grep` and `Glob` for every role. */
export const READ_TOOLS: ReadonlyArray<string> = ["read", "grep", "find", "ls"]

/**
 * Pi's built-in tools that write and run: the Write capability's `Write`, `Edit` and `Bash`, and
 * `powershell`, which Pi offers beside `bash` on Windows (it fails on other systems, where a role
 * has `bash`).
 */
export const WRITE_TOOLS: ReadonlyArray<string> = ["write", "edit", "bash", "powershell"]

/**
 * The tools a role needs to run commands but not to change files: the Shell capability, `bash` and
 * Windows' `powershell`.
 */
export const SHELL_TOOLS: ReadonlyArray<string> = ["bash", "powershell"]

/**
 * The entry that adds Windows' `powershell` tool to the root's active tools. Pi's default selection
 * has `bash` only, which needs Git Bash on Windows; the root keeps both there, so it has a shell on
 * a machine without Git Bash. Other systems do not add it, where it cannot run.
 */
export const POWERSHELL_ENTRY = "+powershell"

/**
 * The `--tools` entry that turns Pi's built-in `codemode` extension on beside the defaults (the
 * root).
 */
export const CODEMODE_ENTRY = "+codemode"

/**
 * The allowlist entry that turns `codemode` on for a specialist: plain names cannot mix with
 * `+name`.
 */
export const CODEMODE_TOOL = "codemode"

/** The environment variable that caps the codemode workers alive in one Pi process. */
export const CODEMODE_MAX_WORKERS_ENV = "PI_CODEMODE_MAX_WORKERS"

/**
 * The prefix of T3 Code's tools as a pattern. Pi names an MCP tool `mcp__<server>__<tool>` with
 * every character but letters, digits and `_` of the server name turned into `_`, so a server the
 * user registers as `t3-code` gives `mcp__t3_code__...`, while T3's own bridge uses
 * `mcp__t3-code__...`; the `*` matches both.
 */
const T3_PREFIX = "mcp__t3*code__"

/**
 * The T3 Code tools of the visual roles, as patterns on the tool names Pi gives them: the
 * integrated browser (`preview_*`, `t3_preview_*`), the page renders (`html_render`,
 * `html_preview`) and the devices (`device_*`). They arrive only through Pi's built-in MCP
 * extension, so they exist only under T3 Code's bridge or after the user registered T3's MCP
 * server, and only while `pi.features.mcp` is on.
 */
export const T3_VISUAL_TOOLS: ReadonlyArray<string> = [
  `${T3_PREFIX}preview_*`,
  `${T3_PREFIX}t3_preview_*`,
  `${T3_PREFIX}html_render`,
  `${T3_PREFIX}html_preview`,
  `${T3_PREFIX}device_*`,
]

/**
 * Whether the root keeps no use for a registered tool under T3 Code: it is one of T3's own tools
 * (either spelling of the server name, see {@link T3_PREFIX}) outside the {@link T3_VISUAL_TOOLS}
 * families. T3's orchestration, thread, schedule and pending-request tools duplicate what HolyAgent
 * does through its specialists, so the root has them neither active nor callable.
 */
export const isDeactivatedT3Tool = (name: string): boolean =>
  toolMatches(`${T3_PREFIX}*`, name) &&
  !T3_VISUAL_TOOLS.some((pattern) => toolMatches(pattern, name))

/** The names among `registered` that {@link isDeactivatedT3Tool} names, in their order. */
export const deactivatedT3Tools = (registered: ReadonlyArray<string>): ReadonlyArray<string> =>
  registered.filter(isDeactivatedT3Tool)

/** The computer-use tools of `@amaster.ai/pi-computer-use`, which all carry this prefix. */
export const COMPUTER_USE_TOOLS: ReadonlyArray<string> = ["computer_use_*"]

/** The tool arguments of one Pi process. */
export interface ToolArgs {
  /** The value of `--tools`: an allowlist of names and patterns, or `+name` entries on the defaults. */
  readonly tools: ReadonlyArray<string>
  /** The value of `--exclude-tools`, applied after every other selection; may be empty. */
  readonly excludeTools: ReadonlyArray<string>
  /** True when `pi.features.mcp` is off and the process starts with `--no-mcp`. */
  readonly noMcp: boolean
  /** The environment variables the launcher sets on the process: `PI_CODEMODE_MAX_WORKERS`. */
  readonly env: Readonly<Record<string, string>>
  /** The arguments in the order the launcher passes them to Pi. */
  readonly argv: ReadonlyArray<string>
}

const build = (
  tools: ReadonlyArray<string>,
  excludeTools: ReadonlyArray<string>,
  noMcp: boolean,
  maxWorkers: number,
): ToolArgs => ({
  tools,
  excludeTools,
  noMcp,
  env: { [CODEMODE_MAX_WORKERS_ENV]: String(maxWorkers) },
  argv: [
    "--tools",
    tools.join(","),
    ...(excludeTools.length > 0 ? ["--exclude-tools", excludeTools.join(",")] : []),
    ...(noMcp ? ["--no-mcp"] : []),
  ],
})

const has = (capabilities: ReadonlyArray<Capability>, capability: Capability) =>
  capabilities.includes(capability)

/**
 * The Pi tool arguments of the root or of one specialist; the one place a role's tools are decided.
 * Every role runs `codemode` (mode `only`, from `pi.codemode.mode`, written by `toolSettings`) with
 * `PI_CODEMODE_MAX_WORKERS` from `pi.codemode.maxWorkers` in `env`. The root keeps the default
 * selection (`read` and `bash`, the extension tools of the enabled packages, `todo`,
 * `ask_user_question`, the process and subagent tools) and adds `+codemode`; on Windows the
 * extension also adds {@link POWERSHELL_ENTRY}. It excludes `write` and `edit`, since it writes no
 * files, and, while each is enabled, the computer-use tools and the web choice's tools: `+codemode`
 * keeps every enabled extension's tools, but the root delegates research to the Librarian roles and
 * visual inspection to the visual specialists, as the Claude root does. A specialist gets an
 * allowlist: the read tools, then what its route grants, then `codemode`, and `--exclude-tools`
 * repeats as a floor the write tools it must not have:
 *
 * - Write: `write`, `edit`, `bash` and `powershell`;
 * - Shell: `bash` and `powershell` (Worker.operations, Worker.validation, Reviewer.testing), and
 *   Reviewer.code, which reads diffs with `git`;
 * - Search: the web tools of the web choice, none when `pi.features.web` is `off`;
 * - VisualInspection: T3 Code's browser, render and device tools while `pi.features.mcp` is on, and
 *   the computer-use tools while `pi.features.computerUse` is on.
 *
 * A specialist's allowlist never names `todo`, `ask_user_question` or the process tools: the root
 * alone has them. Tools registered `model-only` (`ask_user_question`) stay directly callable under
 * mode `only`. With `pi.features.mcp` off every process starts with `--no-mcp`. The profile
 * defaults to the selected provider's; a test passes another.
 */
export const toolArgs = (
  config: Config,
  key: RouteKey,
  profile: ProviderProfile = providerProfile(config),
): ToolArgs => {
  const { features } = config.pi
  const noMcp = !features.mcp
  const { maxWorkers } = config.pi.codemode
  if (key === "root") {
    const excluded = [
      "write",
      "edit",
      ...(features.computerUse ? COMPUTER_USE_TOOLS : []),
      ...webChoice(profile, features.web).tools,
    ]
    return build([CODEMODE_ENTRY], excluded, noMcp, maxWorkers)
  }
  const { capabilities, roleTask } = routeFor(key)
  const tools = [
    ...READ_TOOLS,
    ...(has(capabilities, "Write") ? WRITE_TOOLS : []),
    ...(has(capabilities, "Shell") || roleTask === "Reviewer.code" ? SHELL_TOOLS : []),
    ...(has(capabilities, "Search") ? webChoice(profile, features.web).tools : []),
    ...(has(capabilities, "VisualInspection")
      ? [
          ...(features.mcp ? T3_VISUAL_TOOLS : []),
          ...(features.computerUse ? COMPUTER_USE_TOOLS : []),
        ]
      : []),
  ]
  const unique = [...new Set(tools)]
  return build(
    [...unique, CODEMODE_TOOL],
    WRITE_TOOLS.filter((tool) => !unique.includes(tool)),
    noMcp,
    maxWorkers,
  )
}

const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

/**
 * Whether a tool name matches a `--tools` or `--exclude-tools` entry: an exact name, or a pattern
 * whose `*` stands for any run of characters (`computer_use_*`).
 */
export const toolMatches = (pattern: string, name: string): boolean =>
  new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(name)

/**
 * The tools the root has active, for `pi.setActiveTools`, which takes names only: Pi's current
 * selection (`active`), plus the root's `+name` entries (a pattern adds every registered tool it
 * matches, and a name no tool has is ignored by Pi), minus what its `excludeTools` entries match.
 * The command-line flags do this at launch; an extension has no flag, so it does the same sum after
 * the session starts. `--no-mcp` has no equivalent here: it decides which extensions load, and
 * `pi.features.mcp` off is only honoured by a launch that passes the flag.
 */
export const rootActiveTools = (
  args: Pick<ToolArgs, "tools" | "excludeTools">,
  active: ReadonlyArray<string>,
  registered: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const added = args.tools.flatMap((entry) => {
    const name = entry.startsWith("+") ? entry.slice(1) : entry
    return name.includes("*") ? registered.filter((tool) => toolMatches(name, tool)) : [name]
  })
  return [...new Set([...active, ...added])].filter(
    (tool) => !args.excludeTools.some((pattern) => toolMatches(pattern, tool)),
  )
}

/** The arguments of the root and each of the 18 specialists, the root first. */
export const allToolArgs = (
  config: Config,
  profile: ProviderProfile = providerProfile(config),
): Readonly<Record<RouteKey, ToolArgs>> =>
  Object.fromEntries(
    (Object.keys(config.pi.routes) as Array<RouteKey>).map((key) => [
      key,
      toolArgs(config, key, profile),
    ]),
  ) as Record<RouteKey, ToolArgs>

/**
 * One JSON settings file that setup writes by merging, never by replacing: `content` holds the keys
 * to set, and every other key of the file stays. `file` starts with `~/`, the user's home, or with
 * `~/.pi/agent/`, which is `PI_CODING_AGENT_DIR` when that is set.
 */
export interface SettingsPatch {
  /** The file, as a path under the user's home. */
  readonly file: string
  /** The keys to merge into it, deeply. */
  readonly content: Readonly<Record<string, unknown>>
}

/** Billion Context's settings file; `BILI_CONFIG_FILE` can relocate it, and setup then writes there. */
export const BILLION_CONTEXT_FILE = "~/.config/billion-context/billion-context.json"

/**
 * Pi's agent-directory settings file: the codemode mode and the options of
 * `@amaster.ai/pi-computer-use`.
 */
export const PI_SETTINGS_FILE = "~/.pi/agent/settings.json"

/**
 * The settings file of `@tintinweb/pi-subagents`: the package reads `subagents.json` from Pi's
 * agent directory (`getAgentDir()`, which is `PI_CODING_AGENT_DIR` when set) as its global
 * defaults.
 */
export const SUBAGENTS_SETTINGS_FILE = "~/.pi/agent/subagents.json"

/**
 * The package settings that let only the specialists launch: `disableDefaultAgents` leaves out the
 * package's own `general-purpose`, `Explore` and `Plan`, and `fallbackSubagent: "none"` makes a
 * `subagent_type` that names no enabled agent fail instead of falling back to `general-purpose`
 * (whose tool set is not a specialist's).
 */
export const SUBAGENTS_ONLY_SPECIALISTS = {
  disableDefaultAgents: true,
  fallbackSubagent: "none",
} as const

/**
 * What setup writes so the decided tool settings hold, as data; it writes nothing itself. Empty
 * with `pi.enable` off. A switched-off feature adds nothing, since its package is not loaded:
 *
 * - The provider's web tools, enabled in the provider extension's settings, while the web choice is
 *   the provider's (they are off by default);
 * - The codemode mode (`pi.codemode.mode`, `only` by default) in Pi's settings, since no command-line
 *   argument sets it;
 * - The package's `subagents.json` ({@link SUBAGENTS_ONLY_SPECIALISTS}) while `pi.features.subagents`
 *   is on, so only the 18 specialists the package ships can launch;
 * - Billion Context's own `acp_delegate` subagents off while context compression stays on, because
 *   `@tintinweb/pi-subagents` runs the specialists. This is the one setting the package's README
 *   gives for it, "Pi built-in subagents": merge `{"pi":{"subagents":false}}` into
 *   `billion-context.json` (README lines 566-582; line 582: "context compression remains
 *   enabled");
 * - The computer-use confirmations off, the decided "full access, no prompts".
 */
export const toolSettings = (
  config: Config,
  profile: ProviderProfile = providerProfile(config),
): ReadonlyArray<SettingsPatch> => {
  const { enable, features } = config.pi
  if (!enable) return []
  const web = webChoice(profile, features.web)
  return [
    { file: PI_SETTINGS_FILE, content: { codemode: { mode: config.pi.codemode.mode } } },
    ...(web.source === "provider"
      ? [
          {
            file: profile.toolsFile,
            content: {
              tools: Object.fromEntries(web.tools.map((tool) => [tool, { enabled: true }])),
            },
          },
        ]
      : []),
    ...(features.subagents
      ? [{ file: SUBAGENTS_SETTINGS_FILE, content: SUBAGENTS_ONLY_SPECIALISTS }]
      : []),
    ...(features.contextCompression
      ? [{ file: BILLION_CONTEXT_FILE, content: { pi: { subagents: false } } }]
      : []),
    ...(features.computerUse
      ? [
          {
            file: PI_SETTINGS_FILE,
            content: {
              "pi-computer-use": { confirmAppLaunch: false, confirmDangerousActions: false },
            },
          },
        ]
      : []),
  ]
}
