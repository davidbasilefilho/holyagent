import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { doctor } from "../src/setup/doctor.ts"
import type { Scope } from "../src/setup/scope.ts"
import { setup } from "../src/setup/steps.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

let home: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-setup-scope-")
  home = made.directory
  remove = made.remove
})
afterEach(() => remove())

const repo = () => join(home, "repo")
const nested = () => join(repo(), "packages", "app")
const userFile = () => join(home, "claude", "settings.json")
const projectFile = () => join(repo(), ".claude", "settings.json")
const localFile = () => join(repo(), ".claude", "settings.local.json")

const env = (extra: Record<string, string> = {}) => ({
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  ...extra,
})

const write = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value))
}
const readJson = async (file: string) => (await Bun.file(file).json()) as Record<string, unknown>
const exists = (file: string) => Bun.file(file).exists()

/** A fake shell whose `git rev-parse --show-toplevel` answers with the repository folder. */
const insideRepo = () =>
  fakeShell({
    commands: ["bun"],
    respond: (line) =>
      line === "git rev-parse --show-toplevel" ? { stdout: `${repo()}\n` } : undefined,
  })

const options = (scope: Scope, extra: { undo?: boolean; dryRun?: boolean } = {}) => ({
  scope,
  cwd: nested(),
  subagentCacheTtl: "1h" as const,
  dryRun: false,
  skipCtx7: true,
  ...extra,
})

const runSetup = (scope: Scope, extra: { undo?: boolean; dryRun?: boolean } = {}) =>
  Effect.runPromise(setup(env(), options(scope, extra)).pipe(Effect.provide(insideRepo().layer)))

describe("holyagent setup --scope", () => {
  test("user writes the user settings, as before", async () => {
    const report = await runSetup("user")
    expect(report.ok).toBe(true)
    expect(report.lines[0]).toBe("- ctx7: skipped by flag")
    expect(report.lines[1]).toBe(userFile())
    expect(await exists(userFile())).toBe(true)
    expect(await exists(projectFile())).toBe(false)
    expect(await exists(localFile())).toBe(false)
  })

  test("project writes .claude/settings.json in the git top-level, with every key", async () => {
    const report = await runSetup("project")
    expect(report.ok).toBe(true)
    expect(report.lines[1]).toBe(projectFile())
    const written = await readJson(projectFile())
    expect(written).toMatchObject({
      includeGitInstructions: false,
      modelSettings: { "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: 450000 } },
      extraKnownMarketplaces: { holyagent: { source: { source: "github" } } },
      enabledPlugins: { "holyagent@holyagent": true },
      permissions: { deny: ["WebSearch", "WebFetch"] },
    })
    expect(await exists(userFile())).toBe(false)
    expect(await exists(localFile())).toBe(false)
  })

  test("local writes .claude/settings.local.json in the git top-level", async () => {
    const report = await runSetup("local")
    expect(report.ok).toBe(true)
    expect(report.lines[1]).toBe(localFile())
    expect(await readJson(localFile())).toMatchObject({
      enabledPlugins: { "holyagent@holyagent": true },
    })
    expect(await exists(userFile())).toBe(false)
    expect(await exists(projectFile())).toBe(false)
  })

  test("project and local never overwrite a value already set", async () => {
    await write(projectFile(), { includeGitInstructions: true, permissions: { deny: ["Bash"] } })
    const report = await runSetup("project")
    expect(report.lines).toContain("~ includeGitInstructions: kept true (recommended false)")
    expect(report.lines).toContain(
      '~ permissions.deny: kept ["Bash"] (recommended ["WebSearch","WebFetch"])',
    )
    expect(await readJson(projectFile())).toMatchObject({
      includeGitInstructions: true,
      permissions: { deny: ["Bash"] },
    })
  })

  test("outside a repository the current directory holds .claude", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: (line) =>
        line === "git rev-parse --show-toplevel"
          ? { exitCode: 128, stderr: "fatal: not a git repository" }
          : undefined,
    })
    await mkdir(nested(), { recursive: true })
    await Effect.runPromise(setup(env(), options("project")).pipe(Effect.provide(shell.layer)))
    expect(await exists(join(nested(), ".claude", "settings.json"))).toBe(true)
    expect(await exists(projectFile())).toBe(false)
  })

  test("--dry-run writes nothing in a project scope", async () => {
    const report = await runSetup("project", { dryRun: true })
    expect(report.lines.at(-1)).toMatch(/^dry run: would add \d+, nothing written$/)
    expect(await exists(projectFile())).toBe(false)
  })
})

