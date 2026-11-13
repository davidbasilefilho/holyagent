import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { version } from "../../../package.json" with { type: "json" }
import { piPackages } from "../src/config/packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { BILLION_CONTEXT_GUARDRAILS_FILE } from "../src/pi/bash/guardrails.ts"
import { doctor } from "../src/setup/doctor.ts"
import { PI_HOST_VERSION } from "../src/setup/pi-check.ts"
import { addRecorded, recordPath } from "../src/setup/record.ts"
import { setup } from "../src/setup/steps.ts"
import { fakeShell, scratch, withoutSearchTools, writeCompleteSettings } from "./setup-fixture.ts"

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
    commands: ["bun", "ctx7", "pi", "node", "npx"],
    respond: (line) =>
      line === "pi --version"
        ? { stdout: `${PI_HOST_VERSION}\n` }
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
/**
 * The root route of the default config, as Pi's settings hold it (`medium` would be Pi's own
 * default).
 */
const MODEL = {
  defaultProvider: "kimi-coding",
  defaultModel: "k3.1-pro",
  defaultThinkingLevel: "high",
}
const COMPUTER_USE = {
  "pi-computer-use": { confirmAppLaunch: false, confirmDangerousActions: false },
}
const SUBAGENTS = { disableDefaultAgents: true, fallbackSubagent: "none" }
/**
 * `@ff-labs/pi-fff`'s file with the override mode that puts its tools in place of Pi's. Setup
 * leaves `followSymlinks` out, so the package follows directory links by its own default.
 */
const PI_FFF = { mode: "override" }
const BILLION_SUBAGENTS = { pi: { subagents: false } }
/** What setup writes into Billion Context's file: the subagents setting and the guardrails off. */
const BILLION = { ...BILLION_SUBAGENTS, ...BILLION_CONTEXT_GUARDRAILS_FILE }

