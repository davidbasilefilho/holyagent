import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as filesystem from "node:fs/promises"
import { link, mkdir, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { doctor } from "../src/setup/doctor.ts"
import { installedScope, type Scope, scopeNotices } from "../src/setup/scope.ts"
import { setup } from "../src/setup/steps.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

let home: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-setup-scope-")
  home = made.directory
  remove = made.remove
  // The scope resolves the real paths of the working directory and the git top-level, and trusts
  // a top-level only when it holds a .git entry.
  await mkdir(nested(), { recursive: true })
  await mkdir(join(repo(), ".git"), { recursive: true })
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

  test.skipIf(process.platform === "win32")(
    "the record file is readable by its owner alone",
    async () => {
      await runSetup("project")
      const record = join(home, "claude", "holyagent", "setup-records.json")
      expect((await stat(record)).mode & 0o777).toBe(0o600)
    },
  )

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

  test("a recorded value that was changed stays and is reported with ~; the rest of its parent goes", async () => {
    await runSetup("project")
    const written = await readJson(projectFile())
    await write(projectFile(), {
      ...written,
      includeGitInstructions: true,
      attribution: { ...(written["attribution"] as object), commit: "Co-Authored-By: me" },
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
    expect(await readJson(projectFile())).toEqual({
      includeGitInstructions: true,
      attribution: { commit: "Co-Authored-By: me" },
      modelSettings: {
        "claude-opus-5-5": { effortLevel: "xhigh" },
        "claude-sonnet-5-5": { effortLevel: "low" },
      },
    })
  })

  test("keeps a deny entry setup did not add and drops only the ones it added", async () => {
    await runSetup("project")
    const written = await readJson(projectFile())
    await write(projectFile(), {
      ...written,
      permissions: { deny: ["Bash(rm:*)", "WebSearch", "WebFetch"], allow: ["Read"] },
    })
    const report = await runSetup("project", { undo: true })
    expect(report.lines).toContain('- permissions.deny: removed ["WebSearch","WebFetch"]')
    expect(await readJson(projectFile())).toEqual({
      permissions: { deny: ["Bash(rm:*)"], allow: ["Read"] },
    })
  })

  test("a value setup did not record adding is kept with ~, even when it equals setup's", async () => {
    // Set by the user before setup ran: the same values, but setup added none of them.
    await write(projectFile(), {
      includeGitInstructions: false,
      enabledPlugins: { "holyagent@holyagent": true },
      permissions: { deny: ["WebSearch", "WebFetch"] },
    })
    await runSetup("project")
    const report = await runSetup("project", { undo: true })
    expect(report.lines).toContain(
      "~ includeGitInstructions: kept false (setup did not record adding it; remove it by hand if you want it gone)",
    )
    expect(report.lines).toContain(
      '~ permissions.deny: kept ["WebSearch","WebFetch"] (setup did not record adding it; remove it by hand if you want it gone)',
    )
    expect(report.lines).toContain('- subagentPromptCacheTtl: removed "1h"')
    const after = await readJson(projectFile())
    expect(after).toMatchObject({
      includeGitInstructions: false,
      enabledPlugins: { "holyagent@holyagent": true },
      permissions: { deny: ["WebSearch", "WebFetch"] },
    })
    expect(after).not.toHaveProperty("subagentPromptCacheTtl")
  })

  test("a file with no record at all is left untouched and nothing is created", async () => {
    // The state of a file that earlier-version setup wrote: no record exists.
    await runSetup("project")
    await Bun.write(join(home, "claude", "holyagent", "setup-records.json"), "{}")
    const before = await Bun.file(projectFile()).text()
    const report = await runSetup("project", { undo: true })
    expect(report.lines.at(-1)).toBe("no changes")
    expect(
      report.lines.some((line) => line.startsWith("~ includeGitInstructions: kept false")),
    ).toBe(true)
    expect(await Bun.file(projectFile()).text()).toBe(before)
  })

  test("the record is per file and cleared by --undo, so a second undo changes nothing", async () => {
    await runSetup("project")
    await runSetup("local")
    await runSetup("project", { undo: true })
    expect(await readJson(projectFile())).toEqual({})
    expect(await readJson(localFile())).toMatchObject({ includeGitInstructions: false })
    // The project record is gone: values written again by hand are no longer setup's.
    await write(projectFile(), { includeGitInstructions: false })
    const again = await runSetup("project", { undo: true })
    expect(again.lines.at(-1)).toBe("no changes")
    expect(await readJson(projectFile())).toEqual({ includeGitInstructions: false })
    // The local record survived.
    expect((await runSetup("local", { undo: true })).lines.at(-1)).toBe("removed 10")
  })

  test("a record that does not decode fails the step and changes nothing", async () => {
    await runSetup("project")
    const record = join(home, "claude", "holyagent", "setup-records.json")
    await Bun.write(record, JSON.stringify({ files: {}, extra: 1 }))
    const before = await Bun.file(projectFile()).text()
    const report = await runSetup("project", { undo: true })
    expect(report.ok).toBe(false)
    expect(report.lines.some((line) => line.startsWith("! project settings: "))).toBe(true)
    expect(await Bun.file(projectFile()).text()).toBe(before)
  })

  test("a deny list holding only setup's entries is dropped with an emptied permissions object", async () => {
    await runSetup("project")
    const written = await readJson(projectFile())
    await write(projectFile(), { permissions: written["permissions"] })
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

describe("holyagent setup --scope guards", () => {
  /** A fake shell whose git names `top` as the top-level. */
  const namingTop = (top: string) =>
    fakeShell({
      commands: ["bun"],
      respond: (line) =>
        line === "git rev-parse --show-toplevel" ? { stdout: `${top}\n` } : undefined,
    })

  test("a git top-level that is not above the current directory is ignored, and the report says so", async () => {
    // A crafted core.worktree makes git name a directory the working directory is not in.
    const elsewhere = join(home, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    const report = await Effect.runPromise(
      setup(env(), options("project")).pipe(Effect.provide(namingTop(elsewhere).layer)),
    )
    expect(report.ok).toBe(true)
    expect(report.lines[1]).toBe(
      `~ project settings: git names ${elsewhere} as the top-level, which is not the current directory or an ancestor holding a .git entry; using ${nested()}`,
    )
    expect(report.lines[2]).toBe(join(nested(), ".claude", "settings.json"))
    expect(await exists(join(nested(), ".claude", "settings.json"))).toBe(true)
    expect(await readdir(elsewhere)).toEqual([])
  })

  test("a git top-level without a .git entry is ignored, even above the working directory", async () => {
    // A crafted core.worktree can name an ancestor, such as the home folder, that is no repository.
    const ancestor = join(home, "plain")
    const inside = join(ancestor, "work")
    await mkdir(inside, { recursive: true })
    const report = await Effect.runPromise(
      setup(env(), { ...options("project"), cwd: inside }).pipe(
        Effect.provide(namingTop(ancestor).layer),
      ),
    )
    expect(report.lines[1]).toBe(
      `~ project settings: git names ${ancestor} as the top-level, which is not the current directory or an ancestor holding a .git entry; using ${inside}`,
    )
    expect(await exists(join(inside, ".claude", "settings.json"))).toBe(true)
    expect(await exists(join(ancestor, ".claude", "settings.json"))).toBe(false)
  })

  test("outside a repository the report says the current directory is used", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: (line) =>
        line === "git rev-parse --show-toplevel"
          ? { exitCode: 128, stderr: "fatal: not a git repository" }
          : undefined,
    })
    const report = await Effect.runPromise(
      setup(env(), options("local")).pipe(Effect.provide(shell.layer)),
    )
    expect(report.lines[1]).toBe(`~ local settings: not inside a git repository; using ${nested()}`)
  })

  test("a git top-level that does not exist is ignored too", async () => {
    const report = await Effect.runPromise(
      setup(env(), options("local")).pipe(Effect.provide(namingTop(join(home, "missing")).layer)),
    )
    expect(report.lines[2]).toBe(join(nested(), ".claude", "settings.local.json"))
  })

  test("the git top-level may be the working directory itself", async () => {
    const report = await Effect.runPromise(
      setup(env(), { ...options("project"), cwd: repo() }).pipe(
        Effect.provide(namingTop(repo()).layer),
      ),
    )
    expect(report.lines[1]).toBe(projectFile())
  })

  test.skipIf(process.platform === "win32")(
    "a symlinked .claude folder is refused and nothing is written",
    async () => {
      const target = join(home, "target")
      await mkdir(target, { recursive: true })
      await symlink(target, join(repo(), ".claude"))
      for (const scope of ["project", "local"] as const) {
        for (const undo of [false, true]) {
          const report = await runSetup(scope, { undo })
          expect(report.ok).toBe(false)
          expect(
            report.lines.some(
              (line) =>
                line.startsWith("! ") && line.includes("is a symlink") && line.includes(".claude"),
            ),
          ).toBe(true)
        }
      }
      expect(await readdir(target)).toEqual([])
    },
  )

  test.skipIf(process.platform === "win32")(
    "a symlinked settings file is refused and its target stays as it was",
    async () => {
      const victim = join(home, "victim.json")
      await writeFile(victim, "{}")
      await mkdir(dirname(projectFile()), { recursive: true })
      await symlink(victim, projectFile())
      const report = await runSetup("project")
      expect(report.ok).toBe(false)
      expect(report.lines.some((line) => line.startsWith("! project settings: "))).toBe(true)
      expect(await Bun.file(victim).text()).toBe("{}")
      expect(await exists(userFile())).toBe(false)
    },
  )

  test.skipIf(process.platform === "win32")(
    "doctor reports a symlinked target as a failing settings check and fixes nothing",
    async () => {
      const victim = join(home, "victim.json")
      await writeFile(victim, "{}")
      await mkdir(dirname(localFile()), { recursive: true })
      await symlink(victim, localFile())
      const shell = fakeShell({
        commands: ["bun", "ctx7"],
        respond: (line) =>
          line === "git rev-parse --show-toplevel" ? { stdout: `${repo()}\n` } : undefined,
      })
      const report = await Effect.runPromise(
        doctor(env(), { fix: true, scope: "local", cwd: nested() }).pipe(
          Effect.provide(shell.layer),
        ),
      )
      expect(report.ok).toBe(false)
      expect(report.lines.find((line) => line.startsWith("FAIL settings"))).toContain(
        "is a symlink",
      )
      expect(await Bun.file(victim).text()).toBe("{}")
    },
  )

  test.skipIf(process.platform === "win32")(
    "the user scope still writes through a symlinked settings file",
    async () => {
      const real = join(home, "dotfiles", "settings.json")
      await mkdir(dirname(real), { recursive: true })
      await writeFile(real, "{}")
      await mkdir(dirname(userFile()), { recursive: true })
      await symlink(real, userFile())
      const report = await runSetup("user")
      expect(report.ok).toBe(true)
      expect(await readJson(real)).toMatchObject({ includeGitInstructions: false })
    },
  )
})

describe("holyagent doctor --scope", () => {
  test("names a refused git top-level like setup does", async () => {
    const elsewhere = join(home, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    const shell = fakeShell({
      commands: ["bun", "ctx7"],
      respond: (line) =>
        line === "git rev-parse --show-toplevel" ? { stdout: `${elsewhere}\n` } : undefined,
    })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false, scope: "project", cwd: nested() }).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect(report.lines[0]).toBe(
      `~ project settings: git names ${elsewhere} as the top-level, which is not the current directory or an ancestor holding a .git entry; using ${nested()}`,
    )
    expect(report.lines.join("\n")).toContain(
      `FAIL settings: ${join(nested(), ".claude", "settings.json")} lacks`,
    )
  })

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

describe("the default scope is user unless the local settings enable the plugin", () => {
  const enabled = { enabledPlugins: { "holyagent@holyagent": true } }
  const disabled = { enabledPlugins: { "holyagent@holyagent": false } }
  const files = () => ({ local: localFile(), project: projectFile(), user: userFile() })
  const DEFAULT = "~ scope: user (default)"
  /** The repository is a real one, so the project and local files sit in its top-level. */
  const initRepo = async () => {
    await $`git init -q ${repo()}`.quiet()
    const top = await realpath(repo())
    return {
      local: join(top, ".claude", "settings.local.json"),
      project: join(top, ".claude", "settings.json"),
      user: userFile(),
    }
  }

  test.each([
    [["local"]],
    [["local", "project"]],
    [["local", "user"]],
    [["local", "project", "user"]],
  ] as const)("setup uses local when the plugin is enabled in %p", async (where) => {
    const target = await initRepo()
    for (const scope of where) await write(files()[scope], enabled)
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    expect(result.stdout.split("\n")[0]).toBe(
      `~ scope: local (inferred: holyagent@holyagent is enabled in ${target.local})`,
    )
    expect(result.stdout).not.toContain("--scope project targets it")
    expect(await readJson(target.local)).toMatchObject({ includeGitInstructions: false })
    if (!where.some((name) => name === "project")) expect(await exists(target.project)).toBe(false)
    if (!where.some((name) => name === "user")) expect(await exists(target.user)).toBe(false)
  })

  test.each([
    ["nowhere", {}],
    ["the user settings only", { user: enabled }],
    [
      "another plugin, or not true, in the local file",
      { local: { enabledPlugins: { "other@holyagent": true } } },
    ],
  ] as const)(
    "setup uses user, with no extra line, when the plugin is enabled in %s",
    async (_name, where) => {
      const target = await initRepo()
      for (const [scope, value] of Object.entries(where)) {
        await write(files()[scope as keyof ReturnType<typeof files>], value)
      }
      const result = await cli(["setup", "--skip-ctx7"], nested())
      expect(result.code).toBe(0)
      const lines = result.stdout.split("\n")
      expect(lines[0]).toBe(DEFAULT)
      expect(lines[1]).not.toStartWith("~ scope:")
      expect(await readJson(target.user)).toMatchObject({ includeGitInstructions: false })
      expect(await exists(target.project)).toBe(false)
      expect(await readJson(target.local).catch(() => ({}))).not.toHaveProperty(
        "includeGitInstructions",
      )
    },
  )

  test("a committed project file that enables the plugin leaves the scope at user and names itself", async () => {
    const target = await initRepo()
    await write(files().project, enabled)
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(
      `~ scope: the repository enables HolyAgent in ${target.project}; --scope project targets it`,
    )
    expect(await readJson(target.project)).toEqual(enabled)
    expect(await exists(target.local)).toBe(false)
    expect(await readJson(target.user)).toMatchObject({ includeGitInstructions: false })

    const doctored = await cli(["doctor"], nested())
    expect(doctored.stdout.split("\n").slice(0, 2)).toEqual([
      "ok   scope: user (default)",
      `~ scope: the repository enables HolyAgent in ${target.project}; --scope project targets it`,
    ])
    expect(doctored.stdout).toContain(`ok   settings: ${target.user}`)
  })

  test("a tracked local file that enables the plugin leaves the scope at user and names itself", async () => {
    const target = await initRepo()
    await write(files().local, enabled)
    await $`git -C ${repo()} add -f .claude/settings.local.json`.quiet()
    const notice = `~ scope: ${target.local} enables HolyAgent but git tracks it, so it is not taken for your own uncommitted file; using user; --scope local targets it`
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(notice)
    expect(await readJson(target.local)).toEqual(enabled)
    expect(await readJson(target.user)).toMatchObject({ includeGitInstructions: false })

    const doctored = await cli(["doctor"], nested())
    expect(doctored.stdout.split("\n").slice(0, 2)).toEqual(["ok   scope: user (default)", notice])
  })

  test("a folder that is not a git work tree never infers local", async () => {
    // No repository: the scope looks in the working directory, where nothing says the file is the user's.
    const file = join(nested(), ".claude", "settings.local.json")
    await write(file, enabled)
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(
      `~ scope: ${file} enables HolyAgent but the folder is not a trusted git work tree, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    )
    expect(await readJson(file)).toEqual(enabled)
    expect(await readJson(userFile())).toMatchObject({ includeGitInstructions: false })
  })

  test("a git top-level that cannot be trusted never infers local", async () => {
    const elsewhere = join(home, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    const file = join(nested(), ".claude", "settings.local.json")
    await write(file, enabled)
    const resolved = await Effect.runPromise(
      installedScope(nested()).pipe(
        Effect.provide(
          fakeShell({
            commands: [],
            respond: (line) =>
              line === "git rev-parse --show-toplevel" ? { stdout: `${elsewhere}\n` } : undefined,
          }).layer,
        ),
      ),
    )
    expect(resolved).toMatchObject({ scope: "user", source: "default" })
    expect(scopeNotices(resolved)).toContain(
      `${file} enables HolyAgent but the folder is not a trusted git work tree, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    )
  })

  test("a git that cannot answer is treated as tracking the file", async () => {
    const file = join(repo(), ".claude", "settings.local.json")
    await write(file, enabled)
    const resolved = await Effect.runPromise(
      installedScope(nested()).pipe(
        Effect.provide(
          fakeShell({
            commands: [],
            respond: (line) =>
              line === "git rev-parse --show-toplevel"
                ? { stdout: `${repo()}\n` }
                : line.startsWith("git ls-files")
                  ? { exitCode: 128 }
                  : undefined,
          }).layer,
        ),
      ),
    )
    expect(resolved).toMatchObject({ scope: "user", source: "default" })
    expect(scopeNotices(resolved)).toEqual([
      `${file} enables HolyAgent but git could not say whether it tracks it, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    ])
  })

  test("a .claude index entry of its own never infers local", async () => {
    // A gitlink lists as the folder itself; the file's own pathspec would print nothing.
    const file = join(repo(), ".claude", "settings.local.json")
    await write(file, enabled)
    const resolved = await Effect.runPromise(
      installedScope(nested()).pipe(
        Effect.provide(
          fakeShell({
            commands: [],
            respond: (line) =>
              line === "git rev-parse --show-toplevel"
                ? { stdout: `${repo()}\n` }
                : line.startsWith("git ls-files")
                  ? { stdout: ".claude\0" }
                  : undefined,
          }).layer,
        ),
      ),
    )
    expect(scopeNotices(resolved)).toEqual([
      `${file} enables HolyAgent but git tracks .claude itself, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    ])
  })

  test("a .claude committed as a submodule never infers local", async () => {
    const target = await initRepo()
    const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com"]
    const inner = join(home, "inner")
    await mkdir(inner, { recursive: true })
    await $`git init -q ${inner}`.quiet()
    await write(join(inner, "settings.local.json"), enabled)
    await $`git -C ${inner} add .`.quiet()
    await $`git -C ${inner} ${identity} commit -q -m inner`.quiet()
    await $`git -C ${repo()} -c protocol.file.allow=always submodule add -q ${inner} .claude`.quiet()
    // The superproject has no entry for the file itself, only the gitlink.
    expect(await $`git -C ${repo()} ls-files --cached -- .claude/settings.local.json`.text()).toBe(
      "",
    )
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(
      `~ scope: ${target.local} enables HolyAgent but git tracks .claude itself, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    )
    expect(await readJson(target.user)).toMatchObject({ includeGitInstructions: false })
  })

  test("a .claude inside another git repository never infers local", async () => {
    const target = await initRepo()
    await write(files().local, enabled)
    // Untracked in the outer repository: the nested repository's files are not in its index.
    await $`git init -q ${join(repo(), ".claude")}`.quiet()
    expect(await $`git -C ${repo()} ls-files --cached -- .claude/settings.local.json`.text()).toBe(
      "",
    )
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(
      `~ scope: ${target.local} enables HolyAgent but .claude is inside another git repository, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    )
    expect(await readJson(target.user)).toMatchObject({ includeGitInstructions: false })
  })

  test("a tracked local file of another letter case never infers local", async () => {
    const target = await initRepo()
    // The literal name is untracked; where the file system ignores case it is the same file.
    await write(files().local, enabled)
    await write(join(repo(), ".claude", "Settings.Local.json"), enabled)
    await $`git -C ${repo()} add -f .claude/Settings.Local.json`.quiet()
    expect(await $`git -C ${repo()} ls-files --cached -- .claude/settings.local.json`.text()).toBe(
      "",
    )
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(
      `~ scope: ${target.local} enables HolyAgent but git tracks it, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    )
  })

  test("a tracked entry that is the same file as the local file never infers local", async () => {
    const target = await initRepo()
    // A hard link reproduces what a folding file system does: another name for the same inode.
    await write(files().local, enabled)
    await link(files().local, join(repo(), ".claude", "alias.json"))
    await $`git -C ${repo()} add -f .claude/alias.json`.quiet()
    expect(await $`git -C ${repo()} ls-files --cached -- .claude/settings.local.json`.text()).toBe(
      "",
    )
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(
      `~ scope: ${target.local} enables HolyAgent but git tracks it, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    )
  })

  test("a tracked top-level entry that is the .claude folder by identity never infers local", async () => {
    const target = await initRepo()
    await write(files().local, enabled)
    // Git lists `.claude.` apart from `.claude`, so no pathspec for the folder finds it.
    await write(join(repo(), ".claude.", "settings.local.json"), {})
    await $`git -C ${repo()} add -f .claude./settings.local.json`.quiet()
    expect(await $`git -C ${repo()} ls-files --cached -- ${":(icase,literal).claude"}`.text()).toBe(
      "",
    )
    // A folding file system (a trailing dot on Windows, an 8.3 short name, an HFS+ ignorable code
    // point) answers for the tracked name with the identity of the .claude folder. Linux cannot
    // fold names and cannot hard-link folders, so the test makes lstat answer that way.
    const original = filesystem.lstat
    const folded = join(await realpath(repo()), ".claude.")
    const spy = spyOn(filesystem, "lstat").mockImplementation(((
      ...args: Parameters<typeof filesystem.lstat>
    ) =>
      original(
        args[0] === folded ? join(dirname(folded), ".claude") : args[0],
        args[1],
      )) as typeof filesystem.lstat)
    try {
      const result = await cli(["setup", "--skip-ctx7"], nested())
      expect(result.code).toBe(0)
      const lines = result.stdout.split("\n")
      expect(lines[0]).toBe(DEFAULT)
      expect(lines[1]).toBe(
        `~ scope: ${target.local} enables HolyAgent but git tracks .claude. as .claude, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
      )
    } finally {
      spy.mockRestore()
    }
  })

  test("tracked top-level entries that are other folders leave an untracked local file inferring local", async () => {
    const target = await initRepo()
    await write(files().local, enabled)
    await write(join(repo(), "src", "index.ts"), {})
    await write(join(repo(), "README.md"), {})
    await $`git -C ${repo()} add -f src/index.ts README.md`.quiet()
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.stdout.split("\n")[0]).toBe(
      `~ scope: local (inferred: holyagent@holyagent is enabled in ${target.local})`,
    )
  })

  test("a tracked project file next to an untracked local file still infers local", async () => {
    const target = await initRepo()
    await write(files().project, {})
    await $`git -C ${repo()} add -f .claude/settings.json`.quiet()
    await write(files().local, enabled)
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.stdout.split("\n")[0]).toBe(
      `~ scope: local (inferred: holyagent@holyagent is enabled in ${target.local})`,
    )
  })

  test("an explicit false in the local file stops the search and uses user, saying so", async () => {
    const target = await initRepo()
    await write(files().local, disabled)
    await write(files().project, enabled)
    await write(files().user, enabled)
    const result = await cli(["setup", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe(DEFAULT)
    expect(lines[1]).toBe(
      `~ scope: holyagent@holyagent is set to false in ${target.local}, so HolyAgent is disabled for this project; using user`,
    )
    expect(result.stdout).not.toContain("--scope project targets it")
    expect(await readJson(target.local)).toEqual(disabled)
    expect(await readJson(target.project)).toEqual(enabled)
    expect(await readJson(target.user)).toMatchObject({ includeGitInstructions: false })

    const doctored = await cli(["doctor"], nested())
    expect(doctored.stdout.split("\n")[0]).toBe("ok   scope: user (default)")
    expect(doctored.stdout.split("\n")[1]).toBe(lines[1])
  })

  test("--undo works on the inferred local scope", async () => {
    const target = await initRepo()
    await write(files().local, {})
    await cli(["setup", "--scope", "local", "--skip-ctx7"], nested())
    const undone = await cli(["setup", "--undo"], nested())
    expect(undone.code).toBe(0)
    expect(undone.stdout.split("\n")[0]).toContain("scope: local (inferred:")
    expect(undone.stdout).toContain(target.local)
    expect(await readJson(target.local)).toEqual({})
  })

  test("an explicit --scope overrides the inferred one, in setup and in doctor", async () => {
    const target = await initRepo()
    await write(files().local, enabled)
    const result = await cli(["setup", "--scope", "user", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    expect(result.stdout.split("\n")[0]).toBe("~ scope: user (from --scope)")
    expect(await exists(target.user)).toBe(true)
    expect(await readJson(target.local)).toEqual(enabled)

    const doctored = await cli(["doctor", "--scope", "project"], nested())
    expect(doctored.stdout.split("\n")[0]).toBe("ok   scope: project (from --scope)")
    expect(doctored.stdout).toContain(target.project)
  })

  test("--scope project targets the committed file, with no notice about it", async () => {
    const target = await initRepo()
    await write(files().project, enabled)
    const result = await cli(["setup", "--scope", "project", "--skip-ctx7"], nested())
    expect(result.code).toBe(0)
    const lines = result.stdout.split("\n")
    expect(lines[0]).toBe("~ scope: project (from --scope)")
    expect(lines[1]).not.toStartWith("~ scope:")
    expect(await readJson(target.project)).toMatchObject({ includeGitInstructions: false })
    expect(await exists(target.user)).toBe(false)
  })

  test("doctor checks the settings of the inferred local scope and names it", async () => {
    const target = await initRepo()
    await write(files().local, enabled)
    const result = await cli(["doctor"], nested())
    expect(result.stdout.split("\n")[0]).toBe(
      `ok   scope: local (inferred: holyagent@holyagent is enabled in ${target.local})`,
    )
    expect(result.stdout).toContain(`FAIL settings: ${target.local} lacks`)
  })

  test("a local settings file that does not decode is an error naming it", async () => {
    const target = await initRepo()
    await mkdir(dirname(target.local), { recursive: true })
    await writeFile(target.local, "{ not json")
    const setupResult = await cli(["setup", "--skip-ctx7"], nested())
    expect(setupResult.code).toBe(1)
    expect(setupResult.stdout).toStartWith(`! scope: ${target.local} is not a JSON object`)
    const doctorResult = await cli(["doctor"], nested())
    expect(doctorResult.code).toBe(1)
    expect(doctorResult.stdout).toStartWith(`FAIL scope: ${target.local} is not a JSON object`)
    expect(await Bun.file(target.local).text()).toBe("{ not json")
  })

  test("a project file that does not decode cannot fail a bare run, and the user file is the settings step's to report", async () => {
    const target = await initRepo()
    await mkdir(dirname(target.project), { recursive: true })
    await writeFile(target.project, "{ not json")
    const bare = await cli(["setup", "--skip-ctx7"], nested())
    expect(bare.code).toBe(0)
    expect(bare.stdout.split("\n")[0]).toBe(DEFAULT)
    expect(await Bun.file(target.project).text()).toBe("{ not json")

    await writeFile(target.user, "{ not json")
    const broken = await cli(["setup", "--skip-ctx7"], nested())
    expect(broken.code).toBe(1)
    expect(broken.stdout.split("\n")[0]).toBe(DEFAULT)
    expect(broken.stdout).toContain("! user settings: ")
    expect(await Bun.file(target.user).text()).toBe("{ not json")
  })

  describe.skipIf(process.platform === "win32")("symlinks", () => {
    test("a bare run with a symlinked .claude folder installs for the user and says the folder was not read", async () => {
      const target = await initRepo()
      const linked = join(home, "linked")
      await write(join(linked, "settings.local.json"), enabled)
      await write(join(linked, "settings.json"), enabled)
      await symlink(linked, join(repo(), ".claude"))
      const result = await cli(["setup", "--skip-ctx7"], nested())
      expect(result.code).toBe(0)
      const lines = result.stdout.split("\n")
      expect(lines[0]).toBe(DEFAULT)
      expect(lines[1]).toBe(`~ scope: ${target.local} is a symlink and was not read; using user`)
      expect(await readJson(target.user)).toMatchObject({ includeGitInstructions: false })
      expect(await readJson(join(linked, "settings.local.json"))).toEqual(enabled)

      const doctored = await cli(["doctor"], nested())
      expect(doctored.stdout.split("\n")[0]).toBe("ok   scope: user (default)")
      expect(doctored.stdout).not.toContain("is a symlink; refusing")
    })

    test("a symlinked local file is not followed, and writing through it is still refused", async () => {
      const target = await initRepo()
      const victim = join(home, "victim.json")
      await write(victim, enabled)
      await mkdir(dirname(target.local), { recursive: true })
      await symlink(victim, target.local)
      const bare = await cli(["setup", "--skip-ctx7"], nested())
      expect(bare.code).toBe(0)
      expect(bare.stdout.split("\n")[0]).toBe(DEFAULT)
      expect(await exists(target.user)).toBe(true)

      const named = await cli(["setup", "--scope", "local", "--skip-ctx7"], nested())
      expect(named.code).toBe(1)
      expect(named.stdout).toContain("is a symlink; refusing to write through it")
      expect(await readJson(victim)).toEqual(enabled)
    })

    test("a symlinked .claude folder is still refused for the scope that writes into it", async () => {
      await initRepo()
      const linked = join(home, "linked")
      await mkdir(linked, { recursive: true })
      await symlink(linked, join(repo(), ".claude"))
      for (const scope of ["project", "local"]) {
        const result = await cli(["setup", "--scope", scope, "--skip-ctx7"], nested())
        expect(result.code).toBe(1)
        expect(result.stdout).toContain("is a symlink; refusing to write through it")
      }
      expect(await readdir(linked)).toEqual([])
    })
  })

  describe.skipIf(process.platform === "win32")("the Pi packages follow the same scope", () => {
    /** A `pi` on PATH, so the dry run reaches the install lines; it is never run. */
    const withPi = async () => {
      const bin = join(home, "bin")
      await mkdir(bin, { recursive: true })
      await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      return { HOLYAGENT_HOST: "pi", PATH: `${bin}:${process.env.PATH}` }
    }
    const piLines = async (extra: Record<string, string | undefined>) => {
      const result = await Effect.runPromise(
        run(["setup", "--dry-run", "--skip-ctx7"], {
          cwd: nested(),
          env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), ...extra },
          stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
        }),
      )
      return result.stdout.split("\n").filter((line) => line.includes("would install with pi "))
    }

    test("local scope installs with -l when the local file enables the plugin", async () => {
      await initRepo()
      await write(files().local, enabled)
      const lines = await piLines(await withPi())
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).toEndWith(" -l")
    })

    test("a tracked local file leaves the Pi packages global", async () => {
      await initRepo()
      await write(files().local, enabled)
      await $`git -C ${repo()} add -f .claude/settings.local.json`.quiet()
      const lines = await piLines(await withPi())
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).not.toEndWith(" -l")
    })

    test("a committed project file leaves the Pi packages global", async () => {
      await initRepo()
      await write(files().project, enabled)
      const lines = await piLines(await withPi())
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(line).not.toEndWith(" -l")
    })
  })
})
