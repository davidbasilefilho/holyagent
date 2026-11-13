import pins from "./pi-packages.json" with { type: "json" }

/** The npm name of a Pi package that has a pinned release. */
export type PiPackageName = keyof typeof pins

/**
 * The exact release of every Pi package HolyAgent can enable, by npm name. `pi-packages.json` is
 * the one source of these versions: `mise run deps:update` rewrites it to the newest stable
 * release, and `mise run deps:check` fails when one is behind. A move of the `@ff-labs/pi-fff` pin
 * must recheck what `pi/fff/settings.ts` reads from the package: its tool names, settings keys and
 * native hosts.
 */
export const PI_PACKAGE_VERSIONS: Readonly<Record<PiPackageName, string>> = pins

/** The Pi package source of a package at its pinned release: `npm:<name>@<version>`. */
export const piPackageSource = (name: PiPackageName): string =>
  `npm:${name}@${PI_PACKAGE_VERSIONS[name]}`
