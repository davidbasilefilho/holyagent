import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { CAPABILITIES } from "../src/config/capabilities.ts"
import { piPackages } from "../src/config/packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { chooseForm } from "../src/setup/form.ts"
import { setup } from "../src/setup/steps.ts"
import { fakeShell, scratch, writeCompleteSettings } from "./setup-fixture.ts"

let home: string
let project: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-capabilities-")
  home = join(made.directory, "home")
  project = join(made.directory, "project")
  await mkdir(project, { recursive: true })
  await writeCompleteSettings(join(home, ".claude"))
  remove = made.remove
})
afterEach(() => remove())

const DEFAULT = await Effect.runPromise(defaultConfig)
const ALL = piPackages(DEFAULT)
const TODO = ALL.find((source) => source.includes("rpiv-todo")) as string
const COMPUTER_USE = ALL.find((source) => source.includes("pi-computer-use")) as string

const write = async (file: string, content: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
}
const read = async (file: string) => JSON.parse(await Bun.file(file).text()) as unknown
const userConfig = () => join(home, ".holyagent", "config.json")
const projectConfig = () => join(project, ".holyagent", "config.json")
const globalSettings = () => join(home, ".pi", "agent", "settings.json")
const IN_USE = { HOLYAGENT_HOST: "pi" }
const withPi = () => fakeShell({ commands: ["bun", "pi"] })
const piCommands = (shell: ReturnType<typeof fakeShell>) =>
  shell.calls.filter((call) => call.command === "pi").map((call) => call.line)

const runSetup = (
  shell: ReturnType<typeof fakeShell>,
  extra: {
    scope?: "user" | "project" | "local"
    dryRun?: boolean
    capabilities?: Parameters<typeof setup>[1]["capabilities"]
    form?: "headless" | "normal"
  } = {},
) =>
  Effect.runPromise(
    setup(
      { ...IN_USE, HOME: home },
      {
        scope: extra.scope ?? "user",
        cwd: project,
        subagentCacheTtl: "1h",
        dryRun: extra.dryRun ?? false,
        skipCtx7: true,
        ...(extra.capabilities === undefined ? {} : { capabilities: extra.capabilities }),
        ...(extra.form === undefined ? {} : { form: chooseForm({}, extra.form) }),
      },
    ).pipe(Effect.provide(shell.layer)),
  )

