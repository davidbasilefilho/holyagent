import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { version } from "../../../package.json" with { type: "json" }
import {
  CAPABILITIES,
  type CapabilityDefinition,
  FEATURE_PACKAGES,
} from "../src/config/capabilities.ts"
import { piPackages } from "../src/config/packages.ts"
import { PI_PACKAGE_VERSIONS, piPackageSource } from "../src/config/pi-packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { doctor } from "../src/setup/doctor.ts"
import { chooseForm } from "../src/setup/form.ts"
import {
  checkCapability,
  isHolyagentSource,
  PI_HOST_VERSION,
  PI_MINIMUM_NODE,
  piAgentDirectory,
} from "../src/setup/pi-check.ts"
import { staleManagedNames } from "../src/setup/pi-install.ts"
import { setup } from "../src/setup/steps.ts"
import { fakeShell, scratch, writeCompleteSettings } from "./setup-fixture.ts"

let home: string
let project: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-doctor-pi-")
  home = join(made.directory, "home")
  project = join(made.directory, "project")
  await mkdir(project, { recursive: true })
  await writeCompleteSettings(join(home, ".claude"))
  remove = made.remove
})
afterEach(() => remove())

const DEFAULT = await Effect.runPromise(defaultConfig)
const DEFAULT_SOURCES = piPackages(DEFAULT)
const SOURCE = `git:github.com/davidbasilefilho/holyagent@holyagent-${version}`
const PI_INSTALL = `npm install -g --ignore-scripts @earendil-works/pi-coding-agent@${PI_HOST_VERSION}`

const write = async (file: string, content: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
}
const globalSettings = () => join(home, ".pi", "agent", "settings.json")
const projectSettings = () => join(project, ".pi", "settings.json")
/** The packages of a Pi that has HolyAgent and every package the default config enables. */
const FULL = () => ({ packages: [SOURCE, ...DEFAULT_SOURCES] })
/** The line for the provider package, the one package no capability owns. */
const BASE_OK = "ok   pi base packages: 1 packages listed at their pins"
const FORM_OK = "ok   pi form: normal"
/** The line of each capability in the default config when its package is listed (the normal form). */
const CAPABILITY_LINES_OK = [
  "ok   pi capability subagents: normal form, root, 1 package listed at its pin",
  "ok   pi capability context-compression: normal form, both, 1 package listed at its pin",
  "ok   pi capability todo: normal form, root, 1 package listed at its pin",
  "ok   pi capability ask: normal form, root, 1 package listed at its pin",
  "ok   pi capability processes: normal form, root, 1 package listed at its pin",
  "ok   pi capability mcp: normal form, both, nothing to install",
  "ok   pi capability computer-use: normal form, specialists, 1 package listed at its pin",
]
const PI_LINES_OK = [BASE_OK, FORM_OK, ...CAPABILITY_LINES_OK]
const IN_USE = { HOLYAGENT_HOST: "pi" }
/** The user's own HolyAgent config, which a user-scope setup and doctor decide from. */
const setConfig = (config: unknown) => write(join(home, ".holyagent", "config.json"), config)
/** The project's HolyAgent config, which project and local scope read over the user's. */
const setProjectConfig = (config: unknown) =>
  write(join(project, ".holyagent", "config.json"), config)

/** A fake shell where `pi`, `node` and `bun` are installed and print the given versions. */
const shellWith = (
  versions: { readonly pi?: string; readonly node?: string } = {},
  commands: ReadonlyArray<string> = ["bun", "ctx7", "pi", "node"],
) =>
  fakeShell({
    commands,
    respond: (line) =>
      line === "pi --version"
        ? { stdout: `${versions.pi ?? PI_HOST_VERSION}\n` }
        : line === "node --version"
          ? { stdout: `${versions.node ?? "v22.19.0"}\n` }
          : undefined,
  })

const check = (
  shell: ReturnType<typeof fakeShell>,
  extra: { env?: Record<string, string>; fix?: boolean; scope?: "user" | "project" | "local" } = {},
) =>
  Effect.runPromise(
    doctor(
      { HOME: home, DISPLAY: ":0", ...extra.env },
      { fix: extra.fix ?? false, cwd: project, scope: extra.scope ?? "user" },
    ).pipe(Effect.provide(shell.layer)),
  )

/**
 * The lines the Pi checks added, which come after the three of bun, ctx7 and the settings. The tool
 * settings hints are left out here; setup-pi-settings.test.ts covers them.
 */
const piLines = (report: { readonly lines: ReadonlyArray<string> }) =>
  report.lines.slice(3).filter((line) => !line.startsWith("~ tool settings "))

/** The Pi lines of a project or local scope report, which a notice line may shift; found by name. */
const lineNamed = (report: { readonly lines: ReadonlyArray<string> }, name: string) =>
  report.lines.find((line) => line.includes(`${name}:`))

