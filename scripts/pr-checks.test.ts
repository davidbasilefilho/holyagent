import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync as createTemp, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { InvalidVersion } from "./bump-version.ts"
import {
  BranchModelViolation,
  checkBranchModel,
  checkReleaseVersion,
  checkVersionNewer,
  lookupPublished,
  type PullRequest,
  RegistryError,
  VersionNotNewer,
} from "./pr-checks.ts"

// Refuse fixtures under an existing repository, even when the system temp directory is overridden.
const mkdtempSync = (prefix: string) => {
  const dir = createTemp(prefix)
  const probe = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (probe.exitCode !== 128) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error("Fixture temp directory is inside a Git repository or Git is unavailable")
  }
  return dir
}

const rule = (pr: PullRequest) =>
  Effect.runSync(
    Effect.flip(checkBranchModel(pr)).pipe(
      Effect.map((error) => (error._tag === "BranchModelViolation" ? error.rule : error._tag)),
    ),
  )
const passes = (pr: PullRequest) =>
  Effect.runSync(Effect.exit(checkBranchModel(pr)))._tag === "Success"

describe("checkBranchModel", () => {
  test.each([
    ["dev", "main", "0.2.1"],
    ["release/0.2.1/fix/publication-repair", "main", "0.2.1"],

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
    ["release/0.2.1/fix/publication-repair-extra", "a repair look-alike"],
  ])("rejects a pull request into main from %s (%s)", (head) => {
    expect(rule({ base: "main", head, version: "0.2.1" })).toBe("main-base")
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

describe("publication repair", () => {
  const unpublished = () => Effect.succeed(false)
  const published = () => Effect.succeed(true)
  const check = (
    main: string,
    head: string,
    ref: string,
    lookup: (version: string) => Effect.Effect<boolean, RegistryError> = unpublished,
  ) => Effect.runPromise(Effect.exit(checkReleaseVersion(main, head, ref, lookup)))
  test("allows only an exact same-version repair when npm confirms it is unpublished", async () => {
    const ref = "release/0.2.1/fix/publication-repair"
    expect((await check("0.2.1", "0.2.1", ref))._tag).toBe("Success")
    expect((await check("0.2.1", "0.2.1", ref, published))._tag).toBe("Failure")
    for (const [main, head, branch] of [
      ["0.2.1", "0.2.1", "release/0.2.1/integration"],
      ["0.2.1", "0.2.1", `${ref}-extra`],
      ["0.2.1", "0.2.1", "release/0.2.0/fix/publication-repair"],
      ["0.2.1-1", "0.2.1", ref],
      ["0.2.2", "0.2.1", ref],
      ["0.2.0", "0.2.1", ref],
    ])
      expect((await check(main!, head!, branch!))._tag).toBe("Failure")
    expect((await check("0.2.0", "0.2.1", "release/0.2.1/integration"))._tag).toBe("Success")
    expect(
      (
        await check("0.2.1", "0.2.1", ref, () =>
          Effect.fail(new RegistryError({ detail: "offline" })),
        )
      )._tag,
    ).toBe("Failure")
  })

  test("validates public registry metadata and fails closed on errors and identity mismatches", async () => {
    const response =
      (body: unknown, status = 200) =>
      () =>
        Promise.resolve(new Response(JSON.stringify(body), { status }))
    expect(await Effect.runPromise(lookupPublished("0.2.1", response({}, 404)))).toBe(false)
    expect(
      await Effect.runPromise(
        lookupPublished("0.2.1", response({ name: "holyagent", version: "0.2.1" })),
      ),
    ).toBe(true)
    for (const request of [
      response({}, 401),
      response({}, 500),
      response({ name: "other", version: "0.2.1" }),
      response({ name: "holyagent", version: "0.2.0" }),
      response({}),
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve(new Response("invalid json")),
    ])
      expect((await Effect.runPromise(Effect.exit(lookupPublished("0.2.1", request))))._tag).toBe(
        "Failure",
      )
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
    expect(await run("branch-model", "main", "dev", "head")).toBe(0)
    expect(await run("branch-model", "main", "feature/x", "head")).toBe(1)
  })

  test("version exits 0 only when the head is newer than main", async () => {
    expect(await run("version", "main", "head")).toBe(0)
    expect(await run("version", "head", "head")).toBe(1)
    expect(await run("version", "head", "main")).toBe(1)
  })

  test("version CLI uses the repair head ref and registry result", async () => {
    writeFileSync(
      join(root, "mock.ts"),
      `globalThis.fetch = async (url) => {
      if (url !== "https://registry.npmjs.org/holyagent/0.2.1") throw new Error("wrong registry");
      return new Response("", { status: 404 });
    }`,
    )
    const runRepair = async (ref: string) =>
      (
        await $`bun --preload ${join(root, "mock.ts")} ${join(import.meta.dir, "pr-checks.ts")} version head head ${ref}`
          .cwd(root)
          .quiet()
          .nothrow()
      ).exitCode
    expect(await runRepair("release/0.2.1/fix/publication-repair")).toBe(0)
    expect(await runRepair("release/0.2.1/integration")).toBe(1)
    expect(await runRepair("release/0.2.1/fix/publication-repair-extra")).toBe(1)
  })

  test("an unknown command exits 1", async () => {
    expect(await run("nothing")).toBe(1)
  })
})