describe("a capability flag in setup", () => {
  test("turning one off writes only that key, removes its package and keeps the rest of the config", async () => {
    await write(userConfig(), {
      vcs: { allowWords: ["Claude Code"] },
      pi: { features: { ask: false }, codemode: { maxWorkers: 2 } },
    })
    await write(globalSettings(), { packages: ALL })
    const shell = withPi()
    const report = await runSetup(shell, { capabilities: { todo: false } })
    expect(await read(userConfig())).toEqual({
      vcs: { allowWords: ["Claude Code"] },
      pi: { features: { ask: false, todo: false }, codemode: { maxWorkers: 2 } },
    })
    expect(report.lines).toContain(
      `- capability todo: turned off (pi.features.todo in ${userConfig()})`,
    )
    expect(piCommands(shell)).toContain("pi remove npm:@juicesharp/rpiv-todo")
  })

  test("turning one on installs its package in the same run", async () => {
    await write(userConfig(), { pi: { features: { todo: false } } })
    await write(globalSettings(), { packages: ALL.filter((source) => source !== TODO) })
    const shell = withPi()
    const report = await runSetup(shell, { capabilities: { todo: true } })
    expect((await read(userConfig())) as object).toEqual({ pi: { features: { todo: true } } })
    expect(report.lines).toContain(
      `+ capability todo: turned on (pi.features.todo in ${userConfig()})`,
    )
    expect(piCommands(shell)).toEqual([`pi install ${TODO}`])
  })

  test("fff off removes @ff-labs/pi-fff and the override mode setup wrote, so Pi keeps its own find and grep; on installs and sets it again", async () => {
    const piFff = join(home, ".pi", "agent", "pi-fff.json")
    const FFF = ALL.find((source) => source.includes("pi-fff")) as string
    await write(globalSettings(), { packages: ALL })
    await runSetup(withPi())
    expect(await read(piFff)).toEqual({ mode: "override", followSymlinks: false })

    const off = withPi()
    const turnedOff = await runSetup(off, { capabilities: { fff: false } })
    expect(turnedOff.lines).toContain(
      `- capability fff: turned off (pi.features.fff in ${userConfig()})`,
    )
    expect(piCommands(off)).toEqual([`pi remove ${FFF.replace(/@[^@/]+$/, "")}`])
    expect(await read(piFff)).toEqual({})

    await write(globalSettings(), { packages: ALL.filter((source) => source !== FFF) })
    const on = withPi()
    await runSetup(on, { capabilities: { fff: true } })
    expect(piCommands(on)).toEqual([`pi install ${FFF}`])
    expect(await read(piFff)).toEqual({ mode: "override", followSymlinks: false })
  })

  test("a choice equal to what the config decides writes nothing, so a default is never frozen into the file", async () => {
    await write(globalSettings(), { packages: ALL })
    const report = await runSetup(withPi(), { capabilities: { todo: true } })
    expect(report.lines).toContain("= capability todo: already on")
    expect(await Bun.file(userConfig()).exists()).toBe(false)
  })

  test("a dry run writes no config and plans the install or removal the choice would cause", async () => {
    await write(globalSettings(), { packages: ALL })
    const shell = withPi()
    const report = await runSetup(shell, { capabilities: { todo: false }, dryRun: true })
    expect(await Bun.file(userConfig()).exists()).toBe(false)
    expect(shell.calls.filter((call) => call.command === "pi")).toEqual([])
    expect(report.lines).toContain(
      `- capability todo: would turn off (pi.features.todo in ${userConfig()})`,
    )
    expect(report.lines.some((line) => line.includes("rpiv-todo: would remove"))).toBe(true)
  })

  test("project and local scope write the project's config, not the user's", async () => {
    await write(globalSettings(), { packages: ALL })
    for (const scope of ["project", "local"] as const) {
      await runSetup(withPi(), { scope, capabilities: { processes: false } })
      expect(await read(projectConfig())).toEqual({ pi: { features: { processes: false } } })
    }
    expect(await Bun.file(userConfig()).exists()).toBe(false)
  })

  test("a config whose pi section is not an object is a failed step and stays as it is", async () => {
    await write(userConfig(), '{"pi": 3}')
    const report = await runSetup(withPi(), { capabilities: { todo: false } })
    expect(report.ok).toBe(false)
    expect(report.lines.some((line) => line.startsWith("! capabilities: "))).toBe(true)
    expect(await Bun.file(userConfig()).text()).toBe('{"pi": 3}')
  })

  test("turning on a capability the user config locks off, at project or local scope, is refused and installs nothing", async () => {
    await write(userConfig(), { pi: { features: { computerUse: false } } })
    await write(globalSettings(), { packages: ALL.filter((source) => source !== COMPUTER_USE) })
    for (const scope of ["project", "local"] as const) {
      const shell = withPi()
      const report = await runSetup(shell, { scope, capabilities: { computerUse: true } })
      expect(report.ok).toBe(false)
      expect(report.lines).toContain(
        `! capabilities: capability computer-use cannot be turned on here: ${userConfig()} sets pi.features.computerUse to false, which a project or local config cannot override; change it there or use --scope user`,
      )
      expect(piCommands(shell)).toEqual([])
      expect(await Bun.file(projectConfig()).exists()).toBe(false)
      // The skipped Pi steps name the capability whose choice was refused.
      expect(report.lines).toContain(
        "- pi packages, tool settings and t3 settings: not run, because the choice for computer-use was not saved",
      )
    }
  })

  test("a locked capability can still be turned off at project scope, and on in the user file itself", async () => {
    await write(userConfig(), { pi: { features: { computerUse: false } } })
    await write(globalSettings(), { packages: ALL.filter((source) => source !== COMPUTER_USE) })
    const off = await runSetup(withPi(), { scope: "project", capabilities: { computerUse: false } })
    expect(off.ok).toBe(true)
    const on = await runSetup(withPi(), { capabilities: { computerUse: true } })
    expect(on.ok).toBe(true)
    expect(await read(userConfig())).toEqual({ pi: { features: { computerUse: true } } })
  })

  test("when the choices cannot be saved, no package or tool setting changes", async () => {
    // A plain file where the config folder should be: the config loads (as empty) but cannot be written.
    await write(join(home, ".holyagent"), "not a folder")
    await write(globalSettings(), { packages: ALL.filter((source) => source !== TODO) })
    const shell = withPi()
    const report = await runSetup(shell, { capabilities: { todo: true, ask: false } })
    expect(report.ok).toBe(false)
    expect(report.lines.some((line) => line.startsWith("! capabilities: "))).toBe(true)
    expect(piCommands(shell)).toEqual([])
    expect(await read(globalSettings())).toEqual({
      packages: ALL.filter((source) => source !== TODO),
    })
  })

  test("a project or local config that is a symlink is not written through", async () => {
    await write(globalSettings(), { packages: ALL })
    const target = join(project, "..", "elsewhere.json")
    await write(target, { vcs: { allowWords: ["Claude Code"] } })
    await mkdir(join(project, ".holyagent"), { recursive: true })
    await symlink(target, projectConfig())
    const shell = withPi()
    const report = await runSetup(shell, { scope: "project", capabilities: { todo: false } })
    expect(report.ok).toBe(false)
    expect(
      report.lines.some(
        (line) => line.startsWith("! capabilities: ") && line.includes("is a symlink; refusing"),
      ),
    ).toBe(true)
    expect(await read(target)).toEqual({ vcs: { allowWords: ["Claude Code"] } })
    expect(piCommands(shell)).toEqual([])
    // A folder that is a link is refused as well.
    await rm(join(project, ".holyagent"), { recursive: true })
    await mkdir(join(project, "..", "folder"), { recursive: true })
    await symlink(join(project, "..", "folder"), join(project, ".holyagent"))
    const folder = await runSetup(withPi(), { scope: "local", capabilities: { todo: false } })
    expect(folder.ok).toBe(false)
    expect(await Bun.file(join(project, "..", "folder", "config.json")).exists()).toBe(false)
  })

  test("a dry run against a symlinked config fails as the real run would", async () => {
    await write(globalSettings(), { packages: ALL })
    const target = join(project, "..", "elsewhere.json")
    await write(target, { vcs: { allowWords: ["Claude Code"] } })
    await mkdir(join(project, ".holyagent"), { recursive: true })
    await symlink(target, projectConfig())
    const report = await runSetup(withPi(), {
      scope: "project",
      dryRun: true,
      capabilities: { todo: false },
    })
    expect(report.ok).toBe(false)
    expect(
      report.lines.some(
        (line) => line.startsWith("! capabilities: ") && line.includes("is a symlink; refusing"),
      ),
    ).toBe(true)
    expect(report.lines.some((line) => line.includes("would turn off"))).toBe(false)
  })

  test("without Pi in use the choice is not applied, and the report says so", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await Effect.runPromise(
      setup(
        { HOME: home, HOLYAGENT_HOST: "claude" },
        {
          scope: "user",
          cwd: project,
          subagentCacheTtl: "1h",
          dryRun: false,
          skipCtx7: true,
          capabilities: { todo: false },
        },
      ).pipe(Effect.provide(shell.layer)),
    )
    expect(report.lines).toContain(
      "- capabilities: Pi is not in use, so the capability choices were not applied",
    )
    expect(await Bun.file(userConfig()).exists()).toBe(false)
  })
})