describe("holyagent doctor, Pi checks", () => {
  test("pass when pi, Node and the package are in place, and run only the version commands", async () => {
    await write(globalSettings(), { theme: "dark", ...FULL() })
    const shell = shellWith()
    const report = await check(shell)
    expect(report.ok).toBe(true)
    expect(piLines(report)).toEqual([
      `ok   pi: ${PI_HOST_VERSION} (/fake/bin/pi)`,
      "ok   node: 22.19.0 (/fake/bin/node)",
      `ok   pi package: listed in ${globalSettings()}`,
      ...PI_LINES_OK,
    ])
    expect(shell.lines()).toEqual(["pi --version", "node --version"])
  })

  test("report each missing part with the command that fixes it, and install nothing even with --fix", async () => {
    for (const fix of [false, true]) {
      const shell = fakeShell({ commands: ["bun", "ctx7"] })
      const report = await check(shell, { fix, env: IN_USE })
      expect(report.ok).toBe(false)
      expect(piLines(report)).toEqual([
        `FAIL pi: not found on PATH; install Pi with \`${PI_INSTALL}\` (Node.js ${PI_MINIMUM_NODE} or newer), or with the official installer (https://pi.dev)`,
        `FAIL node: not found on PATH; install Node.js ${PI_MINIMUM_NODE} or newer (https://nodejs.org)`,
        `FAIL pi package: not in the packages of ${globalSettings()}; install it with \`pi install ${SOURCE}\``,
        `FAIL pi base package pi-provider-kimi-code: not listed at ${DEFAULT_SOURCES[0]} in the packages of ${globalSettings()}; install it with \`pi install ${DEFAULT_SOURCES[0]}\`, or re-run \`holyagent setup\``,
        FORM_OK,
        // The default provider is Kimi, so a capability of the Codex provider is not listed.
        ...CAPABILITIES.filter((capability) => !("provider" in capability)).map((capability) => {
          if (capability.name === "mcp")
            return "ok   pi capability mcp: normal form, both, nothing to install"
          const source = piPackageSource(
            FEATURE_PACKAGES[capability.feature as keyof typeof FEATURE_PACKAGES],
          )
          return `FAIL pi capability ${capability.name}: ${source} is not listed in the packages of ${globalSettings()}; install it with \`pi install ${source}\`, or re-run \`holyagent setup\``
        }),
      ])
      expect(shell.calls).toEqual([])
    }
  })

  test("a pi older than the pinned release fails, a newer one passes with a note", async () => {
    await write(globalSettings(), FULL())
    const older = piLines(await check(shellWith({ pi: "1.4.9" })))[0]
    expect(older).toBe(
      `FAIL pi: 1.4.9 at /fake/bin/pi is older than ${PI_HOST_VERSION}, the release HolyAgent is built against; install Pi with \`${PI_INSTALL}\` (Node.js ${PI_MINIMUM_NODE} or newer), or with the official installer (https://pi.dev)`,
    )
    const newer = await check(shellWith({ pi: "1.6.0" }))
    expect(piLines(newer)[0]).toBe(
      `ok   pi: 1.6.0 (/fake/bin/pi; newer than the ${PI_HOST_VERSION} HolyAgent is built against)`,
    )
    expect(newer.ok).toBe(true)
  })

  test("a pi that prints no version, or exits non-zero, fails", async () => {
    const silent = fakeShell({
      commands: ["bun", "ctx7", "pi", "node"],
      respond: (line) => (line === "pi --version" ? { stdout: "hello\n" } : undefined),
    })
    expect(piLines(await check(silent))[0]).toStartWith(
      "FAIL pi: /fake/bin/pi did not report a version for --version (exit 0); install Pi",
    )
    const broken = fakeShell({
      commands: ["bun", "ctx7", "pi", "node"],
      respond: (line) =>
        line === "pi --version" ? { exitCode: 3, stdout: `${PI_HOST_VERSION}\n` } : undefined,
    })
    expect(piLines(await check(broken))[0]).toStartWith(
      "FAIL pi: /fake/bin/pi did not report a version for --version (exit 3); install Pi",
    )
  })

  test.each([
    ["v22.18.9", false],
    ["v22.19.0", true],
    ["v22.23.4", true],
    ["v24.0.0", true],
    ["v20.19.0", false],
  ])("node %s passes the minimum: %p", async (reported, passes) => {
    const report = await check(shellWith({ node: reported }))
    const line = piLines(report)[1]
    if (passes) expect(line).toBe(`ok   node: ${reported.slice(1)} (/fake/bin/node)`)
    else
      expect(line).toBe(
        `FAIL node: ${reported.slice(1)} at /fake/bin/node is older than ${PI_MINIMUM_NODE}, which Pi needs; install Node.js ${PI_MINIMUM_NODE} or newer (https://nodejs.org)`,
      )
  })

  test("the package counts in the project's settings at project and local scope, as a string or an object source", async () => {
    await write(projectSettings(), {
      packages: [{ source: "npm:holyagent@0.3.0", skills: [] }, ...DEFAULT_SOURCES],
    })
    for (const scope of ["project", "local"] as const) {
      const report = await check(shellWith(), { scope })
      expect(lineNamed(report, "pi package")).toBe(
        `ok   pi package: listed in ${projectSettings()}`,
      )
      expect(lineNamed(report, "pi base packages")).toBe(BASE_OK)
      expect(report.lines.filter((line) => /^ok {3}pi (form|capability)/.test(line))).toEqual([
        FORM_OK,
        ...CAPABILITY_LINES_OK,
      ])
    }
  })

  test("a user-scope doctor ignores the repository's .pi/settings.json, which project and local scope read", async () => {
    await write(projectSettings(), FULL())
    const user = await check(shellWith())
    expect(user.ok).toBe(false)
    expect(piLines(user)[2]).toBe(
      `FAIL pi package: not in the packages of ${globalSettings()}; install it with \`pi install ${SOURCE}\``,
    )
    expect(piLines(user).filter((line) => line.startsWith("FAIL pi "))).toHaveLength(
      DEFAULT_SOURCES.length + 1,
    )
    expect(piLines(user).slice(3).join("\n")).not.toContain(projectSettings())
    for (const scope of ["project", "local"] as const)
      expect(lineNamed(await check(shellWith(), { scope }), "pi package")).toBe(
        `ok   pi package: listed in ${projectSettings()}`,
      )
  })

  test("PI_CODING_AGENT_DIR moves the global settings file", async () => {
    const agent = join(home, "elsewhere")
    await write(join(agent, "settings.json"), FULL())
    await write(globalSettings(), { packages: [] })
    const report = await check(shellWith(), { env: { PI_CODING_AGENT_DIR: agent } })
    expect(piLines(report)[2]).toBe(`ok   pi package: listed in ${join(agent, "settings.json")}`)
    expect(piAgentDirectory({ HOME: "/h", PI_CODING_AGENT_DIR: "~/pi" })).toBe(join("/h", "pi"))
    expect(piAgentDirectory({ HOME: "/h", PI_CODING_AGENT_DIR: "" })).toBe(
      join("/h", ".pi", "agent"),
    )
  })

  test("other packages do not count", async () => {
    await write(globalSettings(), {
      packages: ["npm:@scope/holyagent@1.0.0", "npm:pi-web-kit@0.5.0"],
    })
    const report = await check(shellWith())
    expect(piLines(report)[2]).toStartWith("FAIL pi package: not in the packages of ")
    expect(report.ok).toBe(false)
  })

  test("a settings file that is not valid Pi settings fails the check by name, and the other scope can still pass", async () => {
    await write(globalSettings(), { packages: "holyagent" })
    const failing = await check(shellWith())
    expect(piLines(failing)[2]).toStartWith(
      `FAIL pi package: ${globalSettings()} is not valid Pi settings: `,
    )
    expect(piLines(failing)[2]).toContain("`pi install ")

    await write(projectSettings(), FULL())
    const passing = await check(shellWith(), { scope: "project" })
    expect(lineNamed(passing, "pi package")).toBe(`ok   pi package: listed in ${projectSettings()}`)
  })

  test("pi.enable off in the config runs no Pi check and no process", async () => {
    await setConfig({ pi: { enable: false } })
    const shell = fakeShell({ commands: ["bun", "ctx7", "pi"] })
    const report = await check(shell)
    expect(report.ok).toBe(true)
    expect(report.lines).toHaveLength(3)
    expect(shell.calls).toEqual([])
  })

  test("a config that cannot be loaded is one failing pi config line", async () => {
    await setConfig({ pi: { enabled: false } })
    const report = await check(fakeShell({ commands: ["bun", "ctx7"] }), { env: IN_USE })
    expect(report.ok).toBe(false)
    expect(piLines(report)).toHaveLength(1)
    expect(piLines(report)[0]).toStartWith("FAIL pi config: ")
    expect(piLines(report)[0]).toContain(join(home, ".holyagent", "config.json"))
  })

  test("a machine without Pi gets one informational line and no failure, whatever its Pi files hold", async () => {
    await write(globalSettings(), { packages: "broken" })
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await check(shell)
    expect(report.ok).toBe(true)
    expect(piLines(report)).toEqual([
      "~ pi: not in use (HOLYAGENT_HOST is not pi and pi is not on PATH); Pi checks skipped",
    ])
    expect(shell.calls).toEqual([])
  })

  test("HOLYAGENT_HOST=pi turns the checks on although pi is not on PATH, and pi on PATH does without it", async () => {
    const byHost = await check(fakeShell({ commands: ["bun", "ctx7"] }), { env: IN_USE })
    expect(piLines(byHost)[0]).toStartWith("FAIL pi: not found on PATH")
    const byPath = await check(shellWith())
    expect(piLines(byPath)[0]).toStartWith("ok   pi: ")
    const claude = await check(fakeShell({ commands: ["bun", "ctx7"] }), {
      env: { HOLYAGENT_HOST: "claude" },
    })
    expect(piLines(claude)[0]).toStartWith("~ pi: not in use")
  })

  test("each enabled package missing from both settings files is a failing line with its install command", async () => {
    const [kept, ...rest] = DEFAULT_SOURCES
    await write(globalSettings(), { packages: [SOURCE, kept] })
    const report = await check(shellWith())
    expect(report.ok).toBe(false)
    const failing = piLines(report).filter((line) => line.startsWith("FAIL pi "))
    expect(failing).toHaveLength(rest.length)
    for (const [index, source] of rest.entries()) {
      expect(failing[index]).toContain(`\`pi install ${source}\``)
      expect(failing[index]).toStartWith("FAIL pi capability ")
    }
    expect(piLines(report)[3]).toBe(BASE_OK)
  })

  test("a package listed at another version is missing, and one in the project's settings counts at project scope only", async () => {
    const [first, ...others] = DEFAULT_SOURCES
    await write(globalSettings(), {
      packages: [SOURCE, ...others, first?.replace(/@[^@]+$/, "@0.0.1")],
    })
    await write(projectSettings(), { packages: [{ source: first, skills: [] }] })
    expect(lineNamed(await check(shellWith(), { scope: "project" }), "pi base packages")).toBe(
      BASE_OK,
    )
    expect(piLines(await check(shellWith()))[3]).toContain(`\`pi install ${first}\``)

    await write(projectSettings(), { packages: [] })
    const report = await check(shellWith())
    expect(piLines(report).filter((line) => line.startsWith("FAIL pi "))).toHaveLength(1)
    expect(piLines(report)[3]).toContain(`\`pi install ${first}\``)
  })

  test("a feature the config turns off is not required, and pi-web-kit is once the web choice asks for it", async () => {
    await setConfig({ pi: { features: { computerUse: false, web: "pi-web-kit" } } })
    const wanted = piPackages({
      ...DEFAULT,
      pi: {
        ...DEFAULT.pi,
        features: { ...DEFAULT.pi.features, computerUse: false, web: "pi-web-kit" },
      },
    })
    expect(wanted.some((source) => source.includes("pi-computer-use"))).toBe(false)
    expect(wanted.some((source) => source.startsWith("npm:pi-web-kit@"))).toBe(true)
    await write(globalSettings(), { packages: [SOURCE, ...wanted] })
    const report = await check(shellWith())
    // The provider and the web kit are no capability's, so they are the base packages.
    expect(piLines(report)[3]).toBe("ok   pi base packages: 2 packages listed at their pins")
    expect(lineNamed(report, "pi capability computer-use")).toBeUndefined()
    expect(report.ok).toBe(true)

    await write(globalSettings(), { packages: [SOURCE, ...DEFAULT_SOURCES] })
    const missing = piLines(await check(shellWith())).filter((line) => line.startsWith("FAIL pi "))
    expect(missing).toHaveLength(1)
    expect(missing[0]).toStartWith("FAIL pi base package pi-web-kit: ")
  })

  test("a user-scope doctor expects what the user's config selects, not what the repository's config does", async () => {
    await setProjectConfig({ pi: { features: { todo: false, computerUse: false } } })
    await write(globalSettings(), FULL())
    const user = await check(shellWith())
    expect(piLines(user).slice(3)).toEqual(PI_LINES_OK)

    const off = DEFAULT_SOURCES.filter((source) => !source.includes("rpiv-todo"))
    await write(globalSettings(), { packages: [SOURCE, ...off] })
    const missing = piLines(await check(shellWith())).filter((line) => line.startsWith("FAIL pi "))
    expect(missing.map((line) => line.split(":")[0])).toEqual(["FAIL pi capability todo"])
    // The project's config does decide a project-scope doctor: with the todo feature off, the
    // package list without it is complete, where the user's config would call it missing.
    await write(projectSettings(), { packages: [SOURCE, ...off] })
    const project = await check(shellWith(), { scope: "project" })
    expect(lineNamed(project, "pi base packages")).toBe(BASE_OK)
    expect(lineNamed(project, "pi capability todo")).toBeUndefined()
    expect(lineNamed(project, "pi capability computer-use")).toBeUndefined()
    expect(project.lines.filter((line) => line.startsWith("FAIL pi "))).toEqual([])

    await setProjectConfig({ pi: { enable: false } })
    expect(piLines(await check(shellWith())).length).toBe(3 + PI_LINES_OK.length)
    // With pi.enable off in the project's config, project and local scope print no Pi line at all.
    for (const scope of ["project", "local"] as const) {
      const report = await check(shellWith(), { scope })
      expect(report.lines.filter((line) => /^\S+\s+pi( |:)/.test(line))).toEqual([])
      expect(
        report.lines.some((line) => /pi (package|base|capability|form)|node:/.test(line)),
      ).toBe(false)
    }
  })

  test("a cloud session runs no Pi check", async () => {
    const shell = fakeShell({ commands: ["bun", "pi"] })
    const report = await check(shell, { env: { CLAUDE_CODE_REMOTE: "true", ...IN_USE } })
    expect(report.lines.filter((line) => /^(ok {3}|FAIL )(pi|node)/.test(line))).toEqual([])
    expect(shell.calls).toEqual([])
  })
})

