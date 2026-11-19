import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("the repository linter actually executes its type-aware rules", async () => {
  const root = join(import.meta.dir, "..")
  const directory = await mkdtemp(join(tmpdir(), "holyagent-type-aware-"))
  try {
    const probe = join(directory, "probe.ts")
    await Bun.write(probe, "const run = (): Promise<number> => Promise.resolve(1)\nrun()\n")
    const result = Bun.spawnSync(
      [process.execPath, "x", "--no-install", "oxlint", "--config", ".oxlintrc.json", probe],
      { cwd: root },
    )
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString() + result.stderr.toString()).toContain("no-floating-promises")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