describe("holyagent setup, Pi tool settings", () => {
  test("writes every key toolSettings returns into Pi's global files, beside what the files hold", async () => {
    await installed()
    const shell = withPi()
    const report = await runSetup(shell)
    expect(report.ok).toBe(true)
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      ...CODEMODE,
      ...COMPUTER_USE,
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
      codemode: { mode: "on", inlineBudget: 100 },
      "pi-computer-use": { confirmAppLaunch: true, confirmDangerousActions: false },
      ...MODEL,
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
    expect(await read(globalSettings())).toEqual({ ...FULL(), ...COMPUTER_USE, ...MODEL })
    expect(toolLines(report).join("\n")).toContain("left out, the package default: codemode.mode")
  })

  test("writes the root route's provider and model together only when the user chose neither", async () => {
    await write(globalSettings(), { ...FULL(), theme: "dark" })
    const report = await runSetup(withPi())
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      ...CODEMODE,
      ...COMPUTER_USE,
      ...MODEL,
      theme: "dark",
    })
    const lines = toolLines(report).join("\n")
    expect(lines).toContain('defaultProvider "kimi-coding"')
    expect(lines).toContain('defaultModel "k3.1-pro"')
    expect(lines).toContain('defaultThinkingLevel "high"')
  })

  test("writes neither of provider and model when the user set one, and still the thinking level", async () => {
    const halves = [{ defaultProvider: "mine" }, { defaultModel: "my-model" }]
    for (const half of halves) {
      await write(globalSettings(), { ...FULL(), ...half, theme: "dark" })
      const report = await runSetup(withPi())
      expect(await read(globalSettings())).toEqual({
        ...FULL(),
        ...CODEMODE,
        ...COMPUTER_USE,
        ...half,
        defaultThinkingLevel: "high",
        theme: "dark",
      })
      const [other] = Object.keys(half).includes("defaultModel")
        ? ["defaultProvider"]
        : ["defaultModel"]
      expect(toolLines(report).join("\n")).toContain(
        `left out, the other of defaultProvider and defaultModel is yours: ${other}`,
      )
    }
  })

  test("project and local scope write the pair only while neither half is set in the project file or the global file", async () => {
    for (const scope of ["project", "local"] as const) {
      await rm(projectPi(), { recursive: true, force: true })
      await write(globalSettings(), FULL())
      await runSetup(withPi(), { scope })
      expect(await read(projectPi("settings.json"))).toMatchObject(MODEL)

      // One half in the project's own file.
      for (const half of [{ defaultProvider: "mine" }, { defaultModel: "my-model" }]) {
        await write(projectPi("settings.json"), half)
        const report = await runSetup(withPi(), { scope })
        const settings = await read(projectPi("settings.json"))
        expect(settings).toMatchObject({ ...half, defaultThinkingLevel: "high" })
        for (const key of ["defaultProvider", "defaultModel"]) {
          if (!(key in half)) expect(settings).not.toHaveProperty(key)
        }
        expect(toolLines(report).join("\n")).toContain("is yours:")
      }

      // One half in the user's global file.
      await rm(projectPi(), { recursive: true, force: true })
      for (const half of [{ defaultProvider: "mine" }, { defaultModel: "my-model" }]) {
        await write(globalSettings(), { ...FULL(), ...half })
        const report = await runSetup(withPi(), { scope })
        const settings = await read(projectPi("settings.json"))
        expect(settings).toMatchObject({ defaultThinkingLevel: "high" })
        expect(settings).not.toHaveProperty("defaultProvider")
        expect(settings).not.toHaveProperty("defaultModel")
        const lines = toolLines(report).join("\n")
        expect(lines).toContain(`left out, set in your global file: ${Object.keys(half)[0]}`)
        expect(lines).toContain("is yours:")
        await rm(projectPi(), { recursive: true, force: true })
      }
    }
  })

  test("follows the route table of the config, and leaves out a thinking level equal to Pi's own default", async () => {
    await setConfig({ pi: { routes: { root: { model: "kimi-for-coding", thinking: "medium" } } } })
    await installed()
    const report = await runSetup(withPi())
    expect(await read(globalSettings())).toEqual({
      ...FULL(),
      ...CODEMODE,
      ...COMPUTER_USE,
      defaultProvider: "kimi-coding",
      defaultModel: "kimi-for-coding",
    })
    expect(toolLines(report).join("\n")).toContain(
      "left out, the package default: defaultThinkingLevel",
    )
    await setConfig({ pi: { routes: { root: { thinking: "max" } } } })
    await runSetup(withPi())
    expect(await read(globalSettings())).toMatchObject({ defaultThinkingLevel: "max" })
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
      ...COMPUTER_USE,
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
    const REMOVED = () => `- tool settings ${piFff()}: removed mode "override"`

    test("puts pi-fff in override mode in Pi's agent folder, beside what the file holds", async () => {
      await installed()
      await write(piFff(), { enableHomeDirScanning: false })
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ enableHomeDirScanning: false, ...PI_FFF })
      expect(toolLines(report)).toContain(ADDED())
    })

    test("never writes followSymlinks, so the package follows directory links by its own default", async () => {
      await installed()
      await runSetup(withPi())
      expect(await read(piFff())).not.toHaveProperty("followSymlinks")
      await write(piFff(), { followSymlinks: true })
      await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: true, mode: "override" })
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
      expect(await read(piFff())).toEqual({ mode: "override", followSymlinks: false })
    })

    test("leaves a followSymlinks false that setup did not record", async () => {
      await installed()
      await write(piFff(), { followSymlinks: false })
      await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: false, mode: "override" })
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
      await write(piFff(), { mode: "tools-only" })
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ mode: "tools-only" })
      expect(toolLines(report)).toContain(
        `~ tool settings ${piFff()}: kept mode "tools-only" (HolyAgent sets "override"; yours wins)`,
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
      expect(await read(piFff())).toEqual({ enableHomeDirScanning: false, ...PI_FFF })
      await setConfig(off)
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ enableHomeDirScanning: false })
      expect(toolLines(report)).toContain(REMOVED())
    })

    test("keeps a followSymlinks the user chose, and takes out only the keys it wrote", async () => {
      await installed()
      await write(piFff(), { followSymlinks: true })
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: true, mode: "override" })
      expect(toolLines(report)).toContain(ADDED())
      await setConfig(off)
      const reverted = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ followSymlinks: true })
      expect(toolLines(reverted)).toContain(`- tool settings ${piFff()}: removed mode "override"`)
    })

    test("leaves a value the user changed after setup", async () => {
      await installed()
      await runSetup(withPi())
      await write(piFff(), { mode: "tools-only", followSymlinks: true })
      await setConfig(off)
      const report = await runSetup(withPi())
      expect(await read(piFff())).toEqual({ mode: "tools-only", followSymlinks: true })
      expect(toolLines(report)).toContain(
        `~ tool settings ${piFff()}: kept mode "tools-only" (setup wrote "override")`,
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

    test("has no file at project and local scope, since the package reads Pi's agent folder only", async () => {
      await installed()
      for (const scope of ["project", "local"] as const) {
        const report = await runSetup(withPi(), { scope })
        expect(toolLines(report)).toContain(
          `- tool settings ~/.pi/agent/pi-fff.json: has no file at ${scope} scope; run \`holyagent setup\` at user scope`,
        )
        expect(await exists(projectPi("pi-fff.json"))).toBe(false)
      }
      expect(await exists(piFff())).toBe(false)
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
        `- tool settings ${piFff()}: removed mode "override"`,
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
      ...COMPUTER_USE,
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
        ...COMPUTER_USE,
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
        "pi-computer-use": { confirmDangerousActions: false },
        ...MODEL,
      })
      expect(await exists(projectPi("providers", "kimi-coding", "config.json"))).toBe(false)
      const lines = toolLines(report).join("\n")
      expect(lines).toContain("left out, set in your global file: pi-computer-use.confirmAppLaunch")
    }
    // The global files are as the user left them.
    expect(await read(globalKimi())).toEqual({ tools: { moonshot_search: { enabled: false } } })
  })

  test("project and local scope leave the model keys the user's global file sets", async () => {
    await write(globalSettings(), { ...FULL(), defaultProvider: "mine", defaultModel: "m1" })
    for (const scope of ["project", "local"] as const) {
      const report = await runSetup(withPi(), { scope })
      expect(await read(projectPi("settings.json"))).toMatchObject({ defaultThinkingLevel: "high" })
      expect(await read(projectPi("settings.json"))).not.toHaveProperty("defaultModel")
      expect(await read(projectPi("settings.json"))).not.toHaveProperty("defaultProvider")
      expect(toolLines(report).join("\n")).toContain(
        "left out, set in your global file: defaultProvider, defaultModel",
      )
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
        "codemode.mode, pi-computer-use.confirmAppLaunch, pi-computer-use.confirmDangerousActions, defaultProvider, defaultModel, defaultThinkingLevel",
      ),
      lacking(globalSubagents(), "disableDefaultAgents, fallbackSubagent"),
      lacking(
        billion(),
        "pi.subagents, guardrails.bashTimeout, guardrails.maxOutputBytes, guardrails.repetition",
      ),
      lacking(piFff(), "mode"),
    ])
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
    expect(lines).toContain(
      `${projectPi("settings.json")} lacks codemode.mode, defaultProvider, defaultModel, defaultThinkingLevel;`,
    )
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

  const rootModel = (report: { readonly lines: ReadonlyArray<string> }) =>
    report.lines.filter((line) => line.includes("root model"))

  test("reports the root model as set once setup wrote it, and says nothing while a key is unset", async () => {
    await installed()
    expect(rootModel(await runDoctor(withPi()))).toEqual([])
    await runSetup(withPi())
    expect(rootModel(await runDoctor(withPi()))).toEqual([
      `ok   root model: kimi-coding/k3.1-pro:high set in Pi's settings (${globalSettings()})`,
    ])
    // A thinking level equal to Pi's default is unset by design and counts as set.
    await setConfig({ pi: { routes: { root: { thinking: "medium" } } } })
    await write(globalSettings(), {
      ...FULL(),
      defaultProvider: "kimi-coding",
      defaultModel: "k3.1-pro",
    })
    expect(rootModel(await runDoctor(withPi()))).toEqual([
      `ok   root model: kimi-coding/k3.1-pro:medium set in Pi's settings (${globalSettings()})`,
    ])
  })

  test("reports a model key the user set to another value as theirs, without failing", async () => {
    await write(globalSettings(), {
      ...FULL(),
      defaultProvider: "kimi-coding",
      defaultModel: "my-model",
      defaultThinkingLevel: "low",
    })
    const report = await runDoctor(withPi())
    expect(report.ok).toBe(true)
    expect(rootModel(report)).toEqual([
      `~ root model ${globalSettings()}: defaultModel "my-model" is yours (the route sets "k3.1-pro"), defaultThinkingLevel "low" is yours (the route sets "high"); Pi follows yours`,
    ])
  })

  test("at project scope the global file's model counts, and the project's own wins over it", async () => {
    await write(globalSettings(), { ...FULL(), ...MODEL, defaultModel: "global-model" })
    const [line] = rootModel(await runDoctor(withPi(), { scope: "project" }))
    expect(line).toContain('defaultModel "global-model" is yours')
    await write(projectPi("settings.json"), { defaultModel: "k3.1-pro" })
    expect(rootModel(await runDoctor(withPi(), { scope: "project" }))).toEqual([
      `ok   root model: kimi-coding/k3.1-pro:high set in Pi's settings (${projectPi("settings.json")})`,
    ])
  })

  test("reports a provider or model the user set alone as theirs, naming the unset half, at user and project scope", async () => {
    for (const [half, other] of [
      [{ defaultProvider: "mine" }, "defaultModel"],
      [{ defaultModel: "my-model" }, "defaultProvider"],
    ] as const) {
      const [key] = Object.keys(half)
      const value = Object.values(half)[0]
      const wanted = other === "defaultModel" ? "k3.1-pro" : "kimi-coding"
      const mine = `${key} "${value}" is yours (the route sets "${key === "defaultModel" ? "k3.1-pro" : "kimi-coding"}")`
      const unset = `${other} is unset, so Pi picks it (the route sets "${wanted}")`

      await write(globalSettings(), { ...FULL(), ...half })
      expect(rootModel(await runDoctor(withPi()))).toEqual([
        `~ root model ${globalSettings()}: ${mine}, ${unset}; Pi follows yours`,
      ])

      // At project scope the same holds for the project's own file and for the global one.
      await write(globalSettings(), FULL())
      await write(projectPi("settings.json"), half)
      expect(rootModel(await runDoctor(withPi(), { scope: "project" }))).toEqual([
        `~ root model ${projectPi("settings.json")}: ${mine}, ${unset}; Pi follows yours`,
      ])
      await rm(projectPi(), { recursive: true, force: true })
      await write(globalSettings(), { ...FULL(), ...half })
      expect(rootModel(await runDoctor(withPi(), { scope: "project" }))).toEqual([
        `~ root model ${projectPi("settings.json")}: ${mine}, ${unset}; Pi follows yours`,
      ])
      await rm(projectPi(), { recursive: true, force: true })
    }
  })

  test("a provider that equals the route with no model is still reported, not counted as set", async () => {
    await write(globalSettings(), { ...FULL(), defaultProvider: "kimi-coding" })
    expect(rootModel(await runDoctor(withPi()))).toEqual([
      `~ root model ${globalSettings()}: defaultModel is unset, so Pi picks it (the route sets "k3.1-pro")`,
    ])
  })

  test("does not list the pair as lacking once the user holds half of it", async () => {
    await write(globalSettings(), { ...FULL(), defaultProvider: "mine" })
    const lacks = toolLines(await runDoctor(withPi())).find((line) =>
      line.includes(`${globalSettings()} lacks`),
    )
    expect(lacks).toContain("defaultThinkingLevel")
    expect(lacks).not.toContain("defaultModel")
    expect(lacks).not.toContain("defaultProvider")
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

  test("removes the pair setup wrote, and leaves the user's own half and the thinking level it did not write", async () => {
    await write(globalSettings(), { ...FULL(), defaultProvider: "mine" })
    await runSetup(withPi())
    expect(await read(globalSettings())).toMatchObject({
      defaultProvider: "mine",
      defaultThinkingLevel: "high",
    })
    expect(await read(globalSettings())).not.toHaveProperty("defaultModel")
    await runSetup(withPi(), { undo: true })
    expect(await read(globalSettings())).toEqual({ ...FULL(), defaultProvider: "mine" })

    await write(globalSettings(), FULL())
    await runSetup(withPi())
    const report = await runSetup(withPi(), { undo: true })
    expect(await read(globalSettings())).toEqual(FULL())
    expect(toolLines(report).join("\n")).toContain("removed")
  })

  test("keeps both of the pair when the user changed either since setup wrote it", async () => {
    const pair = { defaultProvider: MODEL.defaultProvider, defaultModel: MODEL.defaultModel }
    for (const change of [
      { defaultProvider: "mine" },
      { defaultModel: "changed" },
      { defaultProvider: "mine", defaultModel: "changed" },
    ]) {
      await write(globalSettings(), FULL())
      await runSetup(withPi())
      await write(globalSettings(), { ...FULL(), ...MODEL, ...change })
      const lines = toolLines(await runSetup(withPi(), { undo: true })).join("\n")
      // The thinking level is its own key and goes as before.
      expect(await read(globalSettings())).toEqual({ ...FULL(), ...pair, ...change })
      expect(lines).toContain("removed defaultThinkingLevel")
      expect(lines).toContain("kept defaultProvider")
      expect(lines).toContain("defaultModel")
    }
    await write(globalSettings(), FULL())
    await runSetup(withPi())
    await write(globalSettings(), { ...FULL(), ...MODEL, defaultModel: "changed" })
    const line = toolLines(await runSetup(withPi(), { undo: true })).join("\n")
    expect(line).toContain('defaultModel "changed" (setup wrote "k3.1-pro")')
    expect(line).toContain(
      'defaultProvider "kimi-coding" (setup wrote "kimi-coding"; kept with its changed pair)',
    )
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
      await write(globalSettings(), { ...FULL(), ...CODEMODE, ...COMPUTER_USE, ...MODEL })
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
