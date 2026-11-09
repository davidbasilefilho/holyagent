import { lockedPackages } from "./lock.ts" with { type: "macro" }

/**
 * The exact versions of the packages the setup interface installs, from `bun.lock` at build time
 * (see {@link lockedPackages}): the same versions the TUI bundle was built against.
 */
export const TUI_PACKAGES: Readonly<Record<string, string>> = lockedPackages()