describe("the form in setup", () => {
  test("the headless form installs no computer-use package, removes a listed one and says which form it used", async () => {
    await write(globalSettings(), {
      packages: ALL.filter((source) => source !== COMPUTER_USE),
    })
    const fresh = withPi()
    const report = await runSetup(fresh, { form: "headless" })
    expect(piCommands(fresh)).toEqual([])
    expect(report.lines).toContain("~ form: headless (set by --form headless)")
    expect(report.lines.some((line) => line.includes("pi-computer-use"))).toBe(false)

    await write(globalSettings(), { packages: ALL })
    const stale = withPi()
    await runSetup(stale, { form: "headless" })
    expect(piCommands(stale)).toEqual(["pi remove npm:@amaster.ai/pi-computer-use"])
  })

  test("the normal form installs it, as before", async () => {
    await write(globalSettings(), { packages: ALL.filter((source) => source !== COMPUTER_USE) })
    const shell = withPi()
    const report = await runSetup(shell, { form: "normal" })
    expect(piCommands(shell)).toEqual([`pi install ${COMPUTER_USE}`])
    expect(report.lines).toContain("~ form: normal (set by --form normal)")
  })

  test("the headless form writes no computer-use settings, and the normal form does", async () => {
    await write(globalSettings(), { packages: ALL })
    await runSetup(withPi(), { form: "headless" })
    const headless = (await read(globalSettings())) as Record<string, unknown>
    expect(headless["pi-computer-use"]).toBeUndefined()
    expect(headless["codemode"]).toEqual({ mode: "only" })
    await runSetup(withPi(), { form: "normal" })
    expect(((await read(globalSettings())) as Record<string, unknown>)["pi-computer-use"]).toEqual({
      confirmAppLaunch: false,
      confirmDangerousActions: false,
    })
  })
})

