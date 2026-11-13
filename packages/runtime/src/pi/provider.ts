import { type PiPackageName, piPackageSource } from "../config/pi-packages.ts"
import type { Config, PiProvider, RouteChoice, RouteKey, Thinking } from "../config/schema.ts"
import type { PiFamily } from "../instructions/families.ts"
import { APPLY_PATCH_TOOL } from "./codex/apply-patch.ts"
import { CODEX_PROVIDER_ID, screenRoute } from "./codex/routes.ts"

/** What the integration knows about one model provider: the only place a provider is named. */
export interface ProviderProfile {
  /** The provider id in Pi's catalog, the `<provider>` of `--model <provider>/<id>`. */
  readonly id: string
  /**
   * The Pi package that supplies the provider; selecting the provider loads it, at its pin. Absent
   * for a provider Pi ships itself (Codex), which loads no package.
   */
  readonly package?: PiPackageName
  /**
   * The model family whose instruction text the root and the specialists run on under this provider
   * (a folder of `instructions/`).
   */
  readonly family: PiFamily
  /**
   * The tools a specialist with the Write capability has beyond Pi's `write`, `edit` and `bash`
   * (Codex's `apply_patch`); the root, which writes no files, never has them.
   */
  readonly writeTools: ReadonlyArray<string>
  /** The variables the launcher sets on every Pi process, so the provider reaches its region. */
  readonly env: Readonly<Record<string, string>>
  /** What the user does to make the provider ready when Pi reports it has no credentials. */
  readonly loginFix: string
  /**
   * The web tools the provider extension offers, in Pi's tool names (empty when it offers none).
   * While it offers some, the `provider` web mode uses them and `pi-web-kit` is not loaded.
   */
  readonly webTools: ReadonlyArray<string>
  /**
   * The provider extension's own settings file, where those web tools are switched on (they are off
   * until a setting enables them), as a path under the user's home. Absent with no web tools.
   */
  readonly toolsFile?: string
  /**
   * How an Assignment that carries the screen capability is routed, from the route-table row of its
   * role (Codex: Terra at medium or above). Absent when the row stands, as under Kimi.
   */
  readonly screenRoute?: (row: RouteChoice) => RouteChoice
}

/**
 * The provider profiles, one per value of `pi.provider`. Kimi for Coding (global) is Pi's built-in
 * `kimi-coding` provider with `pi-provider-kimi-code` on top, at the exact release
 * `pi-packages.json` pins, and `KIMI_CODE_REGION=global`, which sends requests to Moonshot's
 * overseas host. Codex is Pi's built-in `openai-codex` provider (ChatGPT sign-in) with nothing on
 * top: it needs no package, its models are in Pi's catalog, and what HolyAgent adds (`apply_patch`,
 * `context_management`, Luna Reserve) is the extension's `pi/codex` module. The GPT-6 instruction
 * family runs under it, and its web tools come from `pi-web-kit`, since the provider has none.
 */
export const PROVIDERS: Readonly<Record<PiProvider, ProviderProfile>> = {
  "kimi-coding-global": {
    id: "kimi-coding",
    package: "pi-provider-kimi-code",
    family: "kimi-k3.1",
    writeTools: [],
    env: { KIMI_CODE_REGION: "global" },
    loginFix: "Run /login kimi-coding in Pi, or set KIMI_API_KEY",
    webTools: ["moonshot_search", "moonshot_fetch"],
    toolsFile: "~/.pi/providers/kimi-coding/config.json",
  },
  "openai-codex": {
    id: CODEX_PROVIDER_ID,
    family: "gpt-6",
    writeTools: [APPLY_PATCH_TOOL],
    env: {},
    loginFix: "Run /login openai-codex in Pi and sign in with the ChatGPT account that has Codex",
    webTools: [],
    screenRoute,
  },
}

/** The model one route-table row resolves to, in the terms Pi takes. */
export interface ModelRoute {
  /** The route-table row. */
  readonly key: RouteKey
  /** The provider id in Pi's catalog. */
  readonly provider: string
  /** The model id as the provider names it. */
  readonly model: string
  /** The reasoning level Pi sets for the session. */
  readonly thinking: Thinking
  /** The value of Pi's `--model` flag: `<provider>/<id>:<thinking>`. */
  readonly spec: string
}

/** The profile of the provider that the config selects. */
export const providerProfile = (config: Config): ProviderProfile => PROVIDERS[config.pi.provider]

/**
 * Turns a route-table row into the Pi model and thinking level to launch, with the provider the
 * config selects. The provider takes the route table's reasoning levels as they are. With `screen`
 * (an Assignment that carries the screen capability) the provider's `screenRoute` decides: Codex
 * moves it to Terra at medium or above, and a provider without one keeps the row.
 */
