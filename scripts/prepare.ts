import { lstat, readFile } from "node:fs/promises"
import { join } from "node:path"

import { $ } from "bun"

/** The former Lefthook launcher invokes its own function at the end with a fixed event name. */
export const isLegacyHook = (source: string, event: string): boolean =>
  source.startsWith("#!/bin/sh") &&
  source.includes('if [ "$LEFTHOOK_VERBOSE"') &&
  source.includes('call_lefthook run "' + event + '" "$@"')

/** Install the repository-only hk launchers; leave custom and legacy hooks untouched. */
const main = async (): Promise<number> => {
  const inside = await $`git rev-parse --is-inside-work-tree`.quiet().nothrow()
  if (inside.exitCode !== 0 || inside.text().trim() !== "true") {
    console.log("not a git repository; skipping git hooks")
    return 0
  }
  const configured = await $`git config --get core.hooksPath`.quiet().nothrow()
  if (configured.exitCode !== 1) {
    console.error(
      "Cannot install hk over a custom or unreadable core.hooksPath; see docs/development.md#git-hooks.",
    )
    return 1
  }
  const hooksDir = (await $`git rev-parse --path-format=absolute --git-path hooks`.quiet())
    .text()
    .trim()
  for (const event of ["pre-commit", "commit-msg"]) {
    const file = join(hooksDir, event)
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (stat?.isFile() && isLegacyHook(await readFile(file, "utf8"), event)) {
      console.error(
        `Found a legacy Lefthook launcher at ${file}; back it up before installing hk. See docs/development.md#git-hooks.`,
      )
      return 1
    }
  }
  const resolved = await $`mise which hk`.quiet().nothrow()
  if (resolved.exitCode !== 0) {
    console.error("The mise-managed hk is missing; run mise install, then mise run prepare.")
    return 1
  }
  return (await $`${resolved.text().trim()} install --mise`.nothrow()).exitCode
}

if (import.meta.main) process.exit(await main())
