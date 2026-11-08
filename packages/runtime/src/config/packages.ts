import { PROVIDERS } from "../pi/provider.ts"
import { type PiPackageName, piPackageSource } from "./pi-packages.ts"
import type { Config } from "./schema.ts"

/** The Pi package that supplies each feature toggle of `pi.features` (the web feature aside). */
export const FEATURE_PACKAGES = {
  subagents: "@tintinweb/pi-subagents",
  contextCompression: "billion-context",
  todo: "@juicesharp/rpiv-todo",
  ask: "@juicesharp/rpiv-ask-user-question",
  processes: "@aliou/pi-processes",
  computerUse: "@amaster.ai/pi-computer-use",
} as const satisfies Record<string, PiPackageName>

/** The package that `pi.features.web` set to `pi-web-kit` loads. */
export const WEB_KIT_PACKAGE = "pi-web-kit" as const satisfies PiPackageName

/**
 * The Pi package sources that must be loaded for a config, each `npm:<name>@<version>` at its
 * pinned release ({@link piPackageSource}), in a stable order: the provider extension (the package
 * of the `pi.provider` profile, always loaded while `pi.enable` is on), each enabled feature's
 * package in the order of {@link FEATURE_PACKAGES}, then the web kit when asked for. A disabled
 * feature is neither loaded nor required, the `provider` web mode loads nothing (the provider
 * extension supplies those tools), and with `pi.enable` off nothing is loaded.
 */
export const piPackages = (config: Config): ReadonlyArray<string> => {
  const { enable, provider, features } = config.pi
  if (!enable) return []
  const names: ReadonlyArray<PiPackageName> = [
    PROVIDERS[provider].package,
    ...(Object.keys(FEATURE_PACKAGES) as Array<keyof typeof FEATURE_PACKAGES>)
      .filter((feature) => features[feature])
      .map((feature) => FEATURE_PACKAGES[feature]),
    ...(features.web === "pi-web-kit" ? [WEB_KIT_PACKAGE] : []),
  ]
  return names.map((name) => piPackageSource(name))
}
