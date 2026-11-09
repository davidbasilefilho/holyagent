import { lockedFile, lockedPackages } from "./lock.ts" with { type: "macro" }

/**
 * The exact versions of the packages the setup interface installs, from `bun.lock` at build time
 * (see {@link lockedPackages}): the same versions the TUI bundle was built against.
 */
export const TUI_PACKAGES: Readonly<Record<string, string>> = lockedPackages()

/**
 * The `bun.lock` setup installs from, `--frozen-lockfile`, so the whole tree (Solid's `s-js` and
 * the native `@opentui/core-<platform>` included) resolves as the repository's lock does.
 */
export const TUI_LOCK: string = lockedFile()
