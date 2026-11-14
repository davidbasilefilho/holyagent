import { type ProviderProfile, providerProfile, PROVIDERS, webChoice } from "../pi/provider.ts"
import {
  CAPABILITIES,
  type CapabilityDefinition,
  type CapabilityForm,
  capabilityPackages,
} from "./capabilities.ts"
import { type PiPackageName, piPackageSource } from "./pi-packages.ts"
import type { Config } from "./schema.ts"

/** The package that the `pi-web-kit` web choice loads. */
export const WEB_KIT_PACKAGE = "pi-web-kit" as const satisfies PiPackageName

/**
 * The Pi package sources that must be loaded for a config, each `npm:<name>@<version>` at its
 * pinned release ({@link piPackageSource}), in a stable order: the provider extension (the package
 * of the `pi.provider` profile, always loaded while `pi.enable` is on; Codex has none), the
 * packages of each enabled capability in the order of the registry (`CAPABILITIES`) that the `form`
 * offers, then the web kit when the web choice is `pi-web-kit` ({@link webChoice}: asked for, or
 * the provider offers no web tools). A disabled capability is neither loaded nor required, and
 * neither is one the form does not offer (computer use in the headless form); the web tools of a
 * provider that offers them load no package, and with `pi.enable` off nothing is loaded. The
 * profile defaults to the selected provider's, and the form to `normal`; a test passes another of
 * either, or its own `definitions`. A capability whose native library does not cover the `platform`
 * (the machine's by default) is not offered either, so its package is neither loaded nor required
 * there.
 */
export const piPackages = (
  config: Config,
  profile: ProviderProfile = providerProfile(config),
  form: CapabilityForm = "normal",
  definitions: ReadonlyArray<CapabilityDefinition> = CAPABILITIES,
  platform?: string,
): ReadonlyArray<string> => {
  const { enable, features } = config.pi
  if (!enable) return []
  const names: ReadonlyArray<PiPackageName> = [
    ...new Set(
      [
        profile.package,
        ...Object.values(config.pi.routes).map(
          (row) => PROVIDERS[row.provider ?? config.pi.provider].package,
        ),
      ].filter((name): name is PiPackageName => name !== undefined),
    ),
    ...capabilityPackages(features, form, definitions, platform),
    ...(webChoice(profile, features.web).source === "pi-web-kit" ? [WEB_KIT_PACKAGE] : []),
  ]
  return names.map((name) => piPackageSource(name))
}
