import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { doctor } from "../src/setup/doctor.ts"
import { EMPTY_BUNFIG } from "../src/setup/shell.ts"
import { setup, type SetupOptions } from "../src/setup/steps.ts"
import { fakeShell, scratch, writeCompleteSettings } from "./setup-fixture.ts"

/** The command line of a global install: no env file, the plugin's empty config, then the add. */
const bunAdd = (packageName: string) =>
  `bun --no-env-file --config=${EMPTY_BUNFIG} add -g ${packageName}`

const BOTH: SetupOptions = {
  subagentCacheTtl: "1h",
  dryRun: false,
  skipCtx7: false,
}

let home: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-setup-")
  home = made.directory
  remove = made.remove
})
afterEach(() => remove())

const claudeDirectory = () => join(home, ".claude")
const settingsFile = () => join(claudeDirectory(), "settings.json")

const write = async (relative: string, content: string) => {
  const file = join(home, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}
const read = (file: string) => Bun.file(file).text()
const readJson = async (file: string) => JSON.parse(await read(file)) as Record<string, unknown>

/** The artifacts of the Context7 skill. */
const markCtx7Skill = () =>
  Promise.all([
    write(".claude/skills/find-docs/SKILL.md", "x"),
    write(".claude/rules/context7.md", "x"),
  ])

const env = (extra: Record<string, string> = {}) => ({ HOME: home, ...extra })

/** Files under a directory, by relative path; nothing when it does not exist. */
const tree = (directory: string) =>
  readdir(directory, { recursive: true }).catch(() => [] as Array<string>)

const SETTINGS_KEYS = [
  "attribution.commit",
  "attribution.pr",
  "attribution.sessionUrl",
  "includeGitInstructions",
  "subagentPromptCacheTtl",
  "extraKnownMarketplaces.holyagent",
  "enabledPlugins.holyagent@holyagent",
  "permissions.deny",
]

describe("holyagent setup", () => {
  test("on a fresh machine installs ctx7 and merges the user settings, with no Billion Context to remove", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(shell.layer)))
    expect(shell.lines()).toEqual([bunAdd("ctx7")])
    expect(report.ok).toBe(true)
    expect(report.lines).toContain("= billion-context: no leftovers")
    expect(report.lines.filter((line) => line.startsWith("- "))).toEqual([
      "- ctx7 skill: no CONTEXT7_API_KEY and no saved login; run `ctx7 login` or export CONTEXT7_API_KEY, then re-run",
    ])
    for (const key of SETTINGS_KEYS) {
      expect(report.lines.some((line) => line.startsWith(`+ ${key}:`))).toBe(true)
    }
    const settings = await readJson(settingsFile())
    expect(settings.includeGitInstructions).toBe(false)
    expect(settings.subagentPromptCacheTtl).toBe("1h")
    expect(settings.enabledPlugins).toEqual({ "holyagent@holyagent": true })
    expect(settings.permissions).toEqual({ deny: ["WebSearch", "WebFetch"] })
  })

  test("every child runs from the home directory, and bun add -g reads no env file and only the empty config", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    await Effect.runPromise(
      setup(env({ CONTEXT7_API_KEY: "ctx7sk-test" }), BOTH).pipe(Effect.provide(shell.layer)),
    )
    expect(shell.calls.map((call) => call.command)).toEqual(["bun", "ctx7"])
    for (const call of shell.calls) expect(call.cwd).toBe(home)
    for (const call of shell.calls.filter((entry) => entry.command === "bun"))
      expect(call.args.slice(0, 3)).toEqual(["--no-env-file", `--config=${EMPTY_BUNFIG}`, "add"])
  })

  test("a second run with everything in place prints only = lines and changes nothing", async () => {
    await markCtx7Skill()
    const first = fakeShell({ commands: ["bun", "ctx7"] })
    const run1 = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(first.layer)))
    expect(run1.ok).toBe(true)
    const settingsAfterFirst = await read(settingsFile())

    const second = fakeShell({ commands: ["bun", "ctx7"] })
    const run2 = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(second.layer)))
    expect(second.calls).toEqual([])
    expect(run2.ok).toBe(true)
    expect(run2.lines.filter((line) => /^[+!~-] /.test(line))).toEqual([])
    expect(run2.lines.filter((line) => line.startsWith("= "))).toHaveLength(
      SETTINGS_KEYS.length + 3,
    )
    expect(run2.lines.at(-1)).toBe("no changes")
    expect(await read(settingsFile())).toBe(settingsAfterFirst)
  })

  test("never changes a user setting that is already set, and keeps the keys it does not know", async () => {
    await write(
      ".claude/settings.json",
      JSON.stringify({
        theme: "dark",
        includeGitInstructions: true,
        subagentPromptCacheTtl: "5m",
        attribution: { commit: "Co-Authored-By: me" },
        permissions: { deny: ["Bash(rm:*)"], allow: ["Read"] },
        enabledPlugins: { "other@market": true },
      }),
    )
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await Effect.runPromise(
      setup(env(), { ...BOTH, skipCtx7: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(true)
    const settings = await readJson(settingsFile())
    expect(settings).toMatchObject({
      theme: "dark",
      includeGitInstructions: true,
      subagentPromptCacheTtl: "5m",
      attribution: { commit: "Co-Authored-By: me", pr: "", sessionUrl: false },
      permissions: { deny: ["Bash(rm:*)"], allow: ["Read"] },
      enabledPlugins: { "other@market": true, "holyagent@holyagent": true },
    })
    expect(report.lines).toContain("~ includeGitInstructions: kept true (recommended false)")
    expect(report.lines).toContain('~ subagentPromptCacheTtl: kept "5m" (recommended "1h")')
  })

  test("--subagent-cache-ttl 5m sets that value", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    await Effect.runPromise(
      setup(env(), { ...BOTH, subagentCacheTtl: "5m", skipCtx7: true }).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect((await readJson(settingsFile())).subagentPromptCacheTtl).toBe("5m")
  })

  test("reads the user settings from CLAUDE_CONFIG_DIR when it is set", async () => {
    const configured = join(home, "elsewhere")
    const shell = fakeShell({ commands: ["bun"] })
    await Effect.runPromise(
      setup(env({ CLAUDE_CONFIG_DIR: configured }), { ...BOTH, skipCtx7: true }).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect(await Bun.file(join(configured, "settings.json")).exists()).toBe(true)
    expect(await Bun.file(settingsFile()).exists()).toBe(false)
  })

  test("--dry-run says what it would do and writes and runs nothing", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      setup(env({ CONTEXT7_API_KEY: "ctx7sk-test" }), { ...BOTH, dryRun: true }).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect(shell.calls).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.lines).toContain("= billion-context: no leftovers")
    expect(report.lines).toContain("+ ctx7: would install with bun add -g ctx7")
    expect(report.lines).toContain("+ ctx7 skill: would install with ctx7 setup --cli --claude")
    expect(report.lines.at(-1)).toBe(`dry run: would add ${SETTINGS_KEYS.length}, nothing written`)
    expect(await tree(home)).toEqual([])
  })

  test("a failed step prints ! and the later steps still run; the report is not ok", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: (line) =>
        line === bunAdd("ctx7") ? { exitCode: 1, stderr: "network down\nmore" } : undefined,
    })
    const report = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(shell.layer)))
    expect(report.ok).toBe(false)
    expect(report.lines).toContain("! bun add -g ctx7: failed (exit 1): network down")
    expect(report.lines.at(-1)).toBe(`added ${SETTINGS_KEYS.length}`)
    expect(await Bun.file(settingsFile()).exists()).toBe(true)
  })

  test("a failed Billion Context removal is reported and ctx7 and the settings still follow", async () => {
    await write(
      ".claude/plugins/installed_plugins.json",
      JSON.stringify({ plugins: { "billion-context@billion-context": [{}] } }),
    )
    const shell = fakeShell({
      commands: ["bun", "claude"],
      respond: (line) =>
        line.startsWith("claude plugin uninstall") ? { exitCode: 2, stdout: "in use" } : undefined,
    })
    const report = await Effect.runPromise(
      setup(env({ CONTEXT7_API_KEY: "ctx7sk-test" }), BOTH).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines).toContain(
      "! billion-context: claude plugin uninstall billion-context@billion-context failed (exit 2): in use",
    )
    expect(shell.lines()).toContain("ctx7 setup --cli --claude --yes --api-key ctx7sk-test")
    expect(await Bun.file(settingsFile()).exists()).toBe(true)
  })

  test("a settings file that is not a JSON object is reported and left exactly as it was", async () => {
    await write(".claude/settings.json", "[1]")
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(shell.layer)))
    expect(report.ok).toBe(false)
    expect(report.lines.find((line) => line.startsWith("! user settings"))).toContain(
      "is not a JSON object",
    )
    expect(await read(settingsFile())).toBe("[1]")
    expect(shell.lines()).toContain(bunAdd("ctx7"))
  })

  test("removes what an earlier Billion Context setup left, and --dry-run only lists it", async () => {
    const proxy = "http://127.0.0.1:18787/bili/https://api.anthropic.com"
    await write(
      ".claude/settings.json",
      JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: proxy } }),
    )
    const shell = () => fakeShell({ commands: ["bun", "claude"] })
    const skip = { ...BOTH, skipCtx7: true }

    const dry = await Effect.runPromise(
      setup(env(), { ...skip, dryRun: true }).pipe(Effect.provide(shell().layer)),
    )
    expect(dry.lines).toContain(
      `+ billion-context: would remove env.ANTHROPIC_BASE_URL from ${settingsFile()}`,
    )
    expect((await readJson(settingsFile())).env).toBeDefined()

    const real = await Effect.runPromise(setup(env(), skip).pipe(Effect.provide(shell().layer)))
    expect(real.ok).toBe(true)
    expect(real.lines).toContain(
      `+ billion-context: removed env.ANTHROPIC_BASE_URL from ${settingsFile()}`,
    )
    const settings = await readJson(settingsFile())
    expect(settings.theme).toBe("dark")
    expect(settings.env).toBeUndefined()
    expect(settings.includeGitInstructions).toBe(false)
  })

  test("the skip flag leaves ctx7 alone", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      setup(env(), { ...BOTH, skipCtx7: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(shell.calls).toEqual([])
    expect(report.lines).toContain("- ctx7: skipped by flag")
  })

  describe("the ctx7 skill", () => {
    const options = BOTH
    const setupLine = (lines: ReadonlyArray<string>) =>
      lines.find((line) => line.startsWith("ctx7 setup"))

    test("uses CONTEXT7_API_KEY when set", async () => {
      const shell = fakeShell({ commands: ["bun", "ctx7"] })
      await Effect.runPromise(
        setup(env({ CONTEXT7_API_KEY: "ctx7sk-test" }), options).pipe(Effect.provide(shell.layer)),
      )
      expect(setupLine(shell.lines())).toBe("ctx7 setup --cli --claude --yes --api-key ctx7sk-test")
    })

    test("uses a saved login when there is no key", async () => {
      await write(".config/context7/credentials.json", "{}")
      const shell = fakeShell({ commands: ["bun", "ctx7"] })
      await Effect.runPromise(setup(env(), options).pipe(Effect.provide(shell.layer)))
      expect(setupLine(shell.lines())).toBe("ctx7 setup --cli --claude --yes")
    })

    test("is skipped with a hint when there is neither, and an empty key counts as unset", async () => {
      const shell = fakeShell({ commands: ["bun", "ctx7"] })
      const report = await Effect.runPromise(
        setup(env({ CONTEXT7_API_KEY: "" }), options).pipe(Effect.provide(shell.layer)),
      )
      expect(setupLine(shell.lines())).toBeUndefined()
      expect(report.ok).toBe(true)
      expect(report.lines.find((line) => line.startsWith("- ctx7 skill"))).toContain(
        "no CONTEXT7_API_KEY",
      )
    })

    test("a failing ctx7 setup is a ! line", async () => {
      const shell = fakeShell({
        commands: ["bun", "ctx7"],
        respond: (line) =>
          line.startsWith("ctx7 setup") ? { exitCode: 1, stderr: "denied" } : undefined,
      })
      const report = await Effect.runPromise(
        setup(env({ CONTEXT7_API_KEY: "k" }), options).pipe(Effect.provide(shell.layer)),
      )
      expect(report.ok).toBe(false)
      expect(report.lines).toContain("! ctx7 setup: failed (exit 1): denied")
    })
  })

  test("in a claude.ai cloud session skips ctx7 with a - line and still merges the settings", async () => {
    const shell = fakeShell({ commands: [] })
    const report = await Effect.runPromise(
      setup(env({ CLAUDE_CODE_REMOTE: "true" }), BOTH).pipe(Effect.provide(shell.layer)),
    )
    expect(shell.calls).toEqual([])
    expect(report.ok).toBe(true)
    const skipped = report.lines.filter((line) => line.startsWith("- "))
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toStartWith("- ctx7: skipped in a claude.ai cloud session")
    expect(Object.keys(await readJson(settingsFile())).toSorted()).toEqual([
      "attribution",
      "enabledPlugins",
      "extraKnownMarketplaces",
      "includeGitInstructions",
      "permissions",
      "subagentPromptCacheTtl",
    ])
  })
})

