import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { version } from "../../../package.json" with { type: "json" }
import { piPackages } from "../src/config/packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { BILLION_CONTEXT_GUARDRAILS_FILE } from "../src/pi/bash/guardrails.ts"
import { doctor } from "../src/setup/doctor.ts"
import { addRecorded, recordPath } from "../src/setup/record.ts"
import { setup } from "../src/setup/steps.ts"
import {
  fakeShell,
  PI_TEST_HOST_VERSION,
  scratch,
  withoutSearchTools,
  writeCompleteSettings,
} from "./setup-fixture.ts"

let home: string
let project: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-pi-settings-")
  home = join(made.directory, "home")
  project = join(made.directory, "project")
  await mkdir(project, { recursive: true })
  await writeCompleteSettings(join(home, ".claude"))
  remove = made.remove
})
afterEach(() => remove())

const DEFAULT = await Effect.runPromise(defaultConfig)
const SOURCE = `git:github.com/davidbasilefilho/holyagent@holyagent-${version}`
const IN_USE = { HOLYAGENT_HOST: "pi" }

const write = async (file: string, content: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
}
const read = async (file: string): Promise<unknown> => JSON.parse(await Bun.file(file).text())
const exists = (file: string) => Bun.file(file).exists()

const globalSettings = () => join(home, ".pi", "agent", "settings.json")
const globalSubagents = () => join(home, ".pi", "agent", "subagents.json")
const piFff = () => join(home, ".pi", "agent", "pi-fff.json")
const globalKimi = () => join(home, ".pi", "providers", "kimi-coding", "config.json")
const billion = () => join(home, ".config", "billion-context", "billion-context.json")
const projectPi = (...parts: Array<string>) => join(project, ".pi", ...parts)

/** The packages of a Pi that has HolyAgent and every package the default config enables. */
const FULL = () => ({ packages: [SOURCE, ...piPackages(DEFAULT)] })
/** Pi's settings as `pi install` leaves them, so the package step has nothing to run. */
const installed = () => write(globalSettings(), FULL())

const setConfig = (config: unknown) => write(join(home, ".holyagent", "config.json"), config)
const setProjectConfig = (config: unknown) =>
  write(join(project, ".holyagent", "config.json"), config)

const withPi = () =>
  fakeShell({
    commands: ["bun", "ctx7", "pi", "node", "npx", "cua-driver"],
    respond: (line) =>
      line === "pi --version"
        ? { stdout: `${PI_TEST_HOST_VERSION}\n` }
        : line === "node --version"
          ? { stdout: "v22.19.0\n" }
          : undefined,
  })

const runSetup = (
  shell: ReturnType<typeof fakeShell>,
  extra: {
    env?: Record<string, string>
    scope?: "user" | "project" | "local"
    dryRun?: boolean
    undo?: boolean
  } = {},
) =>
  Effect.runPromise(
    setup(
      { HOME: home, ...extra.env },
      {
        scope: extra.scope ?? "user",
        cwd: project,
        subagentCacheTtl: "1h",
        dryRun: extra.dryRun ?? false,
        skipCtx7: true,
        undo: extra.undo ?? false,
      },
    ).pipe(Effect.provide(shell.layer)),
  )

const runDoctor = (
  shell: ReturnType<typeof fakeShell>,
  extra: { env?: Record<string, string>; scope?: "user" | "project" | "local" } = {},
) =>
  Effect.runPromise(
    doctor(
      { HOME: home, DISPLAY: ":0", ...extra.env },
      { fix: false, cwd: project, scope: extra.scope ?? "user" },
    ).pipe(Effect.provide(shell.layer)),
  )

const toolLines = (report: { readonly lines: ReadonlyArray<string> }) =>
  report.lines.filter((line) => /^[+=~!-] tool settings/.test(line))

const CODEMODE = { codemode: { mode: "only" } }
/** The native startup preferences for the default root route. */
const MODEL = {
  defaultProvider: "kimi-coding",
  defaultModel: "k3.1-pro",
  defaultThinkingLevel: "high",
}
const SUBAGENTS = { disableDefaultAgents: true, fallbackSubagent: "none" }
/**
 * Setup's defaults for `@ff-labs/pi-fff`: override Pi's search tools in projects, but do not index
 * a session started at the home directory itself.
 */
const PI_FFF = { mode: "override", enableHomeDirScanning: false }
const BILLION_SUBAGENTS = { pi: { subagents: false } }
/** What setup writes into Billion Context's file: the subagents setting and the guardrails off. */
const BILLION = { ...BILLION_SUBAGENTS, ...BILLION_CONTEXT_GUARDRAILS_FILE }

