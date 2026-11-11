import { delimiter, join } from "node:path"

import { $ } from "bun"

/**
 * Whether the repository's dev toolchain is installed under `root`: `lefthook` is a dev dependency,
 * so a consumer install (`npm install --omit=dev`, `bun install --production`) does not have it.
 * `Bun.which` applies the platform's executable extensions to the `node_modules/.bin` shim.
 */
export const hasDevToolchain = (root: string): boolean =>
  Bun.which("lefthook", { PATH: join(root, "node_modules", ".bin"), cwd: root }) !== null &&
  Bun.which("mise", {
    PATH: [join(root, "node_modules", ".bin"), process.env["PATH"] ?? ""].join(delimiter),
    cwd: root,
  }) !== null

/**
 * The root `prepare` script: runs the `prepare` mise task (the hooks setup, whose command lives in
 * `mise.toml`) when the dev toolchain is installed, and otherwise prints a note and succeeds, so a
 * consumer install of a release tag (what Pi runs) does not fail on a missing `mise`. Returns the
 * exit code.
 */
export const prepareDev = async (root: string): Promise<number> => {
  if (!hasDevToolchain(root)) {
    console.log("dev toolchain not installed; skipping git hooks")
    return 0
  }
  return (await $`bunx --no-install mise run prepare`.cwd(root).nothrow()).exitCode
}

if (import.meta.main) process.exit(await prepareDev(join(import.meta.dir, "..")))
