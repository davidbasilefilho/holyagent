import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"

const dist = join(import.meta.dir, "dist")
const rootManifest = join(import.meta.dir, "../../../package.json")
const windows = process.platform === "win32"

test("the packed npm package installs a working global launcher", async () => {
  const directory = await mkdtemp(join(tmpdir(), "holyagent npm-"))
  try {
    const git = await $`git rev-parse --show-toplevel`.cwd(directory).quiet().nothrow()
    expect(git.exitCode).toBe(128)

    const { version } = (await Bun.file(rootManifest).json()) as { readonly version: string }
    await $`bun pm pack --destination ${directory}`.cwd(dist).quiet()
    const archive = `./holyagent-${version}.tgz`

    const npm = windows ? ["cmd.exe", "/d", "/c", "npm.cmd"] : ["npm"]
    await $`${npm} install -g --prefix prefix --cache cache --offline --ignore-scripts --legacy-peer-deps --no-audit --no-fund ${archive}`
      .cwd(directory)
      .env({
        ...process.env,
        NPM_CONFIG_USERCONFIG: join(directory, "user.npmrc"),
        NPM_CONFIG_GLOBALCONFIG: join(directory, "global.npmrc"),
      })
      .quiet()

    // Invoke npm's native Windows shim, or the POSIX link that uses the packaged Bun shebang.
    const holyagent = windows
      ? ["cmd.exe", "/d", "/c", "prefix\\holyagent.cmd"]
      : [join(directory, "prefix", "bin", "holyagent")]
    const result = await $`${holyagent} --version`.cwd(directory).quiet()
    expect(result.text().trim()).toBe(version)
    const help = await $`${holyagent} setup --help`.cwd(directory).quiet()
    expect(help.text()).toContain("Configure HolyAgent for T3 Code")
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  }
}, 60_000)
