import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { $ } from "bun"

import { MAX_PATH_LENGTH, trackedPaths, violations } from "./repo-paths.ts"

const repoRoot = resolve(import.meta.dir, "..")

/** True when `repoRoot` is the top of a git work tree, false for a `git archive` export. */
const isWorkTreeRoot = async (): Promise<boolean> => {
  const prefix = await $`git rev-parse --show-prefix`.cwd(repoRoot).quiet().nothrow()
  return prefix.exitCode === 0 && prefix.stdout.toString().trim() === ""
}

/**
 * Builds a throwaway repository tracking `files`, runs `body` on its tracked paths, then removes
 * it.
 */
const withFixture = async (
  files: readonly string[],
  body: (paths: string[]) => void,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "repo-paths-"))
  try {
    await $`git init -q`.cwd(dir).quiet()
    for (const file of files) {
      await mkdir(dirname(join(dir, file)), { recursive: true })
      await writeFile(join(dir, file), "")
    }
    await $`git add -A`.cwd(dir).quiet()
    body(await trackedPaths(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("violations", () => {
  test("accepts a path of exactly the limit and rejects one character more", () => {
    expect(violations(["a".repeat(MAX_PATH_LENGTH)])).toEqual([])
    expect(violations(["a".repeat(MAX_PATH_LENGTH + 1)])).toHaveLength(1)
  })

  test("rejects any path under .holyagent/ and accepts lookalikes", () => {
    expect(violations([".holyagent/config.json"])).toHaveLength(1)
    expect(violations([".holyagentx/config.json", "docs/.holyagent"])).toEqual([])
  })
})

describe("a fixture repository", () => {
  test("reports a tracked path longer than the limit by name", async () => {
    const long = `${"d".repeat(60)}/${"f".repeat(61)}.txt`
    await withFixture(["ok.txt", long], (paths) => {
      const found = violations(paths)
      expect(found).toHaveLength(1)
      expect(found[0]).toContain(long)
    })
  })

  test("reports a tracked path under .holyagent/ by name", async () => {
    await withFixture(["ok.txt", ".holyagent/intents/a.json"], (paths) => {
      const found = violations(paths)
      expect(found).toHaveLength(1)
      expect(found[0]).toContain(".holyagent/intents/a.json")
    })
  })
})

describe.skipIf(!(await isWorkTreeRoot()))("this repository", () => {
  test("tracks no path over the limit and nothing under .holyagent/", async () => {
    expect(violations(await trackedPaths(repoRoot))).toEqual([])
  })
})
