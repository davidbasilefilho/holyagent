import pins from "./pypi-packages.json" with { type: "json" }

/** The PyPI name of a package that has a pinned release. */
export type PypiPackageName = keyof typeof pins

/**
 * The exact release of every PyPI package HolyAgent runs, by PyPI name. `pypi-packages.json` is the
 * one source of these versions, next to the npm pins of `pi-packages.json`: `mise run deps:update`
 * rewrites it to the newest stable, non-yanked release from the PyPI JSON API, and `mise run
 * deps:check` fails when one is behind.
 */
export const PYPI_PACKAGE_VERSIONS: Readonly<Record<PypiPackageName, string>> = pins
