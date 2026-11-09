import type { PiPackageName } from "./pi-packages.ts"

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
  /** What it needs of the system. */
  readonly needs: ReadonlyArray<SystemNeed>
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

/** Why a capability is not offered in a form, or `undefined` when it is. */
export const unavailableIn = (
  capability: CapabilityDefinition,
  form: CapabilityForm,
): string | undefined => {
  const entry = capability.forms[form]
  return "unavailable" in entry ? entry.unavailable : undefined
}

/**
 * The capabilities a `pi.features` object switches on, in registry order. With a `form`, only those
 * the form offers; without one, all that are on.
 */
export const enabledCapabilities = (
  features: Readonly<Record<string, unknown>>,
  options: {
    readonly form?: CapabilityForm
    readonly definitions?: ReadonlyArray<CapabilityDefinition>
  } = {},
): ReadonlyArray<CapabilityDefinition> =>
  (options.definitions ?? CAPABILITIES).filter(
    (capability) =>
      features[capability.feature] === true &&
      (options.form === undefined || unavailableIn(capability, options.form) === undefined),
  )

/** The package names of the capabilities `features` switches on and `form` offers, in order. */
export const capabilityPackages = (
  features: Readonly<Record<string, unknown>>,
  form: CapabilityForm,
  definitions: ReadonlyArray<CapabilityDefinition> = CAPABILITIES,
): ReadonlyArray<PiPackageName> =>
  enabledCapabilities(features, { form, definitions }).flatMap(
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