describe("holyagent doctor, capabilities", () => {
  const doctorIn = (
    form: "headless" | "normal" | undefined,
    env: Record<string, string> = {},
    shell = shellWith(),
  ) =>
    Effect.runPromise(
      doctor(
        { HOME: home, ...env },
        {
          fix: false,
          cwd: project,
          scope: "user",
          ...(form === undefined ? {} : { form: chooseForm(env, form, "linux") }),
        },
      ).pipe(Effect.provide(shell.layer)),
    )

  test("reports the form first, with how it was chosen, then one line per enabled capability", async () => {
    await write(globalSettings(), FULL())
    const report = await doctorIn("normal", { DISPLAY: ":0" })
    expect(piLines(report).slice(3)).toEqual([
      BASE_OK,
      "ok   pi form: normal (set by --form normal)",
      ...CAPABILITY_LINES_OK,
    ])
  })

  test("a capability the form does not offer is a note that fails nothing, and its package is not required", async () => {
    await write(globalSettings(), {
      packages: [SOURCE, ...DEFAULT_SOURCES.filter((source) => !source.includes("computer-use"))],
    })
    const report = await doctorIn("headless")
    expect(report.ok).toBe(true)
    expect(piLines(report).slice(3)).toEqual([
      BASE_OK,
      "ok   pi form: headless (set by --form headless)",
      ...CAPABILITY_LINES_OK.slice(0, -1).map((line) =>
        line.replace("normal form", "headless form"),
      ),
      "~ pi capability computer-use: not offered in the headless form (it drives a graphical session and this machine has none); nothing is expected of it",
    ])
  })

  test("a capability the config turns off has no line, and one that is on names the package it lacks", async () => {
    await setConfig({ pi: { features: { todo: false, ask: false } } })
    await write(globalSettings(), {
      packages: [SOURCE, ...DEFAULT_SOURCES.filter((source) => !source.includes("processes"))],
    })
    const report = await doctorIn("normal", { DISPLAY: ":0" })
    const names = piLines(report)
      .filter((line) => line.includes("pi capability"))
      .map((line) => line.split(":")[0])
    expect(names).toEqual([
      "ok   pi capability subagents",
      "ok   pi capability context-compression",
      "FAIL pi capability processes",
      "ok   pi capability mcp",
      "ok   pi capability computer-use",
    ])
    expect(report.ok).toBe(false)
  })

  test.skipIf(process.platform === "darwin" || process.platform === "win32")(
    "a form named on a machine that cannot hold it fails the capability's system need",
    async () => {
      await write(globalSettings(), FULL())
      const report = await doctorIn("normal")
      expect(report.ok).toBe(false)
      expect(lineNamed(report, "pi capability computer-use")).toBe(
        "FAIL pi capability computer-use: needs a graphical session (no DISPLAY or WAYLAND_DISPLAY)",
      )
    },
  )

  describe("the health probes of one entry", () => {
    const ENTRY: CapabilityDefinition = {
      name: "made-up",
      feature: "madeUp",
      description: "For the tests",
      skills: [],
      applicability: "both",
      defaultOn: true,
      needs: [
        { kind: "command", command: "madeup", fix: "install madeup with your package manager" },
      ],
      forms: {
        headless: { packages: [], mcpServers: [] },
        normal: { packages: ["pi-web-kit"], mcpServers: [] },
      },
      tools: { rootExclude: [], visual: [] },
      settings: [],
      health: ["needs", "packages"],
    }
    const probe = (
      definition: CapabilityDefinition,
      form: "headless" | "normal",
      listed: ReadonlyArray<string>,
      commands: ReadonlyArray<string>,
    ) =>
      Effect.runPromise(
        checkCapability({ HOME: home }, "user", definition, form, listed, [
          "/pi/settings.json",
        ]).pipe(Effect.provide(fakeShell({ commands }).layer)),
      )

    test("a missing command and a missing package are named together, with the way to fix each", async () => {
      expect(await probe(ENTRY, "normal", [], [])).toBe(
        "FAIL pi capability made-up: needs madeup on PATH; install madeup with your package manager; npm:pi-web-kit@0.5.0 is not listed in the packages of /pi/settings.json; install it with `pi install npm:pi-web-kit@0.5.0`, or re-run `holyagent setup`",
      )
    })

    test("a present command and a listed package are healthy, and the form decides what is expected", async () => {
      expect(await probe(ENTRY, "normal", ["npm:pi-web-kit@0.5.0"], ["madeup"])).toBe(
        "ok   pi capability made-up: normal form, both, 1 package listed at its pin",
      )
      expect(await probe(ENTRY, "headless", [], ["madeup"])).toBe(
        "ok   pi capability made-up: headless form, both, nothing to install",
      )
    })

    test("a probe the entry does not list is not run", async () => {
      const quiet = { ...ENTRY, health: [] } satisfies CapabilityDefinition
      expect(await probe(quiet, "normal", [], [])).toBe(
        "ok   pi capability made-up: normal form, both, 1 package, not checked",
      )
    })
  })
})

