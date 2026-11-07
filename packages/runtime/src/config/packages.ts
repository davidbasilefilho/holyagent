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
 * The Pi packages that must be loaded for a config, in a stable order: the provider extension, then
 * each enabled feature's package. A disabled feature is neither loaded nor required, and the
 * `provider` web mode loads nothing, since the provider extension supplies those tools.
 */
export const piPackages = (config: Config): ReadonlyArray<string> => {
  const { provider, features } = config.pi
  return [
    PROVIDER_PACKAGES[provider],
    ...(features.subagents ? [FEATURE_PACKAGES.subagents] : []),
    ...(features.contextCompression ? [FEATURE_PACKAGES.contextCompression] : []),
    ...(features.todo ? [FEATURE_PACKAGES.todo] : []),
    ...(features.ask ? [FEATURE_PACKAGES.ask] : []),
    ...(features.web === "pi-web-kit" ? [WEB_KIT_PACKAGE] : []),
    ...(features.processes ? [FEATURE_PACKAGES.processes] : []),
    ...(features.computerUse ? [FEATURE_PACKAGES.computerUse] : []),
  ]
}