describe("holyagent setup, Pi tool settings", () => {
  test.each([
    ["Kimi Global", ["kimi-coding-global"]],
    ["both providers", ["openai-codex", "kimi-coding-global"]],
  ])("prepares the native Global region for %s before Pi starts", async (_label, providers) => {
    await installed()
    await setConfig({ pi: { providers } })
    await write(globalKimi(), { protocol: "anthropic", model: { reasoning: true } })
    const before = await read(globalKimi())
    const dryRun = await runSetup(withPi(), { dryRun: true })
    expect(toolLines(dryRun).join("\n")).toContain('would add region "global"')
    expect(await read(globalKimi())).toEqual(before)
    const first = await runSetup(withPi())
    expect(first.ok).toBe(true)
    expect(await read(globalKimi())).toEqual({
      protocol: "anthropic",
      model: { reasoning: true },
      region: "global",
    })
    const applied = await Bun.file(globalKimi()).text()
    await runSetup(withPi())
    expect(await Bun.file(globalKimi()).text()).toBe(applied)
  })

  test("leaves Kimi's file untouched for Codex only, project scope and explicit environment", async () => {
    await installed()
    await setConfig({ pi: { providers: ["openai-codex"] } })
    await runSetup(withPi())
    expect(await exists(globalKimi())).toBe(false)
    await setConfig({ pi: { providers: ["kimi-coding-global"] } })
    await runSetup(withPi(), { scope: "project" })
    expect(await exists(globalKimi())).toBe(false)
    expect(await exists(projectPi("providers", "kimi-coding", "config.json"))).toBe(false)
    await runSetup(withPi(), { env: { KIMI_CODE_REGION: "mainland-cn" } })
    expect(await exists(globalKimi())).toBe(false)
    await runSetup(withPi(), { env: { KIMI_CODE_BASE_URL: "https://kimi.fixture.invalid" } })
    expect(await exists(globalKimi())).toBe(false)
  })

  test("keeps an explicit or later Kimi region, and undo does not remove that choice", async () => {
    await installed()
    await setConfig({ pi: { providers: ["kimi-coding-global"] } })
    await write(globalKimi(), {
      region: "mainland-cn",
      tools: { moonshot_search: { enabled: false } },
    })
    await runSetup(withPi())
    expect(await read(globalKimi())).toEqual({
      region: "mainland-cn",
      tools: { moonshot_search: { enabled: false } },
    })
    await write(globalKimi(), { region: null })
    await runSetup(withPi())
    expect(await read(globalKimi())).toEqual({ region: null })
    await write(globalKimi(), {})
    await runSetup(withPi())
    expect(await read(globalKimi())).toEqual({ region: "global" })
    await write(globalKimi(), { region: "mainland-cn" })
    await runSetup(withPi(), { undo: true })
    expect(await read(globalKimi())).toEqual({ region: "mainland-cn" })
  })

  test("removes only recorded desktop confirmation settings that still match", async () => {
    await write(globalSettings(), {
      "pi-computer-use": { confirmAppLaunch: false, confirmDangerousActions: true, custom: "keep" },
    })
    await Effect.runPromise(
      addRecorded({ HOME: home }, globalSettings(), [
        { path: ["pi-computer-use", "confirmAppLaunch"], value: false },
        { path: ["pi-computer-use", "confirmDangerousActions"], value: false },
      ]),
    )
    await runSetup(withPi())
    expect(await read(globalSettings())).toMatchObject({
      "pi-computer-use": { confirmDangerousActions: true, custom: "keep" },
    })
    const settings = (await read(globalSettings())) as Record<string, unknown>
    expect(settings["pi-computer-use"]).not.toHaveProperty("confirmAppLaunch")
  })

  test("writes every key toolSettings returns into Pi's global files, beside what the files hold", async () => {
    await installed()
    const shell = withPi()
    const report = await runSetup(shell)
    expect(report.ok).toBe(true)
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      ...CODEMODE,
      ...MODEL,
    })
    expect(await read(globalSubagents())).toEqual(SUBAGENTS)
    expect(await exists(globalKimi())).toBe(false)
    expect(await read(billion())).toEqual(BILLION)
    expect(await read(piFff())).toEqual(PI_FFF)
    // One line per file, none of which is a process.
    expect(toolLines(report)).toHaveLength(4)
    expect(toolLines(report)).toContain(
      `+ tool settings ${globalSubagents()}: added disableDefaultAgents true, fallbackSubagent "none"`,
    )
    // Only the version of Node.js, which the browse need of browser use reads.
    expect(shell.calls.map((call) => call.line)).toEqual(["node --version"])
  })

  test("a second run changes nothing and says so", async () => {
    await installed()
    await runSetup(withPi())
    const before = await Promise.all(
      [globalSettings(), globalSubagents(), billion(), piFff()].map((file) =>
        Bun.file(file).text(),
      ),
    )
    const report = await runSetup(withPi())
    expect(toolLines(report).every((line) => line.startsWith("= tool settings "))).toBe(true)
    expect(toolLines(report)).toHaveLength(4)
    expect(
      await Promise.all(
        [globalSettings(), globalSubagents(), billion(), piFff()].map((file) =>
          Bun.file(file).text(),
        ),
      ),
    ).toEqual(before)
  })

  test("never overwrites a value the user set, and a user's off wins for the risky settings", async () => {
    await write(globalSettings(), {
      ...FULL(),
      codemode: { mode: "on", inlineBudget: 100 },
      "pi-computer-use": { confirmAppLaunch: true },
    })
    await write(globalSubagents(), { disableDefaultAgents: false, fallbackSubagent: "Explore" })
    await write(globalKimi(), { tools: { moonshot_search: { enabled: false } }, region: "global" })
    await write(billion(), { pi: { subagents: { enabled: true } }, port: 1 })
    const report = await runSetup(withPi())
    expect(report.ok).toBe(true)
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      ...MODEL,
      codemode: { mode: "on", inlineBudget: 100 },
      "pi-computer-use": { confirmAppLaunch: true },
    })
    expect(await read(globalSubagents())).toEqual({
      disableDefaultAgents: false,
      fallbackSubagent: "Explore",
    })
    expect(await read(globalKimi())).toEqual({
      tools: { moonshot_search: { enabled: false } },
      region: "global",
    })
    expect(await read(billion())).toEqual({
      pi: { subagents: { enabled: true } },
      port: 1,
      ...BILLION_CONTEXT_GUARDRAILS_FILE,
    })
    expect(toolLines(report).join("\n")).toContain(
      'kept pi.subagents {"enabled":true} (HolyAgent sets false; yours wins)',
    )
    expect(toolLines(report).join("\n")).toContain(
      'kept codemode.mode "on" (HolyAgent sets "only"; yours wins)',
    )
  })

  test("leaves out a key whose value is the package default", async () => {
    await setConfig({ pi: { codemode: { mode: "on" } } })
    await installed()
    const report = await runSetup(withPi())
    expect(await read(globalSettings())).toEqual({ ...FULL(), ...MODEL })
    expect(toolLines(report).join("\n")).toContain("left out, the package default: codemode.mode")
  })

  test("seeds an explicit root route without completing any existing startup selection", async () => {
    await setConfig({
      pi: {
        providers: ["openai-codex", "kimi-coding-global"],
        routes: {
          root: {
            provider: "kimi-coding-global",
            model: "kimi-coding/kimi-for-coding",
            thinking: "max",
          },
        },
      },
    })
    for (const prior of [
      { defaultProvider: "mine" },
      { defaultModel: "my-model" },
      { defaultThinkingLevel: "off" },
      MODEL,
    ]) {
      await write(globalSettings(), { ...FULL(), theme: "dark", ...prior })
      const report = await runSetup(withPi())
      expect(await read(globalSettings())).toEqual({
        ...FULL(),
        ...CODEMODE,
        theme: "dark",
        ...prior,
      })
      expect(toolLines(report).join("\n")).toContain("kept the existing startup model preferences")
    }
    await write(globalSettings(), { ...FULL(), theme: "dark" })
    const preview = await runSetup(withPi(), { dryRun: true })
    expect(toolLines(preview).join("\n")).toContain('defaultModel "kimi-for-coding"')
    expect(await read(globalSettings())).toEqual({ ...FULL(), theme: "dark" })
    await runSetup(withPi())
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      ...CODEMODE,
      theme: "dark",
      defaultProvider: "kimi-coding",
      defaultModel: "kimi-for-coding",
      defaultThinkingLevel: "max",
    })
  })

  test("uses the enabled provider's profile when an explicit root provider is disabled", async () => {
    await setConfig({
      pi: {
        providers: ["openai-codex"],
        profile: "fast",
        routes: {
          root: { provider: "kimi-coding-global", model: "kimi-for-coding", thinking: "max" },
        },
      },
    })
    await installed()
    await runSetup(withPi())
    expect(await read(globalSettings())).toMatchObject({
      defaultProvider: "openai-codex",
      defaultModel: "gpt-6.1-terra",
      defaultThinkingLevel: "high",
    })
  })

  test("an upgrade or rerun preserves a later selection change and does not undo a later reset", async () => {
    await installed()
    await runSetup(withPi())
    const preference = { ...MODEL, defaultThinkingLevel: "low" }
    await write(globalSettings(), { ...FULL(), ...CODEMODE, ...preference })
    await setConfig({ pi: { providers: ["openai-codex"] } })
    await runSetup(withPi())
    expect(await read(globalSettings())).toMatchObject(preference)
    await write(globalSettings(), { ...FULL(), ...CODEMODE })
    const report = await runSetup(withPi())
    expect(await read(globalSettings())).not.toHaveProperty("defaultModel")
    expect(toolLines(report).join("\n")).toContain("kept the startup model reset")
    expect(toolLines(await runDoctor(withPi())).join("\n")).not.toContain("defaultModel")
  })

  test("a file that is not a JSON object stays untouched with a failed line, and the others are written", async () => {
    await installed()
    await write(globalSubagents(), "{ not json")
    await write(billion(), "[1, 2]")
    const report = await runSetup(withPi())
    expect(report.ok).toBe(false)
    expect(await Bun.file(globalSubagents()).text()).toBe("{ not json")
    expect(await Bun.file(billion()).text()).toBe("[1, 2]")
    const failures = toolLines(report).filter((line) => line.startsWith("! "))
    expect(failures).toHaveLength(2)
    expect(failures.join("\n")).toContain(globalSubagents())
    expect(failures.join("\n")).toContain(billion())
    expect(await exists(globalKimi())).toBe(false)
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      ...CODEMODE,
      ...MODEL,
    })
  })

  test("writes through a temporary file that is gone afterwards, keeping the file's mode", async () => {
    await installed()
    await chmod(globalSettings(), 0o640)
    await runSetup(withPi())
    expect((await readdir(dirname(globalSettings()))).sort()).toEqual([
      "pi-fff.json",
      "settings.json",
      "subagents.json",
    ])
    if (process.platform !== "win32") {
      expect((await stat(globalSettings())).mode & 0o777).toBe(0o640)
    }
  })

  test("a dry run shows what would be added and writes nothing, not even the record", async () => {
    await installed()
    const before = await Bun.file(globalSettings()).text()
    const report = await runSetup(withPi(), { dryRun: true })
    expect(toolLines(report)).toHaveLength(4)
    expect(toolLines(report).every((line) => line.includes("would add"))).toBe(true)
    expect(toolLines(report).every((line) => line.endsWith("(dry run, nothing written)"))).toBe(
      true,
    )
    expect(await Bun.file(globalSettings()).text()).toBe(before)
    for (const file of [globalSubagents(), globalKimi(), billion(), piFff()]) {
      expect(await exists(file)).toBe(false)
    }
    expect(await exists(recordPath({ HOME: home }))).toBe(false)
  })

  test("follows the Pi step's gating: Claude-only machines, cloud sessions and pi.enable off get nothing", async () => {
    const claudeOnly = fakeShell({ commands: ["bun"] })
    expect(toolLines(await runSetup(claudeOnly))).toEqual([])
    const cloud = await runSetup(withPi(), { env: { CLAUDE_CODE_REMOTE: "true", ...IN_USE } })
    expect(toolLines(cloud)).toEqual([])

    await setConfig({ pi: { enable: false } })
    expect(toolLines(await runSetup(withPi()))).toEqual([])
    for (const file of [globalSettings(), globalSubagents(), globalKimi(), billion()]) {
      expect(await exists(file)).toBe(false)
    }
  })

  test("a feature the config turns off writes no setting for it", async () => {
    await setConfig({
      pi: { features: { computerUse: false, subagents: false, contextCompression: false } },
    })
    await installed()
    await runSetup(withPi())
    expect(await read(globalSettings())).toEqual({ ...FULL(), ...CODEMODE, ...MODEL })
    expect(await exists(globalSubagents())).toBe(false)
    expect(await exists(billion())).toBe(false)
    expect(await exists(globalKimi())).toBe(false)
  })

  describe("fff", () => {
    const off = { pi: { features: { fff: false } } }
    const ADDED = () => `+ tool settings ${piFff()}: added mode "override"`
    const REMOVED = () =>
      `- tool settings ${piFff()}: removed mode "override", enableHomeDirScanning false`

    test("puts pi-fff in override mode in Pi's agent folder, beside what the file holds", async () => {
      await installed()
      await write(piFff(), { enableHomeDirScanning: false })
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual(PI_FFF)
      expect(toolLines(report)).toContain(`${ADDED()}; already set: enableHomeDirScanning`)
    })

    test("adds the home-specific guard to an existing setup once, without touching warnings", async () => {
      await installed()
      await write(piFff(), { mode: "override", warnOnHomeDirScan: true })
      const dry = await runSetup(withPi(), { dryRun: true })
      expect(toolLines(dry)).toContain(
        `+ tool settings ${piFff()}: would add enableHomeDirScanning false; already set: mode (dry run, nothing written)`,
      )
      expect(await read(piFff())).toEqual({ mode: "override", warnOnHomeDirScan: true })
      const report = await runSetup(withPi())
      expect(toolLines(report)).toContain(
        `+ tool settings ${piFff()}: added enableHomeDirScanning false; already set: mode`,
      )
      const configured = { ...PI_FFF, warnOnHomeDirScan: true }
      expect(await read(piFff())).toEqual(configured)
      expect(
        toolLines(await runSetup(withPi())).some(
          (line) => line.startsWith("+") && line.includes(piFff()),
        ),
      ).toBe(false)
      await runSetup(withPi(), { undo: true })
      expect(await read(piFff())).toEqual({ mode: "override", warnOnHomeDirScan: true })
    })

    test.each([true, false])(
      "keeps an explicit home scan preference (%s) through setup and undo",
      async (enableHomeDirScanning) => {
        await installed()
        const existing = { enableHomeDirScanning, warnOnHomeDirScan: false }
        await write(piFff(), existing)
        await runSetup(withPi())
        expect(await read(piFff())).toEqual({ ...existing, mode: "override" })
        expect(toolLines(await runDoctor(withPi())).some((line) => line.includes(piFff()))).toBe(
          false,
        )
        await runSetup(withPi(), { undo: true })
        expect(await read(piFff())).toEqual(existing)
      },
    )

    test("never writes followSymlinks, so the package follows directory links by its own default", async () => {
      await installed()
      await runSetup(withPi())
      expect(await read(piFff())).not.toHaveProperty("followSymlinks")
      await write(piFff(), { followSymlinks: true })
      await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: true, ...PI_FFF })
    })

    test("takes out the followSymlinks false that an earlier setup recorded, while the capability stays on", async () => {
      await installed()
      await write(piFff(), { mode: "override", followSymlinks: false })
      await Effect.runPromise(
        addRecorded({ HOME: home }, piFff(), [
          { path: ["mode"], value: "override" },
          { path: ["followSymlinks"], value: false },
        ]),
      )
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual(PI_FFF)
      expect(toolLines(report)).toContain(
        `- tool settings ${piFff()}: removed followSymlinks false`,
      )
      // The record forgot it, so a value the user sets the same later is theirs.
      await write(piFff(), { mode: "override", followSymlinks: false })
      await runSetup(withPi())
      expect(await read(piFff())).toEqual({ ...PI_FFF, followSymlinks: false })
    })

    test("leaves a followSymlinks false that setup did not record", async () => {
      await installed()
      await write(piFff(), { followSymlinks: false })
      await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: false, ...PI_FFF })
    })

    describe("the followSymlinks false that 0.3.1 wrote", () => {
      /** A file as 0.3.1 setup left it: `followSymlinks: false` beside the override, both recorded. */
      const afterOldSetup = async (file: Record<string, unknown> = { followSymlinks: false }) => {
        await installed()
        await write(piFff(), { mode: "override", ...file })
        await Effect.runPromise(
          addRecorded({ HOME: home }, piFff(), [
            { path: ["mode"], value: "override" },
            { path: ["followSymlinks"], value: false },
          ]),
        )
      }

      test("is taken out when the capability is turned off, with the override", async () => {
        await afterOldSetup()
        await setConfig(off)
        const report = await runSetup(withPi())
        expect(await read(piFff())).toEqual({})
        expect(toolLines(report)).toContain(
          `- tool settings ${piFff()}: removed mode "override", followSymlinks false`,
        )
      })

      test("is taken out when pi.enable is off", async () => {
        await afterOldSetup()
        await setConfig({ pi: { enable: false } })
        const report = await runSetup(withPi())
        expect(await read(piFff())).toEqual({})
        expect(toolLines(report)).toContain(
          `- tool settings ${piFff()}: removed mode "override", followSymlinks false`,
        )
      })

      test("is reported by a dry run, which writes neither the file nor the record", async () => {
        await afterOldSetup()
        await setConfig(off)
        const report = await runSetup(withPi(), { dryRun: true })
        expect(await read(piFff())).toEqual({ mode: "override", followSymlinks: false })
        expect(toolLines(report)).toContain(
          `- tool settings ${piFff()}: would remove mode "override", followSymlinks false (dry run, nothing written)`,
        )
        // The record is intact, so the real run still removes both.
        await runSetup(withPi())
        expect(await read(piFff())).toEqual({})
      })

      test("stays when the person changed it to true after setup, and the report says so", async () => {
        await afterOldSetup({ followSymlinks: true })
        await setConfig(off)
        const report = await runSetup(withPi())
        expect(await read(piFff())).toEqual({ followSymlinks: true })
        expect(toolLines(report)).toContain(
          `- tool settings ${piFff()}: removed mode "override"; kept followSymlinks true (setup wrote false)`,
        )
      })
    })

    test("follows PI_CODING_AGENT_DIR, which is where the package reads the file", async () => {
      const agent = join(home, "agent-dir")
      await write(join(agent, "settings.json"), FULL())
      await runSetup(withPi(), { env: { PI_CODING_AGENT_DIR: agent } })
      expect(await read(join(agent, "pi-fff.json"))).toEqual(PI_FFF)
      expect(await exists(piFff())).toBe(false)
    })

    test("keeps a mode the user chose, and says so", async () => {
      await installed()
      await write(piFff(), { ...PI_FFF, mode: "tools-only" })
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ ...PI_FFF, mode: "tools-only" })
      expect(toolLines(report)).toContain(
        `~ tool settings ${piFff()}: already set: enableHomeDirScanning; kept mode "tools-only" (HolyAgent sets "override"; yours wins)`,
      )
    })

    test("writes nothing while it is off, and turning it off takes the mode setup wrote back out", async () => {
      await setConfig(off)
      await installed()
      await runSetup(withPi())
      expect(await exists(piFff())).toBe(false)
      await setConfig({})
      await write(piFff(), { enableHomeDirScanning: false })
      await runSetup(withPi())
      expect(await read(piFff())).toEqual(PI_FFF)
      await setConfig(off)
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ enableHomeDirScanning: false })
      expect(toolLines(report)).toContain(`- tool settings ${piFff()}: removed mode "override"`)
    })

    test("keeps a followSymlinks the user chose, and takes out only the keys it wrote", async () => {
      await installed()
      await write(piFff(), { followSymlinks: true })
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: true, ...PI_FFF })
      expect(toolLines(report)).toContain(`${ADDED()}, enableHomeDirScanning false`)
      await setConfig(off)
      const reverted = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: true })
      expect(toolLines(reverted)).toContain(REMOVED())
    })

    test("leaves a value the user changed after setup", async () => {
      await installed()
      await runSetup(withPi())
      const preferences = { mode: "tools-only", followSymlinks: true, enableHomeDirScanning: true }
      await write(piFff(), preferences)
      await setConfig(off)
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual(preferences)
      expect(toolLines(report)).toContain(
        `~ tool settings ${piFff()}: kept mode "tools-only" (setup wrote "override"), enableHomeDirScanning true (setup wrote false)`,
      )
    })

    test("leaves an override the user had before setup, whatever the capability does", async () => {
      await installed()
      await write(piFff(), PI_FFF)
      await runSetup(withPi())
      await setConfig(off)
      await runSetup(withPi())
      expect(await read(piFff())).toEqual(PI_FFF)
    })

    test("project and local setup never create or edit global pi-fff settings", async () => {
      await installed()
      const agent = join(home, "agent-dir")
      const redirected = join(agent, "pi-fff.json")
      const preferences = { mode: "tools-only", warnOnHomeDirScan: true }
      for (const scope of ["project", "local"] as const) {
        const report = await runSetup(withPi(), { scope })
        expect(toolLines(report)).toContain(
          `- tool settings ~/.pi/agent/pi-fff.json: has no file at ${scope} scope; run \`holyagent setup\` at user scope`,
        )
        expect(await exists(projectPi("pi-fff.json"))).toBe(false)
        expect(await exists(piFff())).toBe(false)
        await write(redirected, preferences)
        await runSetup(withPi(), { scope, env: { PI_CODING_AGENT_DIR: agent } })
        expect(await read(redirected)).toEqual(preferences)
      }
    })

    test("--undo takes the override out by its record", async () => {
      await installed()
      await runSetup(withPi())
      const real = await runSetup(withPi(), { undo: true })
      expect((await exists(piFff())) && (await read(piFff()))).toEqual({})
      expect(toolLines(real)).toContain(REMOVED())
    })
  })

  describe("turning just-bash off", () => {
    const GUARDRAILS =
      "guardrails.bashTimeout 0, guardrails.maxOutputBytes 0, guardrails.repetition false"
    const off = { pi: { features: { justBash: false } } }

    test("takes the guardrails setup wrote back out, by its record, and keeps the other keys", async () => {
      await installed()
      await runSetup(withPi())
      expect(await read(billion())).toEqual(BILLION)
      await setConfig(off)
      const report = await runSetup(withPi())
      expect(report.ok).toBe(true)
      expect(await read(billion())).toEqual(BILLION_SUBAGENTS)
      expect(toolLines(report)).toContain(`- tool settings ${billion()}: removed ${GUARDRAILS}`)
      // The record forgot them: another run has nothing to revert, and turning it on writes them again.
      expect(toolLines(await runSetup(withPi())).join("\n")).not.toContain("removed guardrails")
      await setConfig({})
      await runSetup(withPi())
      expect(await read(billion())).toEqual(BILLION)
    })

    test("also takes them out when pi.enable is off, by the same record", async () => {
      await installed()
      await runSetup(withPi())
      expect(await read(billion())).toEqual(BILLION)
      await setConfig({ pi: { enable: false, features: { justBash: false } } })
      const report = await runSetup(withPi())
      expect(report.ok).toBe(true)
      expect(await read(billion())).toEqual(BILLION_SUBAGENTS)
      expect(toolLines(report)).toEqual([
        `- tool settings ${billion()}: removed ${GUARDRAILS}`,
        `- tool settings ${piFff()}: removed mode "override", enableHomeDirScanning false`,
      ])
      // Nothing else is written or touched with Pi off, and a second run has nothing to revert.
      expect(toolLines(await runSetup(withPi()))).toEqual([])
    })

    test("leaves a guardrail key the user set before setup, and one the user changed since", async () => {
      await installed()
      await write(billion(), { guardrails: { bashTimeout: 30 } })
      await runSetup(withPi())
      expect(await read(billion())).toEqual({
        ...BILLION_SUBAGENTS,
        guardrails: { bashTimeout: 30, maxOutputBytes: 0, repetition: false },
      })
      await write(billion(), {
        ...BILLION_SUBAGENTS,
        guardrails: { bashTimeout: 30, maxOutputBytes: 1000, repetition: false },
      })
      await setConfig(off)
      const report = await runSetup(withPi())
      expect(await read(billion())).toEqual({
        ...BILLION_SUBAGENTS,
        guardrails: { bashTimeout: 30, maxOutputBytes: 1000 },
      })
      expect(toolLines(report).join("\n")).toContain(
        "removed guardrails.repetition false; kept guardrails.maxOutputBytes 1000 (setup wrote 0)",
      )
    })

    test("touches nothing setup did not write, whatever the file holds", async () => {
      await installed()
      // The user's own file already has every key at setup's value, so setup records none of them.
      await write(billion(), BILLION)
      await runSetup(withPi())
      await setConfig(off)
      const report = await runSetup(withPi())
      expect(await read(billion())).toEqual(BILLION)
      expect(toolLines(report).join("\n")).not.toContain("guardrails")
    })

    test("a dry run says what it would remove and changes neither the file nor the record", async () => {
      await installed()
      await runSetup(withPi())
      await setConfig(off)
      const report = await runSetup(withPi(), { dryRun: true })
      expect(await read(billion())).toEqual(BILLION)
      expect(toolLines(report)).toContain(
        `- tool settings ${billion()}: would remove ${GUARDRAILS} (dry run, nothing written)`,
      )
      await runSetup(withPi())
      expect(await read(billion())).toEqual(BILLION_SUBAGENTS)
    })

    test("also takes them out while Billion Context itself is off, which the guardrails are written for", async () => {
      await installed()
      await runSetup(withPi())
      await setConfig({ pi: { features: { contextCompression: false } } })
      await runSetup(withPi())
      expect(await read(billion())).toEqual(BILLION_SUBAGENTS)
    })
  })

  test("PI_CODING_AGENT_DIR moves Pi's agent files, and BILI_CONFIG_FILE or XDG_CONFIG_HOME Billion Context's", async () => {
    const agent = join(home, "elsewhere", "agent")
    const bili = join(home, "bili.json")
    await write(join(agent, "settings.json"), FULL())
    await runSetup(withPi(), { env: { PI_CODING_AGENT_DIR: agent, BILI_CONFIG_FILE: bili } })
    expect(await read(join(agent, "settings.json"))).toEqual({
      ...FULL(),
      ...CODEMODE,
      ...MODEL,
    })
    expect(await read(join(agent, "subagents.json"))).toEqual(SUBAGENTS)
    expect(await read(bili)).toEqual(BILLION)
    expect(await exists(globalSettings())).toBe(false)
    expect(await exists(globalKimi())).toBe(false)

    const xdg = join(home, "xdg")
    await runSetup(withPi(), { env: { PI_CODING_AGENT_DIR: agent, XDG_CONFIG_HOME: xdg } })
    expect(await read(join(xdg, "billion-context", "billion-context.json"))).toEqual(BILLION)
    expect(await exists(billion())).toBe(false)
  })

  test("project and local scope write the project's .pi folder, decide from the project's config, and leave the global files alone", async () => {
    await installed()
    await setProjectConfig({ pi: { features: { subagents: false }, codemode: { mode: "only" } } })
    for (const scope of ["project", "local"] as const) {
      const report = await runSetup(withPi(), { scope })
      expect(await read(projectPi("settings.json"))).toEqual({
        ...CODEMODE,
        ...MODEL,
      })
      expect(await exists(projectPi("providers", "kimi-coding", "config.json"))).toBe(false)
      expect(await exists(projectPi("subagents.json"))).toBe(false)
      expect(toolLines(report).some((line) => line.includes("has no file at"))).toBe(true)
      expect(toolLines(report).join("\n")).toContain(
        `- tool settings ${"~/.config/billion-context/billion-context.json"}: has no file at ${scope} scope; run \`holyagent setup\` at user scope`,
      )
    }
    expect(await read(globalSettings())).toEqual(FULL())
    expect(await exists(billion())).toBe(false)
    expect(await exists(globalSubagents())).toBe(false)
  })

  test("project and local scope leave a key the user's global file sets, whatever its value", async () => {
    await write(globalSettings(), {
      ...FULL(),
      "pi-computer-use": { confirmAppLaunch: true },
    })
    await write(globalKimi(), { tools: { moonshot_search: { enabled: false } } })
    for (const scope of ["project", "local"] as const) {
      const report = await runSetup(withPi(), { scope })
      expect(report.ok).toBe(true)
      expect(await read(projectPi("settings.json"))).toEqual({
        ...CODEMODE,
        ...MODEL,
      })
      expect(await exists(projectPi("providers", "kimi-coding", "config.json"))).toBe(false)
      const lines = toolLines(report).join("\n")
      expect(lines).not.toContain("pi-computer-use.confirmAppLaunch")
    }
    // The global files are as the user left them.
    expect(await read(globalKimi())).toEqual({ tools: { moonshot_search: { enabled: false } } })
  })

  test("project and local scope preserve global and project Pi startup choices", async () => {
    const global = { ...FULL(), ...MODEL }
    const native = { defaultModel: "mine", defaultThinkingLevel: "low" }
    await write(globalSettings(), global)
    for (const scope of ["project", "local"] as const) {
      await write(projectPi("settings.json"), native)
      const report = await runSetup(withPi(), { scope })
      expect(await read(globalSettings())).toEqual(global)
      const settings = await read(projectPi("settings.json"))
      expect(settings).toMatchObject(native)
      expect(settings).not.toHaveProperty("defaultProvider")
      expect(toolLines(report).join("\n")).not.toMatch(/default(?:Provider|Model|ThinkingLevel)/)
    }
  })

  test("a global file that is not a JSON object stops the project write with a failed line", async () => {
    await write(globalSubagents(), "{ not json")
    const report = await runSetup(withPi(), { scope: "project" })
    expect(report.ok).toBe(false)
    const failure = toolLines(report).find((line) => line.includes(globalSubagents()))
    expect(failure).toStartWith("! tool settings: ")
    expect(await exists(projectPi("subagents.json"))).toBe(false)
  })

  test("project and local scope refuse a symlinked .pi folder and write nothing through it", async () => {
    const elsewhere = join(home, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    await symlink(elsewhere, projectPi())
    for (const scope of ["project", "local"] as const) {
      const report = await runSetup(withPi(), { scope })
      expect(report.ok).toBe(false)
      const failures = toolLines(report).filter((line) => line.startsWith("! "))
      expect(failures.length).toBeGreaterThan(0)
      for (const line of failures) expect(line).toContain(`${projectPi()} is a symlink`)
      expect(await readdir(elsewhere)).toEqual([])
    }
  })

  test("project and local scope refuse a symlinked settings file, and the other files are still written", async () => {
    await installed()
    const before = await Bun.file(globalSettings()).text()
    await mkdir(projectPi(), { recursive: true })
    await symlink(globalSettings(), projectPi("settings.json"))
    for (const scope of ["project", "local"] as const) {
      const report = await runSetup(withPi(), { scope })
      expect(report.ok).toBe(false)
      expect(toolLines(report)).toContain(
        `! tool settings: ${projectPi("settings.json")} is a symlink; refusing to write through it in the ${scope} scope. Replace it with a real file and run again`,
      )
      expect(await Bun.file(globalSettings()).text()).toBe(before)
      expect(await read(projectPi("subagents.json"))).toEqual(SUBAGENTS)
    }
  })

  test("an unused provider symlink is left untouched", async () => {
    const elsewhere = join(home, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    await mkdir(projectPi(), { recursive: true })
    await symlink(elsewhere, projectPi("providers"))
    const report = await runSetup(withPi(), { scope: "project" })
    expect(report.ok).toBe(true)
    expect(await read(projectPi("subagents.json"))).toEqual(SUBAGENTS)
    expect(await readdir(elsewhere)).toEqual([])
  })

  test("user scope still writes through a symlinked file, as before", async () => {
    await installed()
    const real = join(home, "dotfiles", "subagents.json")
    await write(real, {})
    await symlink(real, globalSubagents())
    const report = await runSetup(withPi())
    expect(report.ok).toBe(true)
    expect(await read(real)).toEqual(SUBAGENTS)
  })

  test("a record that cannot be written after the file is a failed line naming the file", async () => {
    await installed()
    // A leftover temporary file makes the record's own write fail, while reading it still works.
    await write(
      join(dirname(recordPath({ HOME: home })), `.setup-records.json.${process.pid}.tmp`),
      "",
    )
    const report = await runSetup(withPi())
    expect(report.ok).toBe(false)
    expect(await read(globalSubagents())).toEqual(SUBAGENTS)
    expect(
      toolLines(report).some((line) =>
        line.startsWith(
          `! tool settings: ${globalSubagents()} was written, but its keys could not be recorded`,
        ),
      ),
    ).toBe(true)
  })

  test("a user-scope setup ignores the repository's config", async () => {
    await installed()
    await setProjectConfig({ pi: { features: { subagents: false } } })
    await runSetup(withPi())
    expect(await read(globalSubagents())).toEqual(SUBAGENTS)
  })
})