describe("which package sources name the HolyAgent package", () => {
  test.each([
    "npm:holyagent",
    "npm:holyagent@0.3.0",
    "git:github.com/davidbasilefilho/holyagent@holyagent-0.3.0",
    "git:github.com/davidbasilefilho/holyagent",
    "git:github.com/davidbasilefilho/holyagent@release/0.3.0/integration",
    "git:git@github.com:davidbasilefilho/holyagent@release/0.3.0/integration",
    "https://github.com/davidbasilefilho/holyagent.git@release/0.3.0/integration",
    "ssh://git@github.com/davidbasilefilho/holyagent.git@feature/x",
    "https://github.com/davidbasilefilho/holyagent.git",
    "git@github.com:davidbasilefilho/holyagent.git",
    "/work/holyagent",
    "../holyagent/",
    "C:\\work\\holyagent-0.3.0\\packages\\integrations\\pi\\dist",
    "/work/holyagent-0.3.0-install/packages/integrations/pi/dist/",
  ])("%s", (source) => {
    expect(isHolyagentSource(source)).toBe(true)
  })

  test.each([
    "npm:@scope/holyagent@1.0.0",
    "npm:holyagent-extras@1.0.0",
    "npm:pi-web-kit@0.5.0",
    "git:github.com/someone/holyagent-fork@main",
    "git:github.com/someone/other@release/holyagent",
    "https://github.com/someone/other.git@feature/holyagent",
    "/work/other/dist",
    "",
  ])("not %s", (source) => {
    expect(isHolyagentSource(source)).toBe(false)
  })
})

