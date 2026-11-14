import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("Node Core strict lookup rejects project aliases and uses its isolated Bun config", async () => {
  const root = await mkdtemp(join(tmpdir(), "holyagent-core-shell-"))
  try {
    const host = join(root, "runner")
    await mkdir(join(host, "node_modules"), { recursive: true })
    await symlink(
      await realpath(join(import.meta.dir, "../../../node_modules/effect")),
      join(host, "node_modules", "effect"),
      "dir",
    )
    const script = join(host, "fixture.mjs")
    await copyFile(join(import.meta.dir, "node-shell-fixture.mjs"), script)
    const result = spawnSync(
      "node",
      [script, join(import.meta.dir, "../src/setup/shell.ts"), root, process.execPath],
      { encoding: "utf8", cwd: root, env: { ...process.env, HOME: root }, timeout: 20000 },
    )
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain("Node Core strict lookup and Bun config passed")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
