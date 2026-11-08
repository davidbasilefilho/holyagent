import { type ProviderProfile, providerProfile, webChoice } from "../pi/provider.ts"
import { type PiPackageName, piPackageSource } from "./pi-packages.ts"
import type { Config } from "./schema.ts"

/**
 * The Pi package that supplies each feature toggle of `pi.features` that has one. The web feature
 * (see {@link WEB_KIT_PACKAGE}) and `mcp` have none: Pi's built-in MCP extension carries `mcp`, and
 * `pi.features.mcp` off starts every process with `--no-mcp` (see `toolArgs`).
 */
export const FEATURE_PACKAGES = {
  subagents: "@tintinweb/pi-subagents",
  contextCompression: "billion-context",
  todo: "@juicesharp/rpiv-todo",
  ask: "@juicesharp/rpiv-ask-user-question",
  processes: "@aliou/pi-processes",
  computerUse: "@amaster.ai/pi-computer-use",
} as const satisfies Record<string, PiPackageName>

/** The package that the `pi-web-kit` web choice loads. */
export const WEB_KIT_PACKAGE = "pi-web-kit" as const satisfies PiPackageName

/**
 * The Pi package sources that must be loaded for a config, each `npm:<name>@<version>` at its
 * pinned release ({@link piPackageSource}), in a stable order: the provider extension (the package
 * of the `pi.provider` profile, always loaded while `pi.enable` is on), each enabled feature's
 * package in the order of {@link FEATURE_PACKAGES}, then the web kit when the web choice is
 * `pi-web-kit` ({@link webChoice}: asked for, or the provider offers no web tools). A disabled
 * feature is neither loaded nor required, the web tools of a provider that offers them load no
 * package, and with `pi.enable` off nothing is loaded. The profile defaults to the selected
 * provider's; a test passes another to try a provider without web tools.
 */
export const piPackages = (
  config: Config,
  profile: ProviderProfile = providerProfile(config),
): ReadonlyArray<string> => {
  const { enable, features } = config.pi
  if (!enable) return []
  const names: ReadonlyArray<PiPackageName> = [
    profile.package,
    ...(Object.keys(FEATURE_PACKAGES) as Array<keyof typeof FEATURE_PACKAGES>)
      .filter((feature) => features[feature])
      .map((feature) => FEATURE_PACKAGES[feature]),
    ...(webChoice(profile, features.web).source === "pi-web-kit" ? [WEB_KIT_PACKAGE] : []),
  ]
  return names.map((name) => piPackageSource(name))
}