describe("holyagent setup --undo", () => {
  test("removes what setup wrote and leaves the rest, in the chosen scope only", async () => {
    await runSetup("user")
    await runSetup("project")
    await write(projectFile(), { ...(await readJson(projectFile())), theme: "dark" })
    const report = await runSetup("project", { undo: true })
    expect(report.ok).toBe(true)
    expect(report.lines).toContain("- includeGitInstructions: removed false")
    expect(report.lines).toContain('- permissions.deny: removed ["WebSearch","WebFetch"]')
    expect(report.lines.at(-1)).toBe("removed 10")
    // Every parent setup filled is dropped; the user's own key stays.
    expect(await readJson(projectFile())).toEqual({ theme: "dark" })
    // The user scope still holds its keys.
    expect(await readJson(userFile())).toMatchObject({ includeGitInstructions: false })
  })

  test("a value that differs stays and is reported with ~; the rest of its parent goes", async () => {
    await write(projectFile(), {
      includeGitInstructions: true,
      subagentPromptCacheTtl: "1h",
      attribution: { commit: "Co-Authored-By: me", pr: "", sessionUrl: false },
      modelSettings: {
        "claude-opus-5-5": { effortLevel: "xhigh", autoCompactWindow: 450000 },
        "claude-sonnet-5-5": { effortLevel: "low" },
      },
    })
    const report = await runSetup("project", { undo: true })
    expect(report.lines).toContain("~ includeGitInstructions: kept true (setup writes false)")
    expect(report.lines).toContain(
      '~ modelSettings.claude-opus-5-5.effortLevel: kept "xhigh" (setup writes "high")',
    )
    expect(report.lines).toContain(
      "- modelSettings.claude-opus-5-5.autoCompactWindow: removed 450000",
    )
    expect(report.lines).toContain('- subagentPromptCacheTtl: removed "1h"')
    expect(report.lines).toContain("= enabledPlugins.holyagent@holyagent: nothing to remove")
    expect(await readJson(projectFile())).toEqual({
      includeGitInstructions: true,
      attribution: { commit: "Co-Authored-By: me" },
      modelSettings: {
        "claude-opus-5-5": { effortLevel: "xhigh" },
        "claude-sonnet-5-5": { effortLevel: "low" },
      },
    })
  })

  test("keeps a pre-existing deny entry and drops only WebSearch and WebFetch", async () => {
    await write(projectFile(), {
      permissions: { deny: ["Bash(rm:*)", "WebSearch", "WebFetch"], allow: ["Read"] },
    })
    const report = await runSetup("project", { undo: true })
    expect(report.lines).toContain('- permissions.deny: removed ["WebSearch","WebFetch"]')
    expect(await readJson(projectFile())).toEqual({
      permissions: { deny: ["Bash(rm:*)"], allow: ["Read"] },
    })
  })

  test("a deny list holding only setup's entries is dropped with an emptied permissions object", async () => {
    await write(projectFile(), { permissions: { deny: ["WebSearch"] } })
    await runSetup("project", { undo: true })
    expect(await readJson(projectFile())).toEqual({})
  })

  test("--dry-run reports the removals and writes nothing", async () => {
    await runSetup("local")
    const before = await Bun.file(localFile()).text()
    const report = await runSetup("local", { undo: true, dryRun: true })
    expect(report.lines.at(-1)).toBe("dry run: would remove 10, nothing written")
    expect(await Bun.file(localFile()).text()).toBe(before)
  })

  test("leaves ctx7 alone and creates no file when there is nothing to remove", async () => {
    const shell = insideRepo()
    const report = await Effect.runPromise(
      setup(env(), { ...options("user", { undo: true }), skipCtx7: false }).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect(shell.calls).toEqual([])
    expect(report.lines[0]).toMatch(/^~ ctx7: left installed/)
    expect(report.lines.at(-1)).toBe("no changes")
    expect(await exists(userFile())).toBe(false)
  })

  test("undoing the user scope removes the same set that setup added", async () => {
    await runSetup("user")
    const report = await runSetup("user", { undo: true })
    expect(report.lines.at(-1)).toBe("removed 10")
    expect(await readJson(userFile())).toEqual({})
  })

  test("a settings file that is not an object fails the step and stays untouched", async () => {
    await mkdir(dirname(projectFile()), { recursive: true })
    await writeFile(projectFile(), "[1]")
    const report = await runSetup("project", { undo: true })
    expect(report.ok).toBe(false)
    expect(report.lines.some((line) => line.startsWith("! project settings: "))).toBe(true)
    expect(await Bun.file(projectFile()).text()).toBe("[1]")
  })
})

describe("holyagent doctor --scope", () => {
  test("checks the file of the scope and --fix merges into it", async () => {
    const shell = fakeShell({
      commands: ["bun", "ctx7"],
      respond: (line) =>
        line === "git rev-parse --show-toplevel" ? { stdout: `${repo()}\n` } : undefined,
    })
    const check = (fix: boolean) =>
      Effect.runPromise(
        doctor(env(), { fix, scope: "project", cwd: nested() }).pipe(Effect.provide(shell.layer)),
      )
    const failing = await check(false)
    expect(failing.ok).toBe(false)
    expect(failing.lines.find((line) => line.startsWith("FAIL settings"))).toContain(
      `${projectFile()} lacks`,
    )
    expect(failing.lines.join("\n")).toContain("--scope project")
    const fixed = await check(true)
    expect(fixed.ok).toBe(true)
    expect(fixed.lines).toContain(`ok   settings: ${projectFile()}`)
    expect(await exists(userFile())).toBe(false)
  })
})

/** Runs one command line in-process from `cwd`; the config folder is a temp folder. */
const cli = (argv: ReadonlyArray<string>, cwd: string) =>
  Effect.runPromise(
    run(argv, {
      cwd,
      env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), PATH: process.env.PATH },
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
    }),
  )

