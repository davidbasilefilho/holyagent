import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { version } from "../../../package.json" with { type: "json" }
import { piPackages } from "../src/config/packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { doctor } from "../src/setup/doctor.ts"
import { PI_HOST_VERSION } from "../src/setup/pi-check.ts"
import { recordPath } from "../src/setup/record.ts"
import { setup } from "../src/setup/steps.ts"
import { fakeShell, scratch, writeCompleteSettings } from "./setup-fixture.ts"

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
    commands: ["bun", "ctx7", "pi", "node"],
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
      { HOME: home, ...extra.env },
      { fix: false, cwd: project, scope: extra.scope ?? "user" },
    ).pipe(Effect.provide(shell.layer)),
  )

const toolLines = (report: { readonly lines: ReadonlyArray<string> }) =>
  report.lines.filter((line) => /^[+=~!-] tool settings/.test(line))

const CODEMODE = { codemode: { mode: "only" } }
const COMPUTER_USE = {
  "pi-computer-use": { confirmAppLaunch: false, confirmDangerousActions: false },
}
const KIMI = { tools: { moonshot_search: { enabled: true }, moonshot_fetch: { enabled: true } } }
const SUBAGENTS = { disableDefaultAgents: true, fallbackSubagent: "none" }
const BILLION = { pi: { subagents: false } }

