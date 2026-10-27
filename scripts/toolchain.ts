import { $ } from "bun"

/** Whether the text `bun --revision` prints names a canary build. */
export const isCanary = (revision: string): boolean => revision.includes("canary")

/** The revision of the Bun that runs this script, which is the one first on PATH. */
const revisionOfBun = async (): Promise<string> =>
  (await $`${process.execPath} --revision`.quiet().nothrow().text()).trim()

/**
 * Checks (`check`, the default) or ensures (`upgrade`) that Bun is a canary build, the only kind
 * with `bun check`, `bun lint` and `bun fmt`. It is a script rather than shell text in `mise.toml`,
 * so the gates run the same under sh and cmd. `check` exits 1 with the fix on a stable build.
 * `upgrade` leaves a canary alone and otherwise runs `bun upgrade --canary` with `BUN_OPTIONS`
 * removed, because Bun reads a flag such as `--smol` from it as a package name and refuses.
 */
const main = async (mode: string): Promise<number> => {
  if (mode !== "check" && mode !== "upgrade") {
    console.error(`usage: bun scripts/toolchain.ts [check|upgrade]`)
    return 2
  }
  if (isCanary(await revisionOfBun())) return 0
  if (mode === "check") {
    console.error(
      "bun is not a canary build; run: bun scripts/toolchain.ts upgrade (or `bun upgrade --canary` with BUN_OPTIONS unset)",
    )
    return 1
  }
  const env = { ...process.env, BUN_OPTIONS: undefined }
  const upgraded = await $`${process.execPath} upgrade --canary`.env(env).nothrow()
  return upgraded.exitCode
}

if (import.meta.main) process.exit(await main(process.argv[2] ?? "check"))
