import { $ } from "bun"

/**
 * Installs the git hooks, or says why it skips them outside a git work tree (for example a `git
 * archive` export). A script rather than shell text in `mise.toml`, so it runs the same under sh
 * and cmd. Returns the exit code.
 */
const main = async (): Promise<number> => {
  const inside = await $`git rev-parse --is-inside-work-tree`.quiet().nothrow()
  if (inside.exitCode !== 0) {
    console.log("not a git repository; skipping git hooks")
    return 0
  }
  return (await $`bunx lefthook install`.nothrow()).exitCode
}

if (import.meta.main) process.exit(await main())
