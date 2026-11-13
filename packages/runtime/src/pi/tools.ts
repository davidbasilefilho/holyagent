import {
  BILLION_CONTEXT_FILE,
  type CapabilityForm,
  COMPUTER_USE_TOOLS,
  enabledCapabilities,
  PI_FFF_FILE,
  PI_SETTINGS_FILE,
  screenTools,
  type SettingsPatch,
  SUBAGENTS_ONLY_SPECIALISTS,
  SUBAGENTS_SETTINGS_FILE,
  T3_PREFIX,
  T3_VISUAL_TOOLS,
} from "../config/capabilities.ts"
import type { Config, RouteKey } from "../config/schema.ts"
import { type Capability, routeFor } from "../domain/route.ts"
import { justBashEnvironment } from "./bash/settings.ts"
import { FFF_TOOLS } from "./fff/settings.ts"
import { type ProviderProfile, providerProfile, PROVIDERS, webChoice } from "./provider.ts"

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

const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")

const patternRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`)

// The T3 Code tools of the visual roles and the computer-use tools live in the capability registry,
// which decides who gets them; they are re-exported here for the callers that name them.
export { COMPUTER_USE_TOOLS, T3_VISUAL_TOOLS }

// Compiled once: the `tool_call` gate asks for every call of a T3 session.
const T3_TOOL = patternRegExp(`${T3_PREFIX}*`)
const T3_VISUAL = T3_VISUAL_TOOLS.map(patternRegExp)

/**
 * Whether the root keeps no use for a registered tool under T3 Code: it is one of T3's own tools
 * (either spelling of the server name, see {@link T3_PREFIX}) outside the {@link T3_VISUAL_TOOLS}
 * families. T3's orchestration, thread, schedule and pending-request tools duplicate what HolyAgent
 * does through its specialists, so the root has them neither active nor callable.
 */
export const isDeactivatedT3Tool = (name: string): boolean =>
  T3_TOOL.test(name) && !T3_VISUAL.some((pattern) => pattern.test(name))

/** The names among `registered` that {@link isDeactivatedT3Tool} names, in their order. */
export const deactivatedT3Tools = (registered: ReadonlyArray<string>): ReadonlyArray<string> =>
  registered.filter(isDeactivatedT3Tool)

/** The tool arguments of one Pi process. */
export interface ToolArgs {
  /** The value of `--tools`: an allowlist of names and patterns, or `+name` entries on the defaults. */
  readonly tools: ReadonlyArray<string>
  /** The value of `--exclude-tools`, applied after every other selection; may be empty. */
  readonly excludeTools: ReadonlyArray<string>
  /** True when `pi.features.mcp` is off and the process starts with `--no-mcp`. */
  readonly noMcp: boolean
  /**
   * The environment variables the launcher sets on the process: `PI_CODEMODE_MAX_WORKERS`, and
   * Billion Context's `BILI_GUARDRAIL_*` while the bash tool runs on just-bash.
   */
  readonly env: Readonly<Record<string, string>>
  /** The arguments in the order the launcher passes them to Pi. */
  readonly argv: ReadonlyArray<string>
}

const build = (
  tools: ReadonlyArray<string>,
  excludeTools: ReadonlyArray<string>,
  noMcp: boolean,
  env: Readonly<Record<string, string>>,
): ToolArgs => ({
  tools,
  excludeTools,
  noMcp,
  env,
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
 * With `screen` (an Assignment that carries the screen capability) a specialist also gets the
 * `screen` tools of each enabled capability the `form` offers (`screenTools`), whatever its role,
 * and a visual role's own computer-use tools only where the form offers them: in the normal form
 * the computer-use tools and opencode browse's, in the headless form the browser-use server's (a
 * headless machine has no desktop to drive), and, while `pi.features.mcp` is on, T3 Code's preview
 * and render tools in both; every `mcp__` tool needs `pi.features.mcp`, the extension that runs the
 * servers. Without `screen` none of them is granted beyond what VisualInspection gives. The root
 * takes no `screen`. The form defaults to `normal`.
 *
 * A specialist's allowlist never names `todo`, `ask_user_question` or the process tools: the root
 * alone has them. Tools registered `model-only` (`ask_user_question`) stay directly callable under
 * mode `only`. With `pi.features.mcp` off every process starts with `--no-mcp`. The profile
 * defaults to the selected provider's; a test passes another.
 */
export const toolArgs = (
  config: Config,
  key: RouteKey,
  profile: ProviderProfile = PROVIDERS[config.pi.routes[key].provider ?? config.pi.provider],
  options: { readonly screen?: boolean; readonly form?: CapabilityForm } = {},
): ToolArgs => {
  const { features } = config.pi
  const provider = config.pi.routes[key].provider ?? config.pi.provider
  const enabled = enabledCapabilities(features, { provider })
  // What the form offers: a headless machine has no desktop, so a specialist launched for it has
  // no computer-use tools, not even a visual role, whose own tools they are in the normal form.
  const formEnabled = enabledCapabilities(features, {
    form: options.form ?? "normal",
    provider,
  })
  const noMcp = !features.mcp
  const env = {
    [CODEMODE_MAX_WORKERS_ENV]: String(config.pi.codemode.maxWorkers),
    ...justBashEnvironment(config),
  }
  if (key === "root") {
    const excluded = [
      "write",
      "edit",
      ...profile.writeTools,
      ...enabled.flatMap((capability) => capability.tools.rootExclude),
      ...webChoice(profile, features.web).tools,
    ]
    return build(
      [
        CODEMODE_ENTRY,
        ...(formEnabled.some((capability) => capability.feature === "fff")
          ? FFF_TOOLS.map((tool) => `+${tool}`)
          : []),
      ],
      excluded,
      noMcp,
      env,
    )
  }
  const { capabilities, roleTask } = routeFor(key)
  const tools = [
    ...READ_TOOLS,
    ...(formEnabled.some((capability) => capability.feature === "fff") ? FFF_TOOLS : []),
    ...(has(capabilities, "Write") ? [...WRITE_TOOLS, ...profile.writeTools] : []),
    ...(has(capabilities, "Shell") || roleTask === "Reviewer.code" ? SHELL_TOOLS : []),
    ...(has(capabilities, "Search") ? webChoice(profile, features.web).tools : []),
    ...(has(capabilities, "VisualInspection")
      ? formEnabled.flatMap((capability) => capability.tools.visual)
      : []),
    ...(options.screen === true
      ? formEnabled
          .flatMap((capability) => screenTools(capability, options.form ?? "normal"))
          .filter((tool) => features.mcp || !tool.startsWith("mcp__"))
      : []),
  ]
  const unique = [...new Set(tools)]
  return build(
    [...unique, CODEMODE_TOOL],
    [...WRITE_TOOLS, ...profile.writeTools].filter((tool) => !unique.includes(tool)),
    noMcp,
    env,
  )
}

/**
 * Whether a tool name matches a `--tools` or `--exclude-tools` entry: an exact name, or a pattern
 * whose `*` stands for any run of characters (`computer_use_*`).
 */
export const toolMatches = (pattern: string, name: string): boolean =>
  patternRegExp(pattern).test(name)

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
  return [
    ...new Set([
      ...active,
      ...added.filter((name) => !FFF_TOOLS.includes(name) || registered.includes(name)),
    ]),
  ].filter((tool) => !args.excludeTools.some((pattern) => toolMatches(pattern, tool)))
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

// The package settings files and the settings of each capability live in the capability registry;
// the files are re-exported here for the callers that name them.
export {
  BILLION_CONTEXT_FILE,
  PI_FFF_FILE,
  PI_SETTINGS_FILE,
  type SettingsPatch,
  SUBAGENTS_ONLY_SPECIALISTS,
  SUBAGENTS_SETTINGS_FILE,
}

/**
 * What setup writes so the decided tool settings hold, as data; it writes nothing itself. Empty
 * with `pi.enable` off. A switched-off capability adds nothing, since its package is not loaded,
 * and neither does one the `form` does not offer (the headless form has no computer use):
 *
 * - The codemode mode (`pi.codemode.mode`, `only` by default) in Pi's settings, since no command-line
 *   argument sets it;
 * - The `settings` of each enabled capability in the registry (`CAPABILITIES`), in its order: the
 *   subagents package's `subagents.json` ({@link SUBAGENTS_ONLY_SPECIALISTS}), so only the 18
 *   specialists the package ships can launch; Billion Context's own `acp_delegate` subagents off
 *   while context compression stays on; the computer-use confirmations off, the decided "full
 *   access, no prompts"; Billion Context's bash guardrails off while the bash tool runs on
 *   just-bash, and only while Billion Context itself is on (a patch's `whileOn`);
 *   `@ff-labs/pi-fff`'s override mode while fff is on and its native library covers the
 *   `platform`.
 *
 * The form defaults to `normal` and the platform to the machine's.
 */
export const toolSettings = (
  config: Config,
  _profile: ProviderProfile = providerProfile(config),
  form: CapabilityForm = "normal",
  platform?: string,
): ReadonlyArray<SettingsPatch> => {
  const { enable, features } = config.pi
  if (!enable) return []
  return [
    { file: PI_SETTINGS_FILE, content: { codemode: { mode: config.pi.codemode.mode } } },
    ...enabledCapabilities(features, { form, platform, provider: config.pi.provider })
      .flatMap((capability) => capability.settings)
      .filter(
        (patch) =>
          patch.whileOn === undefined ||
          (features as Readonly<Record<string, unknown>>)[patch.whileOn] === true,
      ),
  ]
}