describe("holyagent setup, Pi tool settings", () => {
  test("writes every key toolSettings returns into Pi's global files, beside what the files hold", async () => {
    await installed()
    const shell = withPi()
    const report = await runSetup(shell)
    expect(report.ok).toBe(true)
    expect(await read(globalSettings())).toEqual({ ...FULL(), ...CODEMODE, ...COMPUTER_USE })
    expect(await read(globalSubagents())).toEqual(SUBAGENTS)
    expect(await read(globalKimi())).toEqual(KIMI)
    expect(await read(billion())).toEqual(BILLION)
    // One line per file, none of which is a process.
    expect(toolLines(report)).toHaveLength(4)
    expect(toolLines(report)).toContain(
      `+ tool settings ${globalSubagents()}: added disableDefaultAgents true, fallbackSubagent "none"`,
    )
    expect(shell.calls).toEqual([])
  })

  test("a second run changes nothing and says so", async () => {
    await installed()
    await runSetup(withPi())
    const before = await Promise.all(
      [globalSettings(), globalSubagents(), globalKimi(), billion()].map((file) =>
        Bun.file(file).text(),
      ),
    )
    const report = await runSetup(withPi())
    expect(toolLines(report).every((line) => line.startsWith("= tool settings "))).toBe(true)
    expect(toolLines(report)).toHaveLength(4)
    expect(
      await Promise.all(
        [globalSettings(), globalSubagents(), globalKimi(), billion()].map((file) =>
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
    })
    expect(await read(globalSubagents())).toEqual({
      disableDefaultAgents: false,
      fallbackSubagent: "Explore",
    })
    expect(await read(globalKimi())).toEqual({
      tools: { moonshot_search: { enabled: false }, moonshot_fetch: { enabled: true } },
      region: "global",
    })
    expect(await read(billion())).toEqual({ pi: { subagents: { enabled: true } }, port: 1 })
    expect(toolLines(report)).toContain(
      `~ tool settings ${billion()}: kept pi.subagents {"enabled":true} (HolyAgent sets false; yours wins)`,
    )
    expect(toolLines(report).join("\n")).toContain(
      'kept codemode.mode "on" (HolyAgent sets "only"; yours wins)',
    )
  })

  test("leaves out a key whose value is the package default", async () => {
    await setConfig({ pi: { codemode: { mode: "on" } } })
    await installed()
    const report = await runSetup(withPi())
    expect(await read(globalSettings())).toEqual({ ...FULL(), ...COMPUTER_USE })
    expect(toolLines(report).join("\n")).toContain("left out, the package default: codemode.mode")
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
    expect(await read(globalKimi())).toEqual(KIMI)
    expect(await read(globalSettings())).toEqual({ ...FULL(), ...CODEMODE, ...COMPUTER_USE })
  })

  test("writes through a temporary file that is gone afterwards, keeping the file's mode", async () => {
    await installed()
    await chmod(globalSettings(), 0o640)
    await runSetup(withPi())
    expect((await readdir(dirname(globalSettings()))).sort()).toEqual([
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
    for (const file of [globalSubagents(), globalKimi(), billion()]) {
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
    expect(await read(globalSettings())).toEqual({ ...FULL(), ...CODEMODE })
    expect(await exists(globalSubagents())).toBe(false)
    expect(await exists(billion())).toBe(false)
    expect(await read(globalKimi())).toEqual(KIMI)
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
    })
    expect(await read(join(agent, "subagents.json"))).toEqual(SUBAGENTS)
    expect(await read(bili)).toEqual(BILLION)
    expect(await exists(globalSettings())).toBe(false)
    // The provider's own file stays under the home directory, where the package reads it.
    expect(await read(globalKimi())).toEqual(KIMI)

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
      expect(await read(projectPi("settings.json"))).toEqual({ ...CODEMODE, ...COMPUTER_USE })
      expect(await read(projectPi("providers", "kimi-coding", "config.json"))).toEqual(KIMI)
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
      })
      expect(await read(projectPi("providers", "kimi-coding", "config.json"))).toEqual({
        tools: { moonshot_fetch: { enabled: true } },
      })
      const lines = toolLines(report).join("\n")
      expect(lines).toContain("left out, set in your global file: pi-computer-use.confirmAppLaunch")
      expect(lines).toContain("left out, set in your global file: tools.moonshot_search.enabled")
    }
    // The global files are as the user left them.
    expect(await read(globalKimi())).toEqual({ tools: { moonshot_search: { enabled: false } } })
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
      expect(await read(projectPi("providers", "kimi-coding", "config.json"))).toEqual(KIMI)
    }
  })

  test("a symlink below the .pi folder is refused too", async () => {
    const elsewhere = join(home, "elsewhere")
    await mkdir(elsewhere, { recursive: true })
    await mkdir(projectPi(), { recursive: true })
    await symlink(elsewhere, projectPi("providers"))
    const report = await runSetup(withPi(), { scope: "project" })
    expect(report.ok).toBe(false)
    expect(toolLines(report).join("\n")).toContain(`${projectPi("providers")} is a symlink`)
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
        "codemode.mode, pi-computer-use.confirmAppLaunch, pi-computer-use.confirmDangerousActions",
      ),
      lacking(globalKimi(), "tools.moonshot_search.enabled, tools.moonshot_fetch.enabled"),
      lacking(globalSubagents(), "disableDefaultAgents, fallbackSubagent"),
      lacking(billion(), "pi.subagents"),
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
    expect(lines).toContain(`${projectPi("settings.json")} lacks codemode.mode;`)
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
    const report = await runDoctor(shell)
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
    expect(await read(globalKimi())).toEqual({})
    expect(await read(billion())).toEqual({})
    expect(toolLines(report)).toContain(
      `- tool settings ${globalSubagents()}: removed disableDefaultAgents true, fallbackSubagent "none"`,
    )
    expect(report.lines.some((line) => line.startsWith("~ ctx7: left installed"))).toBe(true)
  })

  test("keeps a value the user changed since, and a key the user already had before setup", async () => {
    await write(globalSettings(), { ...FULL(), codemode: { mode: "only" } })
    await write(billion(), BILLION)
    await runSetup(withPi())
    await write(globalSubagents(), { disableDefaultAgents: true, fallbackSubagent: "Plan" })
    await write(globalKimi(), { tools: { moonshot_search: { enabled: false } } })

    const report = await runSetup(withPi(), { undo: true })
    // codemode.mode was the user's before setup, so it was never recorded and stays.
    expect(await read(globalSettings())).toEqual({ ...FULL(), codemode: { mode: "only" } })
    expect(await read(billion())).toEqual(BILLION)
    expect(await read(globalSubagents())).toEqual({ fallbackSubagent: "Plan" })
    expect(await read(globalKimi())).toEqual({ tools: { moonshot_search: { enabled: false } } })
    expect(toolLines(report).join("\n")).toContain(
      'kept fallbackSubagent "Plan" (setup wrote "none")',
    )
    expect(toolLines(report).join("\n")).toContain(
      "kept tools.moonshot_search.enabled false (setup wrote true)",
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
      await write(globalSettings(), { ...FULL(), ...CODEMODE, ...COMPUTER_USE })
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
    expect(await read(globalKimi())).toEqual({})
  })
})
