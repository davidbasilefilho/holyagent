import type { Config } from "./schema.ts"

/** The provider extension that `pi.provider` selects; it is always loaded. */
export const PROVIDER_PACKAGES = { "kimi-coding-global": "pi-provider-kimi-code" } as const

/** The Pi package that supplies each feature toggle of `pi.features` (the web feature aside). */
export const FEATURE_PACKAGES = {
  subagents: "@tintinweb/pi-subagents",
  contextCompression: "billion-context",
  todo: "@juicesharp/rpiv-todo",
  ask: "@juicesharp/rpiv-ask-user-question",
  processes: "@aliou/pi-processes",
  computerUse: "@amaster.ai/pi-computer-use",
} as const

/** The package that `pi.features.web` set to `pi-web-kit` loads. */
export const WEB_KIT_PACKAGE = "pi-web-kit"

/**
 * The Pi packages that must be loaded for a config, in a stable order: the provider extension, each
 * enabled feature's package in the order of {@link FEATURE_PACKAGES}, then the web kit when asked
 * for. A disabled feature is neither loaded nor required, the `provider` web mode loads nothing
 * (the provider extension supplies those tools), and with `pi.enable` off nothing is loaded.
 */
export const piPackages = (config: Config): ReadonlyArray<string> => {
  const { enable, provider, features } = config.pi
  if (!enable) return []
  return [
    PROVIDER_PACKAGES[provider],
    ...(Object.keys(FEATURE_PACKAGES) as Array<keyof typeof FEATURE_PACKAGES>)
      .filter((feature) => features[feature])
      .map((feature) => FEATURE_PACKAGES[feature]),
    ...(features.web === "pi-web-kit" ? [WEB_KIT_PACKAGE] : []),
  ]
}
