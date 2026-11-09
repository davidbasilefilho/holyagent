import { type PiPackageName, piPackageSource } from "../config/pi-packages.ts"
import type { Config, PiProvider, RouteKey, Thinking } from "../config/schema.ts"

/** What the integration knows about one model provider: the only place a provider is named. */
export interface ProviderProfile {
  /** The provider id in Pi's catalog, the `<provider>` of `--model <provider>/<id>`. */
  readonly id: string
  /** The Pi package that supplies the provider; selecting the provider loads it, at its pin. */
  readonly package: PiPackageName
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
   * until a setting enables them), as a path under the user's home.
   */
  readonly toolsFile: string
}

/**
 * The provider profiles, one per value of `pi.provider`. Kimi for Coding (global) is Pi's built-in
 * `kimi-coding` provider with `pi-provider-kimi-code` on top, at the exact release
 * `pi-packages.json` pins, and `KIMI_CODE_REGION=global`, which sends requests to Moonshot's
 * overseas host.
 */
export const PROVIDERS: Readonly<Record<PiProvider, ProviderProfile>> = {
  "kimi-coding-global": {
    id: "kimi-coding",
    package: "pi-provider-kimi-code",
    env: { KIMI_CODE_REGION: "global" },
    loginFix: "Run /login kimi-coding in Pi, or set KIMI_API_KEY",
    webTools: ["moonshot_search", "moonshot_fetch"],
    toolsFile: "~/.pi/providers/kimi-coding/config.json",
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
 * config selects. Kimi Code takes the route table's `low`, `high` and `max` as they are.
 */
export const routeModel = (config: Config, key: RouteKey): ModelRoute => {
  const { id } = providerProfile(config)
  const { model, thinking } = config.pi.routes[key]
  return { key, provider: id, model, thinking, spec: `${id}/${model}:${thinking}` }
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
  providerProfile(config).env

/** The Pi package source of the selected provider's extension, with its pinned release. */
export const providerSource = (config: Config): string =>
  piPackageSource(providerProfile(config).package)

/** Where a session's web tools come from, as `pi.features.web` and the provider decide. */
export type WebChoice =
  | { readonly source: "provider"; readonly tools: ReadonlyArray<string> }
  | { readonly source: "pi-web-kit"; readonly tools: ReadonlyArray<string> }
  | { readonly source: "off"; readonly tools: readonly [] }

/** The tools `pi-web-kit` adds: search and page fetch. */
export const WEB_KIT_TOOLS: ReadonlyArray<string> = ["web_search", "web_fetch"]

/**
 * Chooses the web tools. `off` has none. `pi-web-kit` loads that package, the fallback for a login
 * that cannot use the provider's tools. `provider` uses the provider extension's tools while it
 * offers some, and loads `pi-web-kit` only when it offers none, so the two never run together. The
 * profile is a parameter so a provider without web tools can be tested.
 */
export const webChoice = (
  profile: ProviderProfile,
  mode: Config["pi"]["features"]["web"],
): WebChoice =>
  mode === "off"
    ? { source: "off", tools: [] }
    : mode === "provider" && profile.webTools.length > 0
      ? { source: "provider", tools: profile.webTools }
      : { source: "pi-web-kit", tools: WEB_KIT_TOOLS }
