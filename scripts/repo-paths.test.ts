import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { $ } from "bun"

/**
 * The longest tracked path, in characters. A Windows install clones the repository under
 * `%USERPROFILE%\.claude\plugins\marketplaces\<owner>-<repo>..clone\`, so a long tracked path
 * pushes the checkout past MAX_PATH (260) there.
 */
const MAX_PATH_LENGTH = 120

/** Intent state lives on the `holyagent/state` branch, so no tracked path may sit under it. */
const STATE_DIR = ".holyagent/"

const repoRoot = resolve(import.meta.dir, "..")

/** Lists the paths git tracks in `cwd`, one entry per path with no quoting (`-z`). */
const trackedPaths = async (cwd: string): Promise<string[]> => {
  const result = await $`git ls-files -z`.cwd(cwd).quiet()
  return result.stdout.toString().split("\0").filter(Boolean)
}

/** Names each path that breaks a rule: too long, or under the state directory. */
const violations = (paths: readonly string[]): string[] =>
  paths.flatMap((path) => [
    ...(path.length > MAX_PATH_LENGTH
      ? [`${path} is ${path.length} characters; the limit is ${MAX_PATH_LENGTH}`]
      : []),
    ...(path.startsWith(STATE_DIR)
      ? [`${path} is under ${STATE_DIR}, which belongs on the holyagent/state branch`]
      : []),
  ])

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