/** The command line the program parses, with the machine of this test. */
const cli = (argv: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  Effect.runPromise(
    run(["setup", "--skip-ctx7", "--no-tui", ...argv], {
      cwd: project,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        PATH: dirname(process.execPath),
        HOLYAGENT_HOST: "pi",
        ...env,
      },
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
    }),
  )

describe("the setup command line", () => {
  test("each capability of the registry has an on|off flag, which writes the config", async () => {
    for (const capability of CAPABILITIES) {
      const result = await cli([`--${capability.name}`, "off"])
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain(
        `- capability ${capability.name}: turned off (pi.features.${capability.feature} in ${userConfig()})`,
      )
    }
    expect(
      Object.fromEntries(
        Object.entries(((await read(userConfig())) as { pi: { features: object } }).pi.features),
      ),
    ).toEqual(Object.fromEntries(CAPABILITIES.map((capability) => [capability.feature, false])))
  })

  test("--form headless names the form, and detection picks it where the machine has no display or CI is set", async () => {
    const named = await cli(["--form", "headless", "--dry-run"])
    expect(named.stdout).toContain("~ form: headless (set by --form headless)")
    const detected = await cli(["--dry-run"], { CI: "true" })
    expect(detected.stdout).toContain("~ form: headless (detected: CI is set)")
    const normal = await cli(["--dry-run", "--form", "normal"], { CI: "true" })
    expect(normal.stdout).toContain("~ form: normal (set by --form normal)")
  })

  test("a value other than on or off, an unknown form, and an undo with a capability flag are refused", async () => {
    const bad = await cli(["--todo", "maybe"])
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toContain("Invalid value for --todo: maybe")
    const form = await cli(["--form", "sideways"])
    expect(form.stderr).toContain("Invalid value for --form: sideways")
    const undo = await cli(["--undo", "--todo", "off"])
    expect(undo.code).not.toBe(0)
    expect(undo.stderr).toContain("--undo takes no capability flag and no --form")
    expect(await Bun.file(userConfig()).exists()).toBe(false)
  })

  test("the help names every capability and the form flag", async () => {
    const help = (await cli(["--help"])).stdout
    for (const capability of CAPABILITIES) expect(help).toContain(capability.name)
    expect(help).toContain("[--<capability> on|off] [--form headless|normal]")
    expect(help).toContain("--form headless|normal picks the form")
  })
})
