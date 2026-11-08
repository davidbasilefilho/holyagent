import type { Config, PiProvider, RouteKey, Thinking } from "../config/schema.ts"

/** What the integration knows about one model provider: the only place a provider is named. */
export interface ProviderProfile {
  /** The provider id in Pi's catalog, the `<provider>` of `--model <provider>/<id>`. */
  readonly id: string
  /** The Pi package that supplies the provider; selecting the provider loads it. */
  readonly package: string
  /** The release of {@link ProviderProfile.package} the integration is tested against. */
  readonly version: string
  /** The variables the launcher sets on every Pi process, so the provider reaches its region. */
  readonly env: Readonly<Record<string, string>>
  /** What the user does to make the provider ready when Pi reports it has no credentials. */
  readonly loginFix: string
}

/**
 * The provider profiles, one per value of `pi.provider`. Kimi for Coding (global) is Pi's built-in
 * `kimi-coding` provider with `pi-provider-kimi-code` on top, pinned at its 0.6 line, and
 * `KIMI_CODE_REGION=global`, which sends requests to Moonshot's overseas host.
 */
export const PROVIDERS: Readonly<Record<PiProvider, ProviderProfile>> = {
  "kimi-coding-global": {
    id: "kimi-coding",
    package: "pi-provider-kimi-code",
    version: "0.6.13",
    env: { KIMI_CODE_REGION: "global" },
    loginFix: "Run /login kimi-coding in Pi, or set KIMI_API_KEY",
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

/** Every row of the route table, the root first, resolved with {@link routeModel}. */
export const routedModels = (config: Config): ReadonlyArray<ModelRoute> =>
  (Object.keys(config.pi.routes) as Array<RouteKey>).map((key) => routeModel(config, key))

/** The variables the launcher sets on a Pi process for the provider the config selects. */
export const providerEnv = (config: Config): Readonly<Record<string, string>> =>
  providerProfile(config).env

/** The Pi package source of the selected provider's extension, with its pinned release. */
export const providerSource = (config: Config): string => {
  const { package: name, version } = providerProfile(config)
  return `npm:${name}@${version}`
}