describe("which listed packages setup removes", () => {
  const OTHER = "npm:pi-provider-other@1.0.0"

  test("a provider profile package the config no longer selects goes, a selected one stays", () => {
    const managed = new Set(["pi-provider-kimi-code", "pi-provider-other", "pi-web-kit"])
    const listed = [SOURCE, OTHER, DEFAULT_SOURCES[0] as string, "npm:some-other-package@1.0.0"]
    expect(staleManagedNames(listed, [DEFAULT_SOURCES[0] as string], managed)).toEqual([
      "pi-provider-other",
    ])
    expect(staleManagedNames(listed, [OTHER], managed)).toEqual(["pi-provider-kimi-code"])
  })

  test("the shipped provider package is managed, the HolyAgent package and strangers are not", () => {
    const kimi = DEFAULT_SOURCES[0] as string
    expect(kimi.startsWith("npm:pi-provider-kimi-code@")).toBe(true)
    expect(staleManagedNames([kimi, SOURCE, "npm:holyagent@0.3.0", "npm:x@1"], [])).toEqual([
      "pi-provider-kimi-code",
    ])
  })
})

describe("the pinned Pi release", () => {
  test("is the release bun.lock resolves for the Pi host", async () => {
    const lock = await Bun.file(join(import.meta.dir, "../../../bun.lock")).text()
    expect(lock).toContain(`"@earendil-works/pi-coding-agent@${PI_HOST_VERSION}"`)
  })
})

