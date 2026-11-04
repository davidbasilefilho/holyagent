import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { InvalidVersion } from "./bump-version.ts"
import {
  BranchModelViolation,
  checkBranchModel,
  checkVersionNewer,
  type PullRequest,
  VersionNotNewer,
} from "./pr-checks.ts"

const rule = (pr: PullRequest) =>
  Effect.runSync(Effect.flip(checkBranchModel(pr)).pipe(Effect.map(({ rule }) => rule)))
const passes = (pr: PullRequest) =>
  Effect.runSync(Effect.exit(checkBranchModel(pr)))._tag === "Success"

describe("checkBranchModel", () => {
  test.each([
    ["release/0.2.1/integration", "main", "0.2.1"],
    ["release/0.2.1/ci/release-flow", "release/0.2.1/integration", "0.2.1"],
    ["release/0.2.1/fix/a", "release/0.2.1/feat/b", "0.2.1"],
    ["release/0.2.1/integration", "release/0.2.1/ci/x", "0.2.1"],
    ["feature/x", "dev", "0.2.1"],
    ["feature/x", "feature/y", "0.2.1"],
  ])("accepts %s into %s at version %s", (head, base, version) => {
    expect(passes({ base, head, version })).toBe(true)
  })

  test.each([
    ["release/0.2.1/ci/release-flow", "release-branch into main"],
    ["feature/x", "other branch into main"],
    ["main", "main into main"],
    ["release/0.2.1/integration-2", "a look-alike of the integration branch"],
  ])("rejects a pull request into main from %s (%s)", (head) => {
    expect(rule({ base: "main", head, version: "0.2.1" })).toBe("main-base")
  })

  test("rejects a release branch whose version differs from the head's version", () => {
    expect(
      rule({ base: "release/0.2.1/integration", head: "release/0.2.1/fix/a", version: "0.2.0" }),
    ).toBe("branch-version")
    expect(rule({ base: "main", head: "release/0.2.0/integration", version: "0.2.1" })).toBe(
      "branch-version",
    )
    expect(rule({ base: "dev", head: "release/0.3.0/fix/a", version: "0.2.0" })).toBe(
      "branch-version",
    )
  })

  test.each([
    ["feature/x", "a branch outside any release"],
    ["release/0.2.0/fix/a", "a branch of another release"],
    ["main", "main"],
  ])("rejects a pull request into a release branch from %s (%s)", (head) => {
    expect(rule({ base: "release/0.2.1/integration", head, version: "0.2.0" })).toBe("release-base")
  })

  test("a failure names the rule, the branches and the reason", () => {
    const error = Effect.runSync(
      Effect.flip(checkBranchModel({ base: "main", head: "feature/x", version: "0.2.1" })),
    )
    expect(error).toBeInstanceOf(BranchModelViolation)
    expect(error.message).toContain("main-base")
    expect(error.message).toContain("feature/x")
  })
})

describe("checkVersionNewer", () => {
  const outcome = (main: string, head: string) =>
    Effect.runSync(Effect.exit(checkVersionNewer(main, head)))

  test.each([
    ["0.2.0", "0.2.1"],
    ["0.2.9", "0.3.0"],
    ["0.9.0", "0.10.0"],
    ["0.2.1", "0.2.10"],
  ])("passes when %s on main is below %s on the head", (main, head) => {
    expect(outcome(main, head)._tag).toBe("Success")
  })

  test.each([
    ["0.2.1", "0.2.1"],
    ["0.2.1", "0.2.0"],
    ["0.3.0", "0.2.9"],
    ["0.10.0", "0.9.0"],
  ])("fails when %s on main is not below %s on the head", (main, head) => {
    const error = Effect.runSync(Effect.flip(checkVersionNewer(main, head)))
    expect(error).toBeInstanceOf(VersionNotNewer)
  })

  test("fails with InvalidVersion on a version that is not 0.X.Y", () => {
    expect(Effect.runSync(Effect.flip(checkVersionNewer("0.2.0", "1.0.0")))).toBeInstanceOf(
      InvalidVersion,
    )
  })
})

describe("the command line", () => {
  let root = ""
  const manifest = (dir: string, version: string) => {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, "package.json"), `${JSON.stringify({ name: "x", version })}\n`)
  }
  const run = async (...args: string[]) => {
    const result = await $`bun ${join(import.meta.dir, "pr-checks.ts")} ${args}`
      .cwd(root)
      .quiet()
      .nothrow()
    return result.exitCode
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "holyagent-pr-checks-"))
    manifest("head", "0.2.1")
    manifest("main", "0.2.0")
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  test("branch-model exits 0 for a valid release pull request and 1 otherwise", async () => {
    expect(await run("branch-model", "main", "release/0.2.1/integration", "head")).toBe(0)
    expect(await run("branch-model", "main", "feature/x", "head")).toBe(1)
  })

  test("version exits 0 only when the head is newer than main", async () => {
    expect(await run("version", "main", "head")).toBe(0)
    expect(await run("version", "head", "head")).toBe(1)
    expect(await run("version", "head", "main")).toBe(1)
  })

  test("an unknown command exits 1", async () => {
    expect(await run("nothing")).toBe(1)
  })
})