export const routeModel = (
  config: Config,
  key: RouteKey,
  options: { readonly screen?: boolean } = {},
): ModelRoute => {
  const row = config.pi.routes[key]
  const profile = PROVIDERS[row.provider ?? config.pi.provider]
  const { model, thinking } =
    options.screen === true && profile.screenRoute !== undefined ? profile.screenRoute(row) : row
  return {
    key,
    provider: profile.id,
    model,
    thinking,
    spec: `${profile.id}/${model}:${thinking}`,
  }
}

/**
 * The two Pi settings keys that name one model and so are written, kept and removed as a pair: a
 * model id means something only beside its provider, so a route's model next to a provider chosen
 * by hand (or the reverse) could name a model that provider lacks.
 */
export const ROOT_MODEL_PAIR: ReadonlyArray<string> = ["defaultProvider", "defaultModel"]

/**
 * The root's route as the three keys Pi's settings hold for the model a session starts on:
 * `defaultProvider`, `defaultModel` and `defaultThinkingLevel`. Setup writes the provider and the
 * model ({@link ROOT_MODEL_PAIR}) together where the user has chosen neither, and the thinking
 * level where it is unset, so the root starts on the route table's row without a launch argument.
 */
export const rootModelSettings = (config: Config) => {
  const { provider, model, thinking } = routeModel(config, "root")
  return { defaultProvider: provider, defaultModel: model, defaultThinkingLevel: thinking } as const
}

/**
 * The model of a route as `@tintinweb/pi-subagents` takes it per call (the `model` of its `Agent`
 * tool and of `agent()`): `<provider>/<id>`, which it matches exactly, without the `:<thinking>`
 * suffix of `--model`. The thinking level goes in the call's `thinking` (`effort` in `agent()`).
 */
export const subagentModel = ({ provider, model }: ModelRoute): string => `${provider}/${model}`

/** Every row of the route table, the root first, resolved with {@link routeModel}. */
export const routedModels = (config: Config): ReadonlyArray<ModelRoute> =>
  (Object.keys(config.pi.routes) as Array<RouteKey>).map((key) => routeModel(config, key))

/** The variables the launcher sets on a Pi process for the provider the config selects. */
export const providerEnv = (config: Config): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.values(config.pi.routes).flatMap((row) =>
      Object.entries(PROVIDERS[row.provider ?? config.pi.provider].env),
    ),
  )

/**
 * The Pi package source of the selected provider's extension, with its pinned release, or
 * `undefined` for a provider that loads no package (Codex).
 */
export const providerSource = (config: Config): string | undefined => {
  const { package: name } = providerProfile(config)
  return name === undefined ? undefined : piPackageSource(name)
}

/** Where a session's web tools come from, as `pi.features.web` and the provider decide. */
export type WebChoice =
  | { readonly source: "provider"; readonly tools: ReadonlyArray<string> }
  | { readonly source: "pi-web-kit"; readonly tools: ReadonlyArray<string> }
  | { readonly source: "off"; readonly tools: readonly [] }

/** The tools `pi-web-kit` adds: search and page fetch. */
export const WEB_KIT_TOOLS: ReadonlyArray<string> = ["web_search", "web_fetch"]

/**
 * Lists possible web tools without asserting that any tool is installed, active or authorized.
 * Provider mode names the known Kimi tools regardless of the model provider; the explicit kit mode
 * also names its own tools. The host gates calls using the session's actual active tools.
 */
export const webChoice = (
  _profile: ProviderProfile,
  mode: Config["pi"]["features"]["web"],
): WebChoice =>
  mode === "off"
    ? { source: "off", tools: [] }
    : mode === "provider"
      ? { source: "provider", tools: PROVIDERS["kimi-coding-global"].webTools }
      : {
          source: "pi-web-kit",
          tools: [...PROVIDERS["kimi-coding-global"].webTools, ...WEB_KIT_TOOLS],
        }

/** Observed host exposure is distinct from an account's unknown service entitlement. */
export const nativeSearchInventory = (
  registered: ReadonlyArray<string>,
  active: ReadonlyArray<string>,
): { readonly state: "exposed" | "disabled" | "unknown"; readonly reason: string } =>
  !registered.includes("moonshot_search")
    ? {
        state: "unknown",
        reason: "Kimi search is not exposed; installation or enablement is unknown",
      }
    : !active.includes("moonshot_search")
      ? { state: "disabled", reason: "Kimi search is registered but inactive" }
      : {
          state: "exposed",
          reason:
            "Kimi search is active; OAuth and account entitlement are checked by the tool on use",
        }
