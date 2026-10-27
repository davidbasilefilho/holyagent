import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { doctor } from "../src/setup/doctor.ts"
import { setup, type SetupOptions } from "../src/setup/steps.ts"
import { fakeShell, scratch, writeCompleteSettings } from "./setup-fixture.ts"

const BOTH: SetupOptions = {
  subagentCacheTtl: "1h",
  dryRun: false,
  skipBillionContext: false,
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
const biliConfig = () => join(home, ".config", "billion-context", "billion-context.json")

const write = async (relative: string, content: string) => {
  const file = join(home, relative)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}
const read = (file: string) => Bun.file(file).text()
const readJson = async (file: string) => JSON.parse(await read(file)) as Record<string, unknown>

/** The artifacts of Billion Context's native mode, and of the Context7 skill. */
const markBiliNative = () =>
  Promise.all([
    write(".claude/settings.json", '{"hooks":"claude-native-bootstrap"}'),
    write(".claude/commands/acp-cache.md", "x"),
    write(".claude.json", '{"mcpServers":{"bili":{}}}'),
  ])
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
  "extraKnownMarketplaces.billion-context",
  "enabledPlugins.holyagent@holyagent",
  "permissions.deny",
]

describe("holyagent setup", () => {
  test("on a fresh machine installs bili, native mode and ctx7, sets compress.rules and merges the user settings", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(shell.layer)))
    expect(shell.lines()).toEqual([
      "bun add -g billion-context",
      "bili plugin install claude",
      "bun add -g ctx7",
    ])
    expect(report.ok).toBe(true)
    expect(report.lines.filter((line) => line.startsWith("- "))).toEqual([
      "- ctx7 skill: no CONTEXT7_API_KEY and no saved login; run `ctx7 login` or export CONTEXT7_API_KEY, then re-run",
    ])
    expect(await readJson(biliConfig())).toEqual({ compress: { rules: true } })
    if (process.platform !== "win32") expect((await stat(biliConfig())).mode & 0o777).toBe(0o600)
    for (const key of SETTINGS_KEYS) {
      expect(report.lines.some((line) => line.startsWith(`+ ${key}:`))).toBe(true)
    }
    const settings = await readJson(settingsFile())
    expect(settings.includeGitInstructions).toBe(false)
    expect(settings.subagentPromptCacheTtl).toBe("1h")
    expect(settings.enabledPlugins).toEqual({ "holyagent@holyagent": true })
    expect(settings.permissions).toEqual({ deny: ["WebSearch", "WebFetch"] })
  })

  test("a second run with everything in place prints only = lines and changes nothing", async () => {
    await markBiliNative()
    await markCtx7Skill()
    await write(".config/billion-context/billion-context.json", '{"compress":{"rules":false}}')
    const first = fakeShell({ commands: ["bun", "bili", "ctx7"] })
    const run1 = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(first.layer)))
    expect(run1.ok).toBe(true)
    const settingsAfterFirst = await read(settingsFile())

    const second = fakeShell({ commands: ["bun", "bili", "ctx7"] })
    const run2 = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(second.layer)))
    expect(second.calls).toEqual([])
    expect(run2.ok).toBe(true)
    expect(run2.lines.filter((line) => /^[+!~-] /.test(line))).toEqual([])
    expect(run2.lines.filter((line) => line.startsWith("= "))).toHaveLength(
      SETTINGS_KEYS.length + 5,
    )
    expect(run2.lines.at(-1)).toBe("no changes")
    expect(await read(settingsFile())).toBe(settingsAfterFirst)
    // compress.rules is set only when absent: a user's false stays.
    expect(await readJson(biliConfig())).toEqual({ compress: { rules: false } })
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
    const shell = fakeShell({ commands: ["bun", "bili", "ctx7"] })
    const report = await Effect.runPromise(
      setup(env(), { ...BOTH, skipBillionContext: true, skipCtx7: true }).pipe(
        Effect.provide(shell.layer),
      ),
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
      setup(env(), {
        ...BOTH,
        subagentCacheTtl: "5m",
        skipBillionContext: true,
        skipCtx7: true,
      }).pipe(Effect.provide(shell.layer)),
    )
    expect((await readJson(settingsFile())).subagentPromptCacheTtl).toBe("5m")
  })

  test("reads the user settings from CLAUDE_CONFIG_DIR when it is set", async () => {
    const configured = join(home, "elsewhere")
    const shell = fakeShell({ commands: ["bun"] })
    await Effect.runPromise(
      setup(env({ CLAUDE_CONFIG_DIR: configured }), {
        ...BOTH,
        skipBillionContext: true,
        skipCtx7: true,
      }).pipe(Effect.provide(shell.layer)),
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
    expect(report.lines).toContain("+ bili: would install with bun add -g billion-context")
    expect(report.lines).toContain(
      "+ bili native mode: would configure with bili plugin install claude",
    )
    expect(report.lines).toContain(
      `+ bili config: would set compress.rules=true in ${biliConfig()}`,
    )
    expect(report.lines).toContain("+ ctx7: would install with bun add -g ctx7")
    expect(report.lines).toContain("+ ctx7 skill: would install with ctx7 setup --cli --claude")
    expect(report.lines.at(-1)).toBe(`dry run: would add ${SETTINGS_KEYS.length}, nothing written`)
    expect(await tree(home)).toEqual([])
  })

  test("a failed step prints ! and the later steps still run; the report is not ok", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: (line) =>
        line === "bun add -g billion-context"
          ? { exitCode: 1, stderr: "network down\nmore" }
          : undefined,
    })
    const report = await Effect.runPromise(setup(env(), BOTH).pipe(Effect.provide(shell.layer)))
    expect(report.ok).toBe(false)
    expect(report.lines[0]).toBe("! bun add -g billion-context: failed (exit 1): network down")
    expect(shell.lines()).toContain("bun add -g ctx7")
    expect(report.lines.at(-1)).toBe(`added ${SETTINGS_KEYS.length}`)
    expect(await Bun.file(settingsFile()).exists()).toBe(true)
  })

  test("a failed native-mode step is reported and compress.rules and ctx7 still follow", async () => {
    const shell = fakeShell({
      commands: ["bun", "bili"],
      respond: (line) =>
        line === "bili plugin install claude" ? { exitCode: 2, stdout: "no proxy" } : undefined,
    })
    const report = await Effect.runPromise(
      setup(env({ CONTEXT7_API_KEY: "ctx7sk-test" }), BOTH).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines).toContain("! bili plugin install claude: failed (exit 2): no proxy")
    expect(await readJson(biliConfig())).toEqual({ compress: { rules: true } })
    expect(shell.lines()).toContain("ctx7 setup --cli --claude --yes --api-key ctx7sk-test")
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
    expect(shell.lines()).toContain("bun add -g ctx7")
  })

  test("a Billion Context config that is not a JSON object is reported and left alone", async () => {
    await markBiliNative()
    await write(".config/billion-context/billion-context.json", "[1]")
    const shell = fakeShell({ commands: ["bun", "bili"] })
    const report = await Effect.runPromise(
      setup(env(), { ...BOTH, skipCtx7: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines.find((line) => line.startsWith("! bili config"))).toContain(
      "is not a JSON object",
    )
    expect(await read(biliConfig())).toBe("[1]")
  })

  test("the skip flags leave Billion Context and ctx7 alone", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      setup(env(), { ...BOTH, skipBillionContext: true, skipCtx7: true }).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect(shell.calls).toEqual([])
    expect(report.lines).toContain("- billion-context: skipped by flag")
    expect(report.lines).toContain("- ctx7: skipped by flag")
  })

  describe("the ctx7 skill", () => {
    const options = { ...BOTH, skipBillionContext: true }
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

  test("in a claude.ai cloud session skips Billion Context and ctx7 with - lines and still merges the settings", async () => {
    const shell = fakeShell({ commands: [] })
    const report = await Effect.runPromise(
      setup(env({ CLAUDE_CODE_REMOTE: "true" }), BOTH).pipe(Effect.provide(shell.layer)),
    )
    expect(shell.calls).toEqual([])
    expect(report.ok).toBe(true)
    const skipped = report.lines.filter((line) => line.startsWith("- "))
    expect(skipped).toHaveLength(2)
    expect(skipped[0]).toStartWith("- billion-context: skipped in a claude.ai cloud session")
    expect(skipped[1]).toStartWith("- ctx7: skipped in a claude.ai cloud session")
    expect(Object.keys(await readJson(settingsFile())).toSorted()).toEqual([
      "attribution",
      "enabledPlugins",
      "extraKnownMarketplaces",
      "includeGitInstructions",
      "permissions",
      "subagentPromptCacheTtl",
    ])
    expect(await Bun.file(biliConfig()).exists()).toBe(false)
  })
})

describe("holyagent doctor", () => {
  test("passes when bun, bili, ctx7 and the settings keys are in place", async () => {
    await writeCompleteSettings(claudeDirectory())
    const shell = fakeShell({ commands: ["bun", "bili", "ctx7"] })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(true)
    expect(report.lines).toEqual([
      "ok   bun: /fake/bin/bun",
      "ok   bili: /fake/bin/bili",
      "ok   ctx7: /fake/bin/ctx7",
      `ok   settings: ${settingsFile()}`,
    ])
    expect(shell.calls).toEqual([])
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
      "FAIL bili:",
      "FAIL ctx7:",
      "FAIL setti",
    ])
    expect(report.lines[3]).toContain(settingsFile())
    expect(report.lines[3]).not.toContain(cwdSettings)
    expect(report.lines[3]).toContain("lacks attribution.commit")
    expect(report.lines.join("\n")).not.toMatch(/plugin list|canary|marketplace add/i)
    expect(shell.calls).toEqual([])
  })

  test("a settings file that is not a JSON object is a failing line", async () => {
    await write(".claude/settings.json", "[1]")
    const shell = fakeShell({ commands: ["bun", "bili", "ctx7"] })
    const report = await Effect.runPromise(
      doctor(env(), { fix: false }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines.at(-1)).toContain("is not a JSON object")
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
      "bun add -g billion-context",
      "bili plugin install claude",
      "bun add -g ctx7",
      "ctx7 setup --cli --claude --yes --api-key ctx7sk-test",
    ])
    expect(report.ok).toBe(true)
    expect(report.lines.slice(-4)).toEqual([
      "ok   bun: /fake/bin/bun",
      "ok   bili: /fake/bin/bili",
      "ok   ctx7: /fake/bin/ctx7",
      `ok   settings: ${settingsFile()}`,
    ])
    expect(await readJson(biliConfig())).toEqual({ compress: { rules: true } })
  })

  test("--fix runs only the steps behind a failing check", async () => {
    await writeCompleteSettings(claudeDirectory())
    const shell = fakeShell({ commands: ["bun", "bili"] })
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
        line.startsWith("bun add -g") ? { exitCode: 1, stderr: "offline" } : undefined,
    })
    const report = await Effect.runPromise(
      doctor(env(), { fix: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(report.ok).toBe(false)
    expect(report.lines).toContain("! bun add -g billion-context: failed (exit 1): offline")
    expect(report.lines.filter((line) => line.startsWith("FAIL "))).toHaveLength(2)
  })

  test("in a cloud session bili and ctx7 pass by design and --fix only merges the settings", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      doctor(env({ CLAUDE_CODE_REMOTE: "true" }), { fix: true }).pipe(Effect.provide(shell.layer)),
    )
    expect(shell.calls).toEqual([])
    expect(report.ok).toBe(true)
    expect(report.lines.filter((line) => line.includes("by design"))).toHaveLength(2)
    expect(await Bun.file(settingsFile()).exists()).toBe(true)
  })
})