describe("holyagent doctor", () => {
  test("passes when bun, ctx7 and the settings keys are in place and no Billion Context is left", async () => {
    await writeCompleteSettings(claudeDirectory())
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(true)
    expect(report.lines).toEqual([
      "ok   bun: /fake/bin/bun",
      "ok   ctx7: /fake/bin/ctx7",
      `ok   settings: ${settingsFile()}`,
      "ok   billion-context: no leftovers from an earlier setup",
    ])
    expect(shell.calls).toEqual([])
  })

  test("finds ctx7 in Bun's bin directory as setup does, with a PATH hint", async () => {
    await writeCompleteSettings(claudeDirectory())
    const shell = fakeShell({ commands: ["bun"], bunBinCommands: ["ctx7"] })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(true)
    expect(report.lines[1]).toBe(
      "ok   ctx7: /fake/.bun/bin/ctx7 (not on PATH; add its directory to PATH)",
    )
    expect(shell.calls).toEqual([])
  })

  test("an empty settings.json counts as an empty object: doctor names the missing keys, --fix fills them", async () => {
    await mkdir(claudeDirectory(), { recursive: true })
    await writeFile(settingsFile(), "")
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const before = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    expect(before.lines.find((line) => line.startsWith("FAIL settings"))).toContain(
      "lacks attribution.commit",
    )
    const fixed = await Effect.runPromise(
      doctor(env(), { fix: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(fixed.ok).toBe(true)
    expect((await readJson(settingsFile())).subagentPromptCacheTtl).toBe("1h")
  })

  test("fails on each missing piece, checks the user settings, and has no plugin or canary check", async () => {
    const shell = fakeShell({ commands: [] })
    const cwdSettings = join(process.cwd(), ".claude", "settings.json")
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines.map((line) => line.slice(0, 10))).toEqual([
      "FAIL bun: ",
      "FAIL ctx7:",
      "FAIL setti",
      "ok   billi",
    ])
    expect(report.lines[2]).toContain(settingsFile())
    expect(report.lines[2]).not.toContain(cwdSettings)
    expect(report.lines[2]).toContain("lacks attribution.commit")
    expect(report.lines.join("\n")).not.toMatch(/plugin list|canary|marketplace add/i)
    expect(shell.calls).toEqual([])
  })

  test("a settings file that is not a JSON object is a failing line", async () => {
    await write(".claude/settings.json", "[1]")
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines.find((line) => line.startsWith("FAIL settings"))).toContain(
      "is not a JSON object",
    )
    expect(await read(settingsFile())).toBe("[1]")
  })

  test("--fix runs the missing setup steps, then checks again", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      doctor(env({ CONTEXT7_API_KEY: "ctx7sk-test" }), { fix: true }).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect(shell.lines()).toEqual([
      bunAdd("ctx7"),
      "ctx7 setup --cli --claude --yes --api-key ctx7sk-test",
    ])
    expect(report.ok).toBe(true)
    expect(report.lines.slice(-4)).toEqual([
      "ok   bun: /fake/bin/bun",
      "ok   ctx7: /fake/bin/ctx7",
      `ok   settings: ${settingsFile()}`,
      "ok   billion-context: no leftovers from an earlier setup",
    ])
  })

  test("--fix runs only the steps behind a failing check", async () => {
    await writeCompleteSettings(claudeDirectory())
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      doctor(env({ CONTEXT7_API_KEY: "k" }), { fix: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(shell.lines().every((line) => line.includes("ctx7"))).toBe(true)
    expect(report.ok).toBe(true)
  })

  test("--fix that cannot fix a thing still exits not ok and says which", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: (line) =>
        line.includes(" add -g ") ? { exitCode: 1, stderr: "offline" } : undefined,
    })
    const report = await Effect.runPromise(
      doctor(env(), { fix: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines).toContain("! bun add -g ctx7: failed (exit 1): offline")
    expect(report.lines.filter((line) => line.startsWith("FAIL "))).toHaveLength(1)
  })

  test("in a cloud session ctx7 passes by design and --fix only merges the settings", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      doctor(env({ CLAUDE_CODE_REMOTE: "true" }), { fix: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(shell.calls).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.lines.filter((line) => line.includes("by design"))).toHaveLength(1)
    expect(await Bun.file(settingsFile()).exists()).toBe(true)
  })

  test("warns, without failing, when Billion Context leftovers remain, and says how to clear them", async () => {
    await writeCompleteSettings(claudeDirectory())
    const settings = await readJson(settingsFile())
    await writeFile(
      settingsFile(),
      JSON.stringify({
        ...settings,
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:18787/bili/https://api.anthropic.com" },
      }),
    )
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    const line = report.lines.find((entry) => entry.startsWith("warn billion-context"))
    expect(line).toContain("env.ANTHROPIC_BASE_URL")
    expect(line).toEndWith("run /holyagent:setup")
    expect(report.ok).toBe(true)
    expect(shell.calls).toEqual([])
  })

  test("warns that it could not check when a Claude Code file cannot be read, instead of saying no leftovers", async () => {
    await writeCompleteSettings(claudeDirectory())
    await write(".claude/plugins/installed_plugins.json", "not json")
    await write(".claude/plugins/known_marketplaces.json", "[]")
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    const line = report.lines.find((entry) => entry.includes("billion-context"))
    expect(line).toStartWith("warn billion-context: not checked")
    expect(line).toContain("installed_plugins.json")
    expect(line).toContain("known_marketplaces.json")
    expect(report.ok).toBe(true)
  })
})