describe("--scope as a command flag", () => {
  test("rejects a scope that is not user, project or local, and writes nothing", async () => {
    const result = await cli(["setup", "--scope", "global", "--skip-ctx7"], home)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Invalid value for --scope: global")
    expect(result.stderr).toContain("--scope user|project|local")
    expect(await exists(userFile())).toBe(false)
    expect((await cli(["doctor", "--scope", "everywhere"], home)).code).not.toBe(0)
  })

  test("finds the git top-level from a nested directory, then --undo backs it out", async () => {
    await mkdir(nested(), { recursive: true })
    await $`git init -q ${repo()}`.quiet()
    // Git names the real path, which differs from the temp path where a temp folder is a link.
    const file = join(await realpath(repo()), ".claude", "settings.json")
    const added = await cli(["setup", "--scope", "project", "--skip-ctx7"], nested())
    expect(added.code).toBe(0)
    expect(added.stdout).toContain(`${file}\n`)
    expect(await exists(file)).toBe(true)
    expect(await exists(join(nested(), ".claude", "settings.json"))).toBe(false)
    expect(await exists(userFile())).toBe(false)

    const undone = await cli(["setup", "--scope", "project", "--undo"], nested())
    expect(undone.code).toBe(0)
    expect(undone.stdout).toEndWith("removed 10\n")
    expect(await readJson(file)).toEqual({})
  })

  test("the default scope is user", async () => {
    const result = await cli(["setup", "--skip-ctx7"], home)
    expect(result.code).toBe(0)
    expect(await exists(userFile())).toBe(true)
  })
})
