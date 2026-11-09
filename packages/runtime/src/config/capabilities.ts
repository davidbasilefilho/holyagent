import { BILLION_CONTEXT_GUARDRAILS_FILE } from "../pi/bash/guardrails.ts"
import { FFF_NATIVE_HOSTS, FFF_OVERRIDE_SETTINGS, FFF_TOOLS } from "../pi/fff/settings.ts"
import type { PiPackageName } from "./pi-packages.ts"
import type { PiProvider } from "./schema.ts"

/**
 * The two forms a capability takes: `headless` on a machine with no graphical session (a server,
 * CI, a cloud session) and `normal` everywhere else. Setup and doctor detect the form from the
 * machine (`detectForm`) unless `--form` names one.
 */
export const CAPABILITY_FORMS = ["headless", "normal"] as const
/** One capability form. */
export type CapabilityForm = (typeof CAPABILITY_FORMS)[number]

/**
 * An MCP server a capability adds to Pi's own MCP extension. No capability adds one yet: the later
 * capabilities of this release fill {@link FormContent.mcpServers}, and setup does not read it
 * before then.
 */
export interface McpServer {
  /** The name the server is registered under. */
  readonly name: string
  /** The command that starts it. */
  readonly command: string
  /** The arguments of the command. */
  readonly args: ReadonlyArray<string>
}

/** What a capability installs in one form: Pi packages (by npm name, pinned) and MCP servers. */
export interface FormContent {
  /** The Pi packages the form loads; their versions are the pins of `pi-packages.json`. */
  readonly packages: ReadonlyArray<PiPackageName>
  /**
   * The MCP servers the form adds; empty for every capability until the later capabilities of this
   * release.
   */
  readonly mcpServers: ReadonlyArray<McpServer>
}

/** A form the capability does not have on this kind of machine, with the reason doctor prints. */
export interface FormUnavailable {
  /** Why the capability is not offered in this form. */
  readonly unavailable: string
}

/** One system requirement of a capability, which doctor checks. */
export type SystemNeed =
  | {
      /** A graphical session: `DISPLAY` or `WAYLAND_DISPLAY` on Linux, assumed on macOS and Windows. */
      readonly kind: "display"
    }
  | {
      /** A command on PATH. */
      readonly kind: "command"
      readonly command: string
      /** How the person gets it, appended to the failing line. */
      readonly fix: string
    }

/** What doctor checks of an enabled capability: its system needs, and that its packages are listed. */
export type HealthProbe = "needs" | "packages"

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
  /**
   * The key of `pi.features` of another capability that must be on for the patch to be written, for
   * a setting of that capability's package made on behalf of this one: absent when the patch
   * belongs to this capability alone.
   */
  readonly whileOn?: string
  /**
   * Whether `holyagent setup` takes the keys back out when the patch is no longer planned (the
   * capability is off, or the `whileOn` one is): only the keys setup recorded writing, and only
   * while they still hold what it wrote. For a setting made for the sake of one capability, which
   * must not outlive it.
   */
  readonly revertWhenOff?: boolean
}