/** The Pi lines of a setup report: those about a `pi` command or package. */
const piStep = (report: { readonly lines: ReadonlyArray<string> }) =>
  report.lines.filter((line) => /^[+=~!-] pi[ :]/.test(line))

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

/** The `pi` commands setup ran; a project scope also asks git for the top-level directory. */
const piCommands = (shell: ReturnType<typeof fakeShell>) =>
  shell.calls.filter((call) => call.command === "pi").map((call) => call.line)

describe("holyagent setup, Pi packages", () => {
  const withPi = () => fakeShell({ commands: ["bun", "pi"] })

  test("installs every enabled package the settings lack, in the home directory, and shows each command", async () => {
    await write(globalSettings(), { packages: [SOURCE] })
    const shell = withPi()
    const report = await runSetup(shell)
    expect(report.ok).toBe(true)
    expect(piCommands(shell)).toEqual(DEFAULT_SOURCES.map((source) => `pi install ${source}`))
    expect(shell.calls.every((call) => call.cwd === home)).toBe(true)
    expect(piStep(report)).toEqual(
      DEFAULT_SOURCES.map((source) => `+ pi ${source}: installed with pi install ${source}`),
    )
  })

  test("skips what the settings list at its pin, and runs nothing when all are there", async () => {
    await write(globalSettings(), { packages: [SOURCE, ...DEFAULT_SOURCES] })
    const shell = withPi()
    const report = await runSetup(shell)
    expect(shell.calls).toEqual([])
    expect(piStep(report)).toEqual(
      DEFAULT_SOURCES.map((source) => `= pi ${source}: already listed in ${globalSettings()}`),
    )

    const [first, ...others] = DEFAULT_SOURCES
    await write(globalSettings(), {
      packages: [first?.replace(/@[^@]+$/, "@0.0.1"), ...others.map((source) => ({ source }))],
    })
    const stale = withPi()
    await runSetup(stale)
    expect(piCommands(stale)).toEqual([`pi install ${first}`])
  })

  test("removes a feature package the config turns off and installs pi-web-kit when it is turned on", async () => {
    await setConfig({ pi: { features: { computerUse: false, web: "pi-web-kit" } } })
    await write(globalSettings(), { packages: [SOURCE, ...DEFAULT_SOURCES] })
    const shell = withPi()
    const report = await runSetup(shell)
    expect(piCommands(shell)).toEqual([
      `pi install npm:pi-web-kit@${PI_PACKAGE_VERSIONS["pi-web-kit"]}`,
      "pi remove npm:@amaster.ai/pi-computer-use",
    ])
    expect(piStep(report).at(-1)).toBe(
      "- pi npm:@amaster.ai/pi-computer-use: removed with pi remove npm:@amaster.ai/pi-computer-use; its feature is off",
    )
  })

  test("leaves a package alone that is not a HolyAgent feature package, and the HolyAgent package itself", async () => {
    await setConfig({ pi: { features: { todo: false } } })
    await write(globalSettings(), {
      packages: [SOURCE, "npm:some-other-package@1.0.0", ...DEFAULT_SOURCES],
    })
    const shell = withPi()
    await runSetup(shell)
    expect(piCommands(shell)).toEqual(["pi remove npm:@juicesharp/rpiv-todo"])
  })

  test("does nothing while pi.enable is off", async () => {
    await setConfig({ pi: { enable: false } })
    await write(globalSettings(), { packages: [SOURCE, ...DEFAULT_SOURCES] })
    const shell = withPi()
    const report = await runSetup(shell)
    expect(shell.calls).toEqual([])
    expect(piStep(report)).toEqual(["- pi packages: pi.enable is off in the HolyAgent config"])
  })

  test("a dry run says what it would run and runs nothing", async () => {
    await setConfig({ pi: { features: { todo: false } } })
    await write(globalSettings(), { packages: [SOURCE, ...DEFAULT_SOURCES.slice(1)] })
    const shell = withPi()
    const report = await runSetup(shell, { dryRun: true })
    expect(shell.calls).toEqual([])
    expect(piStep(report)).toContain(
      `+ pi ${DEFAULT_SOURCES[0]}: would install with pi install ${DEFAULT_SOURCES[0]}`,
    )
    expect(piStep(report).at(-1)).toBe(
      "- pi npm:@juicesharp/rpiv-todo: would remove with pi remove npm:@juicesharp/rpiv-todo; its feature is off",
    )
  })

  test("project scope works on the project's settings with -l, run in the project", async () => {
    await write(projectSettings(), { packages: [SOURCE] })
    for (const scope of ["project", "local"] as const) {
      const shell = withPi()
      await runSetup(shell, { scope })
      expect(piCommands(shell)).toEqual(DEFAULT_SOURCES.map((source) => `pi install ${source} -l`))
      expect(
        shell.calls.filter((call) => call.command === "pi").every((call) => call.cwd === project),
      ).toBe(true)
    }
  })

  test("a user-scope setup decides from the user's config only, so a repository's config removes nothing globally", async () => {
    await setProjectConfig({
      pi: { features: { todo: false, computerUse: false, web: "off" }, enable: true },
    })
    await write(globalSettings(), FULL())
    const shell = withPi()
    const report = await runSetup(shell)
    expect(shell.calls).toEqual([])
    expect(piStep(report)).toEqual(
      DEFAULT_SOURCES.map((source) => `= pi ${source}: already listed in ${globalSettings()}`),
    )

    await setProjectConfig({ pi: { enable: false } })
    const disabled = withPi()
    await runSetup(disabled)
    expect(disabled.calls).toEqual([])

    // The same project config does decide a project-scope setup, which works on the project.
    await write(projectSettings(), FULL())
    const scoped = withPi()
    await runSetup(scoped, { scope: "project" })
    expect(piCommands(scoped)).toEqual([])
    expect(piStep(await runSetup(withPi(), { scope: "project" }))).toEqual([
      "- pi packages: pi.enable is off in the HolyAgent config",
    ])
  })

  test("a project-scope setup removes what the project's config turns off, from the project's settings", async () => {
    await setProjectConfig({ pi: { features: { todo: false } } })
    await write(projectSettings(), FULL())
    const shell = withPi()
    await runSetup(shell, { scope: "project" })
    expect(piCommands(shell)).toEqual(["pi remove npm:@juicesharp/rpiv-todo -l"])
  })

  test("a project or local scope counts a package listed at its pin in the project's or the global file, in setup as in doctor", async () => {
    const [first, ...others] = DEFAULT_SOURCES
    await write(globalSettings(), { packages: [SOURCE, ...others] })
    await write(projectSettings(), { packages: [{ source: first }] })
    for (const scope of ["project", "local"] as const) {
      const shell = withPi()
      const report = await runSetup(shell, { scope })
      expect(piCommands(shell)).toEqual([])
      expect(piStep(report)).toHaveLength(DEFAULT_SOURCES.length)
      expect(piStep(report).at(0)).toBe(`= pi ${first}: already listed in ${projectSettings()}`)
      expect(lineNamed(await check(shellWith(), { scope }), "pi base packages")).toBe(BASE_OK)
    }

    // A stale pin does not count, and the global file is ignored when it is not valid.
    await write(globalSettings(), { packages: "broken" })
    await write(projectSettings(), { packages: [] })
    const stale = withPi()
    await runSetup(stale, { scope: "project" })
    expect(piCommands(stale)).toEqual(DEFAULT_SOURCES.map((source) => `pi install ${source} -l`))
  })

  test("a user-scope setup counts Pi's global settings only, so a repository's .pi/settings.json does not stop the global install", async () => {
    const [first, ...others] = DEFAULT_SOURCES
    await write(globalSettings(), { packages: [SOURCE, ...others] })
    await write(projectSettings(), { packages: [{ source: first }] })
    const shell = withPi()
    const report = await runSetup(shell)
    expect(piCommands(shell)).toEqual([`pi install ${first}`])
    expect(shell.calls.every((call) => call.cwd === home)).toBe(true)
    expect(piStep(report).at(-1)).toBe(`+ pi ${first}: installed with pi install ${first}`)

    // An invalid project file is not read at user scope either.
    await write(projectSettings(), { packages: "broken" })
    const unread = withPi()
    await runSetup(unread)
    expect(piCommands(unread)).toEqual([`pi install ${first}`])
  })

  test("removal touches the chosen scope's settings only", async () => {
    await setConfig({ pi: { features: { todo: false } } })
    await write(globalSettings(), FULL())
    await write(projectSettings(), FULL())
    const shell = withPi()
    await runSetup(shell)
    expect(piCommands(shell)).toEqual(["pi remove npm:@juicesharp/rpiv-todo"])
    expect(shell.calls.every((call) => call.cwd === home)).toBe(true)
  })

  test("a failing command is a failed line and the others still run", async () => {
    const failing = DEFAULT_SOURCES[1] as string
    const shell = fakeShell({
      commands: ["bun", "pi"],
      respond: (line) =>
        line === `pi install ${failing}` ? { exitCode: 1, stderr: "offline\n" } : undefined,
    })
    const report = await runSetup(shell)
    expect(report.ok).toBe(false)
    expect(shell.calls).toHaveLength(DEFAULT_SOURCES.length)
    expect(piStep(report)).toContain(`! pi install ${failing}: failed (exit 1): offline`)
  })

  test("with work to do and no pi on PATH it reports that and runs nothing", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await runSetup(shell, { env: IN_USE })
    expect(shell.calls).toEqual([])
    expect(report.ok).toBe(false)
    expect(piStep(report)[0]).toStartWith("! pi packages: pi not found on PATH")
  })

  test("a settings file that is not valid Pi settings is a failed line, not an abort", async () => {
    await write(globalSettings(), { packages: "broken" })
    const shell = withPi()
    const report = await runSetup(shell)
    expect(shell.calls).toEqual([])
    expect(report.ok).toBe(false)
    expect(piStep(report)[0]).toStartWith(
      `! pi packages: ${globalSettings()} is not valid Pi settings`,
    )
    expect(report.lines.some((line) => line.includes("attribution"))).toBe(true)
  })

  test("without Pi in use, in a cloud session, and under --undo it does nothing", async () => {
    const without = fakeShell({ commands: ["bun"] })
    expect(piStep(await runSetup(without))).toEqual([])
    const cloud = withPi()
    expect(
      piStep(await runSetup(cloud, { env: { CLAUDE_CODE_REMOTE: "true", ...IN_USE } })),
    ).toEqual([])
    const undone = withPi()
    expect(piStep(await runSetup(undone, { undo: true }))).toEqual([])
    for (const shell of [without, cloud, undone]) expect(shell.calls).toEqual([])
  })
})