describe("holyagent doctor, Pi tool settings", () => {
  const lacking = (file: string, keys: string, scope = "") =>
    `~ tool settings ${file} lacks ${keys}; run \`holyagent setup${scope}\``

  test("names each file that lacks keys, with the setup command, without failing", async () => {
    await installed()
    const report = await runDoctor(withPi())
    expect(report.ok).toBe(true)
    expect(toolLines(report)).toEqual([
      lacking(
        globalSettings(),
        "codemode.mode, defaultProvider, defaultModel, defaultThinkingLevel",
      ),
      lacking(globalSubagents(), "disableDefaultAgents, fallbackSubagent"),
      lacking(
        billion(),
        "pi.subagents, guardrails.bashTimeout, guardrails.maxOutputBytes, guardrails.repetition",
      ),
      lacking(piFff(), "mode, enableHomeDirScanning"),
    ])
  })

  test("identifies missing FFF mode and home-scan preference independently", async () => {
    await installed()
    await write(piFff(), { mode: "override", warnOnHomeDirScan: false })
    expect(toolLines(await runDoctor(withPi()))).toContain(
      lacking(piFff(), "enableHomeDirScanning"),
    )
    await write(piFff(), { enableHomeDirScanning: true, warnOnHomeDirScan: false })
    expect(toolLines(await runDoctor(withPi()))).toContain(lacking(piFff(), "mode"))
  })

  test("names the scope in the fix at project and local scope", async () => {
    await installed()
    for (const scope of ["project", "local"] as const) {
      const report = await runDoctor(withPi(), { scope })
      expect(toolLines(report)).toContain(
        lacking(
          projectPi("subagents.json"),
          "disableDefaultAgents, fallbackSubagent",
          ` --scope ${scope}`,
        ),
      )
      // Billion Context has no project file, so there is nothing to ask for at this scope.
      expect(toolLines(report).join("\n")).not.toContain("billion-context")
    }
  })

  test("a key the global file sets is not missing at project scope, and a symlinked folder is reported", async () => {
    await write(globalSettings(), {
      ...FULL(),
      "pi-computer-use": { confirmAppLaunch: true, confirmDangerousActions: true },
    })
    const lines = toolLines(await runDoctor(withPi(), { scope: "project" })).join("\n")
    expect(lines).toContain(projectPi("settings.json"))
    expect(lines).toContain(`${projectPi("settings.json")} lacks codemode.mode, defaultProvider,`)
    expect(lines).not.toContain("pi-computer-use")

    const elsewhere = join(home, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    await symlink(elsewhere, projectPi())
    const linked = toolLines(await runDoctor(withPi(), { scope: "project" }))
    expect(linked.length).toBeGreaterThan(0)
    for (const line of linked) expect(line).toContain(`${projectPi()} is a symlink`)
  })

  test("is quiet once setup has run, and after the user chose other values", async () => {
    await installed()
    await runSetup(withPi())
    expect(toolLines(await runDoctor(withPi()))).toEqual([])
    await write(globalSubagents(), { disableDefaultAgents: false, fallbackSubagent: "Plan" })
    expect(toolLines(await runDoctor(withPi()))).toEqual([])
  })

  test("does not recommend replacing or filling Pi's startup preferences", async () => {
    await write(globalSettings(), { ...FULL(), defaultProvider: "mine" })
    for (const scope of ["user", "project", "local"] as const) {
      const report = await runDoctor(withPi(), { scope })
      expect(report.lines.join("\n")).not.toMatch(
        /root model|default(?:Provider|Model|ThinkingLevel)/,
      )
    }
  })

  test("reports a file that is not a JSON object, and only when Pi is in use and pi.enable is on", async () => {
    await write(globalSubagents(), "nope")
    const broken = toolLines(await runDoctor(withPi()))
    expect(broken.find((line) => line.includes(globalSubagents()))).toStartWith(
      `~ tool settings: ${globalSubagents()} is not a JSON object`,
    )
    expect(broken.find((line) => line.includes(globalSubagents()))).toEndWith(
      "fix the file, then run `holyagent setup`",
    )

    const claudeOnly = await runDoctor(fakeShell({ commands: ["bun", "ctx7"] }))
    expect(toolLines(claudeOnly)).toEqual([])
    const cloud = await runDoctor(withPi(), { env: { CLAUDE_CODE_REMOTE: "true", ...IN_USE } })
    expect(toolLines(cloud)).toEqual([])
    await setConfig({ pi: { enable: false } })
    expect(toolLines(await runDoctor(withPi()))).toEqual([])
  })

  test("leaves the output of a Claude-only machine as it was, in setup and in doctor", async () => {
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = withoutSearchTools(await runDoctor(shell))
    expect(report.lines).toEqual([
      "ok   bun: /fake/bin/bun",
      "ok   ctx7: /fake/bin/ctx7",
      `ok   settings: ${join(home, ".claude", "settings.json")}`,
      "~ pi: not in use (HOLYAGENT_HOST is not pi and pi is not on PATH); Pi checks skipped",
    ])
    const setupReport = await runSetup(fakeShell({ commands: ["bun"] }))
    expect(setupReport.lines.every((line) => !line.includes("tool settings"))).toBe(true)
    expect(setupReport.lines.some((line) => line.startsWith("= attribution.commit"))).toBe(true)
    expect(await exists(globalSettings())).toBe(false)
  })
})

describe("holyagent setup --undo, Pi tool settings", () => {
  test("preserves user-owned Kimi permissions through setup, doctor and undo", async () => {
    await installed()
    const permissions = {
      tools: { moonshot_search: { enabled: false }, moonshot_fetch: { enabled: true } },
      region: "global",
    }
    await write(globalKimi(), permissions)
    await runSetup(withPi())
    const doctorReport = await runDoctor(withPi())
    expect(toolLines(doctorReport).join("\n")).not.toContain(globalKimi())
    await runSetup(withPi(), { undo: true })
    expect(await read(globalKimi())).toEqual(permissions)
  })

  test("undo honors Kimi permissions recorded by an older setup", async () => {
    await write(globalKimi(), {
      tools: { moonshot_search: { enabled: true }, moonshot_fetch: { enabled: false } },
      region: "global",
    })
    await Effect.runPromise(
      addRecorded({ HOME: home }, globalKimi(), [
        { path: ["tools", "moonshot_search", "enabled"], value: true },
        { path: ["tools", "moonshot_fetch", "enabled"], value: true },
      ]),
    )
    const report = await runSetup(withPi(), { undo: true })
    expect(await read(globalKimi())).toEqual({
      tools: { moonshot_fetch: { enabled: false } },
      region: "global",
    })
    expect(toolLines(report).join("\n")).toContain(
      "kept tools.moonshot_fetch.enabled false (setup wrote true)",
    )
  })

  test("removes the keys setup added while they still equal what it wrote, and keeps everything else", async () => {
    await write(globalSettings(), { ...FULL(), theme: "dark", codemode: { inlineBudget: 5 } })
    await write(globalSubagents(), { maxConcurrent: 3 })
    await runSetup(withPi())
    expect(await read(globalSubagents())).toEqual({ maxConcurrent: 3, ...SUBAGENTS })

    const report = await runSetup(withPi(), { undo: true })
    expect(report.ok).toBe(true)
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      theme: "dark",
      codemode: { inlineBudget: 5 },
    })
    expect(await read(globalSubagents())).toEqual({ maxConcurrent: 3 })
    // A file setup created and nothing else lives in is left as an empty object.
    expect(await exists(globalKimi())).toBe(false)
    expect(await read(billion())).toEqual({})
    expect(toolLines(report)).toContain(
      `- tool settings ${globalSubagents()}: removed disableDefaultAgents true, fallbackSubagent "none"`,
    )
    expect(report.lines.some((line) => line.startsWith("~ ctx7: left installed"))).toBe(true)
  })

  const recordLegacyModel = () =>
    Effect.runPromise(
      addRecorded(
        { HOME: home },
        globalSettings(),
        Object.entries(MODEL).map(([key, value]) => ({ path: [key] as const, value })),
      ),
    )

  test("undo leaves native Pi settings unless an old setup recorded the exact values", async () => {
    const native = { ...FULL(), ...MODEL }
    await write(globalSettings(), native)
    await runSetup(withPi())
    await runSetup(withPi(), { undo: true })
    expect(await read(globalSettings())).toEqual(native)

    await recordLegacyModel()
    const report = await runSetup(withPi(), { undo: true })
    expect(await read(globalSettings())).toEqual(FULL())
    expect(toolLines(report).join("\n")).toContain("removed defaultProvider")
  })

  test("legacy undo keeps both of the pair if either changed, and removes unchanged thinking", async () => {
    const pair = { defaultProvider: MODEL.defaultProvider, defaultModel: MODEL.defaultModel }
    for (const change of [
      { defaultProvider: "mine" },
      { defaultModel: "changed" },
      { defaultProvider: "mine", defaultModel: "changed" },
    ]) {
      await recordLegacyModel()
      await write(globalSettings(), { ...FULL(), ...MODEL, ...change })
      const lines = toolLines(await runSetup(withPi(), { undo: true })).join("\n")
      expect(await read(globalSettings())).toEqual({ ...FULL(), ...pair, ...change })
      expect(lines).toContain("removed defaultThinkingLevel")
      expect(lines).toContain("kept defaultProvider")
      expect(lines).toContain("defaultModel")
    }
  })

  test("keeps a value the user changed since, and a key the user already had before setup", async () => {
    await write(globalSettings(), { ...FULL(), codemode: { mode: "only" } })
    await write(billion(), BILLION_SUBAGENTS)
    await runSetup(withPi())
    await write(globalSubagents(), { disableDefaultAgents: true, fallbackSubagent: "Plan" })
    await write(globalKimi(), { tools: { moonshot_search: { enabled: false } } })

    const report = await runSetup(withPi(), { undo: true })
    // codemode.mode was the user's before setup, so it was never recorded and stays.
    expect(await read(globalSettings())).toEqual({ ...FULL(), codemode: { mode: "only" } })
    expect(await read(billion())).toEqual(BILLION_SUBAGENTS)
    expect(await read(globalSubagents())).toEqual({ fallbackSubagent: "Plan" })
    expect(await read(globalKimi())).toEqual({ tools: { moonshot_search: { enabled: false } } })
    expect(toolLines(report).join("\n")).toContain(
      'kept fallbackSubagent "Plan" (setup wrote "none")',
    )
  })

  test("touches nothing setup did not record, and forgets the record afterwards", async () => {
    await write(globalSubagents(), SUBAGENTS)
    const before = await Bun.file(globalSubagents()).text()
    const none = await runSetup(withPi(), { undo: true })
    expect(toolLines(none)).toEqual([])
    expect(await Bun.file(globalSubagents()).text()).toBe(before)

    await installed()
    await runSetup(withPi())
    await runSetup(withPi(), { undo: true })
    const again = await runSetup(withPi(), { undo: true })
    expect(toolLines(again)).toEqual([])
  })

  test("a dry run says what it would remove and changes neither the files nor the record", async () => {
    await installed()
    await runSetup(withPi())
    const before = await Bun.file(globalSubagents()).text()
    const dry = await runSetup(withPi(), { undo: true, dryRun: true })
    expect(toolLines(dry).some((line) => line.includes("would remove"))).toBe(true)
    expect(toolLines(dry).every((line) => line.endsWith("(dry run, nothing written)"))).toBe(true)
    expect(await Bun.file(globalSubagents()).text()).toBe(before)

    const real = await runSetup(withPi(), { undo: true })
    expect(toolLines(real).some((line) => line.includes("removed"))).toBe(true)
    expect(await read(globalSubagents())).toEqual({})
  })

  test("backs out a feature the config has turned off since, and needs neither Pi nor the config", async () => {
    await installed()
    await runSetup(withPi())
    await setConfig({ pi: { enable: false } })
    const claudeOnly = fakeShell({ commands: ["bun"] })
    const report = await runSetup(claudeOnly, { undo: true })
    expect(await read(globalSubagents())).toEqual({})
    expect(toolLines(report).length).toBe(4)
    expect(claudeOnly.calls).toEqual([])
  })

  test("project scope backs out the project's files only", async () => {
    await installed()
    // Project first: a key the global file sets is left out of the project's files.
    await runSetup(withPi(), { scope: "project" })
    await runSetup(withPi())
    await runSetup(withPi(), { scope: "project", undo: true })
    expect(await read(projectPi("subagents.json"))).toEqual({})
    expect(await read(globalSubagents())).toEqual(SUBAGENTS)
  })

  test("project and local scope refuse to undo through a symlink", async () => {
    await installed()
    for (const scope of ["project", "local"] as const) {
      await runSetup(withPi(), { scope })
      // The repository swaps the settings file for a link to the user's own, holding the same values.
      await write(globalSettings(), { ...FULL(), ...CODEMODE })
      const globalBefore = await Bun.file(globalSettings()).text()
      await rm(projectPi("settings.json"))
      await symlink(globalSettings(), projectPi("settings.json"))
      const report = await runSetup(withPi(), { scope, undo: true })
      expect(report.ok).toBe(false)
      expect(toolLines(report)).toContain(
        `! tool settings: ${projectPi("settings.json")} is a symlink; refusing to edit through it in the ${scope} scope. Replace it with a real file and run again`,
      )
      expect(await Bun.file(globalSettings()).text()).toBe(globalBefore)
      await rm(projectPi(), { recursive: true })
      await write(globalSettings(), FULL())
    }
  })

  test("a file that is not a JSON object is a failed line and stays as it is", async () => {
    await installed()
    await runSetup(withPi())
    await write(globalSubagents(), "{ broken")
    const report = await runSetup(withPi(), { undo: true })
    expect(report.ok).toBe(false)
    expect(await Bun.file(globalSubagents()).text()).toBe("{ broken")
    expect(toolLines(report).some((line) => line.startsWith("! tool settings: "))).toBe(true)
    expect(await exists(globalKimi())).toBe(false)
  })
})