/** One optional capability: a switch of `pi.features` with everything that follows from it. */
export interface CapabilityDefinition {
  /** The name setup's flag and doctor's lines use, in kebab case. */
  readonly name: string
  /** The key of `pi.features` that switches it. */
  readonly feature: string
  /** What it gives, in a sentence. */
  readonly description: string
  /**
   * The skills it carries; empty for every capability until the later capabilities of this release
   * add some.
   */
  readonly skills: ReadonlyArray<string>
  /** Whose tools it reaches: the root, the specialists, or both. */
  readonly applicability: "root" | "specialists" | "both"
  /** Whether it is on when the config does not say. */
  readonly defaultOn: boolean
  /**
   * The only `pi.provider` it applies to; absent for a capability that works with every provider.
   * Its switch stays in `pi.features` whatever the provider, but under another provider it loads
   * nothing and doctor does not list it.
   */
  readonly provider?: PiProvider
  /** What it needs of the system. */
  readonly needs: ReadonlyArray<SystemNeed>
  /**
   * The hosts (`<process.platform>-<process.arch>`) its native library covers; absent for a
   * capability with none. On any other host it is not offered, in either form, and Pi keeps its own
   * tools.
   */
  readonly nativeHosts?: ReadonlyArray<string>
  /** What it installs on a headless machine, or why it is not offered there. */
  readonly forms: {
    readonly headless: FormContent | FormUnavailable
    readonly normal: FormContent | FormUnavailable
  }
  /** The tool patterns it decides: the root excludes `rootExclude`, visual specialists get `visual`. */
  readonly tools: {
    readonly rootExclude: ReadonlyArray<string>
    readonly visual: ReadonlyArray<string>
  }
  /** The package settings setup writes while it is on and offered in the form. */
  readonly settings: ReadonlyArray<SettingsPatch>
  /** The checks doctor runs while it is on. */
  readonly health: ReadonlyArray<HealthProbe>
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
 * The settings file of `@ff-labs/pi-fff`: the package reads `pi-fff.json` from Pi's agent directory
 * and from there only, so setup writes it at user scope alone.
 */
export const PI_FFF_FILE = "~/.pi/agent/pi-fff.json"

/**
 * The prefix of T3 Code's tools as a pattern. Pi names an MCP tool `mcp__<server>__<tool>` with
 * every character but letters, digits and `_` of the server name turned into `_`, so a server the
 * user registers as `t3-code` gives `mcp__t3_code__...`, while T3's own bridge uses
 * `mcp__t3-code__...`; the `*` matches both.
 */
export const T3_PREFIX = "mcp__t3*code__"

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

/** The computer-use tools of `@amaster.ai/pi-computer-use`, which all carry this prefix. */
export const COMPUTER_USE_TOOLS: ReadonlyArray<string> = ["computer_use_*"]

/** The same packages in both forms, with no MCP server. */
const sameForm = <const P extends ReadonlyArray<PiPackageName>>(packages: P) =>
  ({
    headless: { packages, mcpServers: [] },
    normal: { packages, mcpServers: [] },
  }) as const

/**
 * Every optional capability, in the order their packages load. Adding a capability is adding one
 * entry here: `pi.features`, the package selection, the tool settings and tool lists, the setup
 * flag and screen row, and doctor's lines all read this list. Package versions are not written
 * here: a package is named, and `pi-packages.json` (moved by `mise run deps:update`) pins it.
 */
export const CAPABILITIES = [
  {
    name: "subagents",
    feature: "subagents",
    description: "Runs the 18 specialists as subagents (@tintinweb/pi-subagents)",
    skills: [],
    applicability: "root",
    defaultOn: true,
    needs: [],
    forms: sameForm(["@tintinweb/pi-subagents"]),
    tools: { rootExclude: [], visual: [] },
    settings: [{ file: SUBAGENTS_SETTINGS_FILE, content: SUBAGENTS_ONLY_SPECIALISTS }],
    health: ["needs", "packages"],
  },
  {
    name: "context-compression",
    feature: "contextCompression",
    description: "Compresses the context of long sessions (Billion Context)",
    skills: [],
    applicability: "both",
    defaultOn: true,
    needs: [],
    forms: sameForm(["billion-context"]),
    tools: { rootExclude: [], visual: [] },
    // Billion Context's own subagents stay off: `@tintinweb/pi-subagents` runs the specialists. This
    // is the one setting the package's README gives for it ("Pi built-in subagents", README lines
    // 566-582; line 582: "context compression remains enabled").
    settings: [{ file: BILLION_CONTEXT_FILE, content: { pi: { subagents: false } } }],
    health: ["needs", "packages"],
  },
  {
    name: "todo",
    feature: "todo",
    description: "Gives the root a todo list tool (@juicesharp/rpiv-todo)",
    skills: [],
    applicability: "root",
    defaultOn: true,
    needs: [],
    forms: sameForm(["@juicesharp/rpiv-todo"]),
    tools: { rootExclude: [], visual: [] },
    settings: [],
    health: ["needs", "packages"],
  },
  {
    name: "ask",
    feature: "ask",
    description:
      "Lets the root ask the user a question mid-run (@juicesharp/rpiv-ask-user-question)",
    skills: [],
    applicability: "root",
    defaultOn: true,
    needs: [],
    forms: sameForm(["@juicesharp/rpiv-ask-user-question"]),
    tools: { rootExclude: [], visual: [] },
    settings: [],
    health: ["needs", "packages"],
  },
  {
    name: "processes",
    feature: "processes",
    description: "Gives the root tools for background processes (@aliou/pi-processes)",
    skills: [],
    applicability: "root",
    defaultOn: true,
    needs: [],
    forms: sameForm(["@aliou/pi-processes"]),
    tools: { rootExclude: [], visual: [] },
    settings: [],
    health: ["needs", "packages"],
  },
  {
    // Pi's built-in MCP extension carries it, so it has no package: off starts every process with
    // `--no-mcp` (see `toolArgs`).
    name: "mcp",
    feature: "mcp",
    description:
      "Pi's built-in MCP extension, which brings T3 Code's browser, render and device tools",
    skills: [],
    applicability: "both",
    defaultOn: true,
    needs: [],
    forms: sameForm([]),
    tools: { rootExclude: [], visual: T3_VISUAL_TOOLS },
    settings: [],
    health: ["needs"],
  },
  {
    name: "computer-use",
    feature: "computerUse",
    description: "Lets the visual specialists drive the desktop (@amaster.ai/pi-computer-use)",
    skills: [],
    applicability: "specialists",
    defaultOn: true,
    needs: [{ kind: "display" }],
    forms: {
      headless: { unavailable: "it drives a graphical session and this machine has none" },
      normal: { packages: ["@amaster.ai/pi-computer-use"], mcpServers: [] },
    },
    // The decided "full access, no prompts".
    settings: [
      {
        file: PI_SETTINGS_FILE,
        content: { "pi-computer-use": { confirmAppLaunch: false, confirmDangerousActions: false } },
      },
    ],
    tools: { rootExclude: COMPUTER_USE_TOOLS, visual: COMPUTER_USE_TOOLS },
    health: ["needs", "packages"],
  },
  {
    // Part of the Codex provider (`pi/codex/luna-reserve.ts`): it has no package, no tool and no
    // setting, only the extension's behavior, so it exists only under `openai-codex`.
    name: "luna-reserve",
    feature: "lunaReserve",
    description:
      "Falls back to Codex's Luna Reserve allowance when the usage limit is reached (Codex provider only)",
    provider: "openai-codex",
    skills: [],
    applicability: "both",
    defaultOn: true,
    needs: [],
    forms: sameForm([]),
    tools: { rootExclude: [], visual: [] },
    settings: [],
    health: ["needs"],
  },
  {
    // Part of the Codex provider (`pi/codex/context-management.ts`): like Luna Reserve it is only
    // the extension's behavior, so it exists only under `openai-codex`.
    name: "context-management",
    feature: "contextManagement",
    description:
      "Lets the server compact the history with context_management while Billion Context is off (Codex provider only)",
    provider: "openai-codex",
    skills: [],
    applicability: "both",
    defaultOn: true,
    needs: [],
    forms: sameForm([]),
    tools: { rootExclude: [], visual: [] },
    settings: [],
    health: ["needs"],
  },
  {
    // The bash tool on just-bash (`pi/bash/`, run by the extension's `bash.ts`): no package and no
    // tool of its own, so off leaves Pi's own bash tool. Bun runs the shell, since Pi runs on Node.
    // The shell needs no display, so both forms are the same. Billion Context's bash guardrails go
    // off with it (the environment, see `justBashEnvironment`, and its file, written here so the
    // setting holds whatever the load order of the two extensions is); setup takes the file's keys
    // back out, by its record, when the capability goes off.
    name: "just-bash",
    feature: "justBash",
    description:
      "Runs the bash tool on just-bash, with the host's programs, TypeScript first and JavaScript as the fallback; turns Billion Context's bash guardrails off",
    skills: [],
    applicability: "both",
    defaultOn: true,
    needs: [
      {
        kind: "command",
        command: "bun",
        fix: "install Bun from https://bun.sh, since the shell runs on it",
      },
    ],
    forms: sameForm([]),
    tools: { rootExclude: [], visual: [] },
    settings: [
      {
        file: BILLION_CONTEXT_FILE,
        content: BILLION_CONTEXT_GUARDRAILS_FILE,
        whileOn: "contextCompression",
        revertWhenOff: true,
      },
    ],
    health: ["needs"],
  },
  {
    // `@ff-labs/pi-fff` in override mode: its `grep` and `find` take the place of Pi's. Its native
    // library covers `FFF_NATIVE_HOSTS` only; elsewhere the capability is not offered and Pi keeps its
    // own tools. The root does not use the tools (`FFF_TOOLS`); the specialists' `grep` and
    // `find` are the package's. The override is a key of the package's own file, which setup takes
    // back out when the capability goes off so that a package the user installs later is not
    // switched into override mode.
    name: "fff",
    feature: "fff",
    description:
      "Replaces Pi's find and grep with fff, a fast indexed file and content search (@ff-labs/pi-fff)",
    skills: [],
    applicability: "specialists",
    defaultOn: true,
    needs: [],
    nativeHosts: FFF_NATIVE_HOSTS,
    forms: sameForm(["@ff-labs/pi-fff"]),
    tools: { rootExclude: FFF_TOOLS, visual: [] },
    settings: [{ file: PI_FFF_FILE, content: FFF_OVERRIDE_SETTINGS, revertWhenOff: true }],
    health: ["needs", "packages"],
  },
] as const satisfies ReadonlyArray<CapabilityDefinition>

/** One registry entry as written. */
type Entry = (typeof CAPABILITIES)[number]

/** The key of `pi.features` that a capability switches. */
export type CapabilityFeature = Entry["feature"]

/** The key of `pi.features` and its default, for each capability. */
export const FEATURE_DEFAULTS: Readonly<Record<CapabilityFeature, boolean>> = Object.fromEntries(
  CAPABILITIES.map((capability) => [capability.feature, capability.defaultOn]),
) as Record<CapabilityFeature, boolean>

/** The content of a capability in a form, or `undefined` when the form is not offered. */
export const formContent = (
  capability: CapabilityDefinition,
  form: CapabilityForm,
): FormContent | undefined => {
  const entry = capability.forms[form]
  return "unavailable" in entry ? undefined : entry
}

/** The first package a capability's normal form loads, if it loads one. */
type NormalPackage<D> = D extends {
  readonly forms: { readonly normal: { readonly packages: readonly [infer P, ...Array<unknown>] } }
}
  ? P
  : never

/**
 * The Pi package that supplies each capability that has one, from its normal form. A capability
 * with no package (`mcp`) is not here. Read from {@link CAPABILITIES}; adding an entry adds a key.
 */
export const FEATURE_PACKAGES = Object.fromEntries(
  CAPABILITIES.flatMap((capability) => {
    const [first] = formContent(capability, "normal")?.packages ?? []
    return first === undefined ? [] : [[capability.feature, first]]
  }),
) as {
  readonly [
    D in Entry as [NormalPackage<D>] extends [never] ? never : D["feature"]
  ]: NormalPackage<D>
}

/** The host this process runs on, as {@link CapabilityDefinition.nativeHosts} spells it. */
export const hostPlatform = (): string => `${process.platform}-${process.arch}`

/**
 * Why a capability is not offered in a form on a host, or `undefined` when it is: the form leaves
 * it out, or its native library does not cover the host (`platform`, the machine's by default).
 */
export const unavailableIn = (
  capability: CapabilityDefinition,
  form: CapabilityForm,
  platform: string = hostPlatform(),
): string | undefined => {
  const entry = capability.forms[form]
  if ("unavailable" in entry) return entry.unavailable
  return capability.nativeHosts === undefined || capability.nativeHosts.includes(platform)
    ? undefined
    : `its native library does not cover ${platform}, only ${capability.nativeHosts.join(", ")}`
}

/**
 * The capabilities a `pi.features` object switches on, in registry order. With a `form`, only those
 * the form offers on the `platform` (the machine's by default, see {@link unavailableIn}); with a
 * `provider`, only those that apply to it (one with no `provider` of its own applies to every
 * provider); without either, all that are on.
 */
export const enabledCapabilities = (
  features: Readonly<Record<string, unknown>>,
  options: {
    readonly form?: CapabilityForm
    readonly platform?: string | undefined
    readonly provider?: PiProvider
    readonly definitions?: ReadonlyArray<CapabilityDefinition>
  } = {},
): ReadonlyArray<CapabilityDefinition> =>
  (options.definitions ?? (CAPABILITIES as ReadonlyArray<CapabilityDefinition>)).filter(
    (capability) =>
      features[capability.feature] === true &&
      (options.form === undefined ||
        unavailableIn(capability, options.form, options.platform) === undefined) &&
      (options.provider === undefined ||
        capability.provider === undefined ||
        capability.provider === options.provider),
  )

/**
 * The package names of the capabilities `features` switches on and `form` offers on the `platform`
 * (the machine's by default), in order.
 */
export const capabilityPackages = (
  features: Readonly<Record<string, unknown>>,
  form: CapabilityForm,
  definitions: ReadonlyArray<CapabilityDefinition> = CAPABILITIES,
  platform?: string,
): ReadonlyArray<PiPackageName> =>
  enabledCapabilities(features, { form, platform, definitions }).flatMap(
    (capability) => formContent(capability, form)?.packages ?? [],
  )

/**
 * The npm names of every package any capability can load in any form: what setup removes when the
 * config no longer selects them.
 */
export const managedCapabilityPackages = (
  definitions: ReadonlyArray<CapabilityDefinition> = CAPABILITIES,
): ReadonlyArray<PiPackageName> => [
  ...new Set(
    definitions.flatMap((capability) =>
      CAPABILITY_FORMS.flatMap((form) => formContent(capability, form)?.packages ?? []),
    ),
  ),
]
