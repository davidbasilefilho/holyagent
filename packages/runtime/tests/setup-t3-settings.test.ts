import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { version } from "../../../package.json" with { type: "json" }
import { piPackages } from "../src/config/packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { doctor } from "../src/setup/doctor.ts"
import { recordPath } from "../src/setup/record.ts"
import { setup } from "../src/setup/steps.ts"
import {
  installT3Settings,
  restoreSettings,
  T3_BRANCH_INSTRUCTIONS,
  T3_WRITING_INSTRUCTIONS,
  t3SettingsFile,
  type T3SettingsOptions,
  undoT3Settings,
  writeSettings,
} from "../src/setup/t3-settings.ts"
import { fakeShell, PI_TEST_HOST_VERSION, scratch, writeCompleteSettings } from "./setup-fixture.ts"

let home: string
let project: string
let t3Home: string
let androidSdk: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-t3-settings-")
  home = join(made.directory, "home")
  project = join(made.directory, "project")
  t3Home = join(made.directory, "t3")
  androidSdk = join(made.directory, "android-sdk")
  await mkdir(project, { recursive: true })
  await writeCompleteSettings(join(home, ".claude"))
  remove = made.remove
})
afterEach(() => remove())

const DEFAULT = await Effect.runPromise(defaultConfig)
const SOURCE = `git:github.com/davidbasilefilho/holyagent@holyagent-${version}`

const write = async (file: string, content: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
}
const readText = (file: string) => Bun.file(file).text()
const read = async (file: string): Promise<unknown> => JSON.parse(await readText(file))
const exists = (file: string) => Bun.file(file).exists()

const settingsFile = () => join(t3Home, "userdata", "settings.json")
const piSettings = () => join(home, ".pi", "agent", "settings.json")
const setConfig = (config: unknown) => write(join(home, ".holyagent", "config.json"), config)

/** A machine with T3 Code (its home folder), Pi's packages in place and an Android SDK. */
const machine = async (options: { t3?: boolean; sdk?: boolean } = {}) => {
  await write(piSettings(), { packages: [SOURCE, ...piPackages(DEFAULT)] })
  if (options.t3 !== false) await mkdir(t3Home, { recursive: true })
  if (options.sdk !== false) await mkdir(androidSdk, { recursive: true })
}

const env = (extra: Record<string, string> = {}) => ({
  HOME: home,
  DISPLAY: ":0",
  HOLYAGENT_HOST: "pi",
  T3CODE_HOME: t3Home,
  ANDROID_HOME: androidSdk,
  // Do not let the host's Xcode override the fixture's Android SDK choice.
  DEVELOPER_DIR: join(home, "no-xcode"),
  ...extra,
})

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
  extra: {
    env?: Record<string, string>
    scope?: "user" | "project" | "local"
    dryRun?: boolean
    t3Workflow?: boolean
    undo?: boolean
    shell?: ReturnType<typeof fakeShell>
    deviceAccess?: boolean
    devicePreparation?: "preview" | "apply"
  } = {},
) =>
  Effect.runPromise(
    setup(env(extra.env), {
      scope: extra.scope ?? "user",
      cwd: project,
      subagentCacheTtl: "1h",
      dryRun: extra.dryRun ?? false,
      skipCtx7: true,
      t3Workflow: extra.t3Workflow ?? false,
      undo: extra.undo ?? false,
      ...(extra.deviceAccess === undefined ? {} : { deviceAccess: extra.deviceAccess }),
      ...(extra.devicePreparation === undefined
        ? {}
        : { devicePreparation: extra.devicePreparation }),
    }).pipe(Effect.provide((extra.shell ?? withPi()).layer)),
  )

const runDoctor = (extraEnv: Record<string, string> = {}, t3Workflow = false) =>
  Effect.runPromise(
    doctor(env(extraEnv), { fix: false, cwd: project, scope: "user", t3Workflow }).pipe(
      Effect.provide(withPi().layer),
    ),
  )

const t3Lines = (report: { readonly lines: ReadonlyArray<string> }) =>
  report.lines.filter((line) => line.includes("t3 settings"))

/** Calls the step on its own, with the shell it needs for the Pi check of the config only. */
const install = (options: T3SettingsOptions, extraEnv: Record<string, string> = {}) =>
  Effect.runPromise(
    installT3Settings(env(extraEnv), project, options).pipe(Effect.provide(withPi().layer)),
  )

/** The error the step fails with. */
const installFailure = (options: T3SettingsOptions) =>
  Effect.runPromise(
    installT3Settings(env(), project, options).pipe(Effect.flip, Effect.provide(withPi().layer)),
  )

const PROVIDER = { providerInstances: { pi: { driver: "pi", enabled: true } } }
const STARTUP_MODEL = {
  defaultModelSelection: {
    instanceId: "pi",
    model: "kimi-coding/k3.1-pro",
    options: [{ id: "thinking", value: "high" }],
  },
}
const DEVICES = { enableDeviceSupport: true, enableAgentDeviceAccess: true }
const WORKTREES = { defaultThreadEnvMode: "worktree" }
const BACKGROUND = {
  backgroundActivity: {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: "balanced",
    overrides: {
      pauseWhenHostLocked: false,
      pauseWhenHostLowPower: false,
      pauseWhenClientLowPower: false,
    },
  },
}
const WRITING = {
  sourceControlWritingStyle: {
    mode: "conventional_commits",
    customInstructions: T3_WRITING_INSTRUCTIONS,
  },
  removeAgentCreditsOnMerge: true,
}
const THREADS = {
  autoResumeLimitedThreads: true,
  snoozeLimitedThreads: true,
  defaultAutoPull: true,
}
const BRANCHES = {
  branchNamingMode: "custom",
  branchNameInstructions: T3_BRANCH_INSTRUCTIONS,
}
const CLEANUP = {
  storageCleanup: {
    worktreeOnMerge: true,
    logsAfterDays: 30,
    browserArtifactsAfterDays: 14,
    worktreeSettledAfterDays: 14,
  },
}
const ALL = {
  ...PROVIDER,
  ...STARTUP_MODEL,
  ...DEVICES,
  ...WORKTREES,
  ...BACKGROUND,
  ...WRITING,
  ...THREADS,
  ...BRANCHES,
  ...CLEANUP,
}

describe("holyagent setup, T3 Code settings", () => {
  test("writes exactly the agreed keys into T3's settings.json, beside what the file holds", async () => {
    await machine()
    await write(settingsFile(), { theme: "mine", favorites: ["a"] })
    const report = await runSetup()
    expect(report.ok).toBe(true)
    expect(await read(settingsFile())).toEqual({ theme: "mine", favorites: ["a"], ...ALL })
    expect(t3Lines(report)).toHaveLength(1)
    expect(t3Lines(report)[0]).toStartWith(`+ t3 settings ${settingsFile()}: added `)
  })

  test("leaves the context meter, other model choices, Pi launch settings and client settings alone", async () => {
    await machine()
    await runSetup()
    const written = (await read(settingsFile())) as Record<string, unknown>
    for (const key of [
      "contextWindowMeterEnabled",
      "textGenerationModelSelection",
      "fallbackModelSelection",
      "enableProviderUpdateChecks",
      "followUpBehavior",
      "planModeEnabled",
      "defaultRuntimeMode",
      "enableAgentBrowserAccess",
      "continueThreadsAfterServerUpdate",
      "newWorktreesStartFromOrigin",
      "sidebarAutoSettleOnMerge",
      "notificationMode",
      "pullRequestMergeMethod",
      "branchNamePrefix",
      "projectSettingsOverrides",
    ])
      expect(written).not.toHaveProperty(key)
    // Nothing of the Pi instance beyond the driver and the switch: no launch settings.
    expect(written["providerInstances"]).toEqual(PROVIDER.providerInstances)
    // pauseWhenOnBattery is false in T3's balanced profile already.
    expect(written["backgroundActivity"]).toEqual(BACKGROUND.backgroundActivity)
    // A client file is not touched.
    expect(await exists(join(t3Home, "userdata", "client-settings.json"))).toBe(false)
  })

  test("previews the selected Codex provider and writes the explicit root route as one choice", async () => {
    await machine()
    const preview = await install({ dryRun: true, providers: { providers: ["openai-codex"] } })
    expect(preview.join("\n")).toContain("openai-codex/gpt-6.2-sol")
    expect(await exists(settingsFile())).toBe(false)
    await setConfig({
      pi: {
        providers: ["openai-codex", "kimi-coding-global"],
        routes: { root: { provider: "openai-codex", model: "gpt-6.2-astra", thinking: "medium" } },
      },
    })
    await install({ dryRun: false })
    expect(await read(settingsFile())).toMatchObject({
      defaultModelSelection: {
        instanceId: "pi",
        model: "openai-codex/gpt-6.2-astra",
        options: [{ id: "thinking", value: "medium" }],
      },
    })
  })

  test("preserves the native selection on upgrade, after manual changes and after a reset", async () => {
    await machine()
    const preference = { instanceId: "other-pi", model: "kimi-coding/kimi-for-coding" }
    await write(settingsFile(), { theme: "mine", defaultModelSelection: preference })
    await install({ dryRun: false })
    expect(await read(settingsFile())).toMatchObject({
      theme: "mine",
      defaultModelSelection: preference,
    })
    await write(settingsFile(), { theme: "mine", defaultModelSelection: null })
    await install({ dryRun: false })
    expect(await read(settingsFile())).toMatchObject({ defaultModelSelection: null })

    await write(settingsFile(), { theme: "mine" })
    await install({ dryRun: false })
    await write(settingsFile(), { ...ALL, defaultModelSelection: preference })
    await install({ dryRun: false })
    expect(await read(settingsFile())).toMatchObject({ defaultModelSelection: preference })
    await write(settingsFile(), { theme: "mine" })
    const rerun = await install({ dryRun: false })
    expect(rerun.join("\n")).toContain("kept the startup model reset")
    expect(await read(settingsFile())).not.toHaveProperty("defaultModelSelection")
    expect(t3Lines(await runDoctor()).join("\n")).not.toContain("defaultModelSelection")
  })

  test("does not pick a Pi model when T3's Pi instance was explicitly disabled", async () => {
    await machine()
    await write(settingsFile(), { providerInstances: { pi: { driver: "pi", enabled: false } } })
    const report = await install({ dryRun: false })
    expect(report.join("\n")).toContain("the Pi provider instance is disabled")
    expect(await read(settingsFile())).not.toHaveProperty("defaultModelSelection")
  })

  test("creates the file when T3 has a home folder but no settings yet", async () => {
    await machine()
    expect(await exists(settingsFile())).toBe(false)
    await runSetup()
    expect(await read(settingsFile())).toEqual(ALL)
  })

  test("leaves a startup selection that T3 saves during the first setup", async () => {
    await machine()
    const manual = {
      defaultModelSelection: { instanceId: "pi", model: "kimi-coding/kimi-for-coding" },
    }
    const failure = await installFailure({
      dryRun: false,
      write: (file, value, since) =>
        Effect.promise(() => write(file, manual)).pipe(
          Effect.andThen(writeSettings(file, value, since)),
        ),
    })
    expect(failure.message).toContain("changed while setup was working on it")
    expect(await read(settingsFile())).toEqual(manual)
    expect(await exists(recordPath(env()))).toBe(false)
  })

  test("a key the user set stays, whatever its value, and the rest is still written", async () => {
    await machine()
    const mine = {
      providerInstances: { pi: { driver: "pi", enabled: false } },
      defaultThreadEnvMode: "local",
      backgroundActivity: { schemaVersion: 1, profile: "performance", overrides: {} },
      sourceControlWritingStyle: { mode: "custom", customInstructions: "mine" },
      autoResumeLimitedThreads: false,
      storageCleanup: { logsAfterDays: 90 },
      enableDeviceSupport: false,
    }
    await write(settingsFile(), mine)
    const report = await runSetup()
    expect(await read(settingsFile())).toEqual({
      ...mine,
      enableAgentDeviceAccess: true,
      removeAgentCreditsOnMerge: true,
      snoozeLimitedThreads: true,
      defaultAutoPull: true,
      ...BRANCHES,
      storageCleanup: {
        logsAfterDays: 90,
        worktreeOnMerge: true,
        browserArtifactsAfterDays: 14,
        worktreeSettledAfterDays: 14,
      },
    })
    const line = t3Lines(report)[0] ?? ""
    expect(line).toContain("kept providerInstances.pi.enabled false")
    expect(line).toContain("background activity (backgroundActivity is set)")
    expect(line).toContain("source control writing (sourceControlWritingStyle is set)")
  })

  test("writes the branch naming rule on its own, each key only where unset", async () => {
    await machine()
    await write(settingsFile(), { branchNamingMode: "semantic" })
    const withSemanticMode = await runSetup()
    expect(t3Lines(withSemanticMode)[0]).not.toContain("kept branchNamingMode")
    // The mode the user chose stays; the instructions, unset, are written beside it.
    expect(await read(settingsFile())).toMatchObject({
      branchNamingMode: "semantic",
      branchNameInstructions: T3_BRANCH_INSTRUCTIONS,
    })
    await write(settingsFile(), { branchNameInstructions: "mine" })
    const report = await runSetup()
    expect(await read(settingsFile())).toMatchObject({
      branchNamingMode: "custom",
      branchNameInstructions: "mine",
    })
    expect(t3Lines(report)[0]).toContain('kept branchNameInstructions "mine"')
  })

  test("another driver's providerInstances.pi, or one disabled in its config, is left alone", async () => {
    await machine()
    for (const instance of [{ driver: "codex" }, { driver: "pi", config: { enabled: false } }]) {
      await write(settingsFile(), { providerInstances: { pi: instance } })
      const report = await runSetup()
      expect(await read(settingsFile())).toMatchObject({ providerInstances: { pi: instance } })
      expect(await read(settingsFile())).toMatchObject({ enableDeviceSupport: true })
      expect(t3Lines(report)[0]).toContain("left out: Pi provider (providerInstances.pi")
    }
  })

  test("a second run changes nothing and says so", async () => {
    await machine()
    await runSetup()
    const before = await readText(settingsFile())
    const report = await runSetup()
    expect(await readText(settingsFile())).toBe(before)
    expect(t3Lines(report)[0]).toStartWith(`= t3 settings ${settingsFile()}: already set: `)
  })

  test("a rerun reports the groups setup wrote as already written, and a group the user set as left out", async () => {
    await machine()
    await runSetup()
    const line = t3Lines(await runSetup())[0] ?? ""
    expect(line).toStartWith(`= t3 settings ${settingsFile()}: already set: `)
    expect(line).toContain("already written: background activity, source control writing")
    expect(line).not.toContain("left out")
    // The record of setup's own keys is what tells them apart from the user's.
    await write(settingsFile(), { backgroundActivity: { profile: "performance" } })
    await Bun.write(recordPath(env()), "{}")
    expect(t3Lines(await runSetup())[0]).toContain(
      "left out: background activity (backgroundActivity is set)",
    )
  })

  test("a dry run writes and records nothing", async () => {
    await machine()
    const report = await runSetup({ dryRun: true })
    expect(await exists(settingsFile())).toBe(false)
    expect(t3Lines(report)[0]).toStartWith("+ t3 settings ")
    expect(t3Lines(report)[0]).toContain("would add providerInstances.pi.driver")
    expect(t3Lines(report)[0]).toEndWith("(dry run, nothing written)")
    expect(await exists(recordPath(env()))).toBe(false)
  })
})

describe("T3 settings, device access", () => {
  test("is written where an Android SDK is found", async () => {
    await machine()
    await runSetup()
    expect(await read(settingsFile())).toMatchObject(DEVICES)
  })

  test("is left out, and said so, where neither Xcode nor an Android SDK is found", async () => {
    await machine({ sdk: false })
    const report = await runSetup()
    const written = (await read(settingsFile())) as Record<string, unknown>
    expect(written).not.toHaveProperty("enableDeviceSupport")
    expect(written).not.toHaveProperty("enableAgentDeviceAccess")
    expect(written).toMatchObject(PROVIDER)
    expect(t3Lines(report)[0]).toContain("device access left out: no Xcode or Android SDK found")
  })

  test("screenless preparation does not enable a simulator from an empty SDK directory", async () => {
    await machine()
    const lines = await install({ dryRun: false, deviceAccess: true, deviceReadiness: null })
    expect(lines.join("\n")).toContain("simulator readiness was not verified")
    expect(await read(settingsFile())).toMatchObject(PROVIDER)
    expect(await read(settingsFile())).not.toHaveProperty("enableAgentDeviceAccess")
    // The probe's negative result is not permission to remove an existing user setting.
    await write(settingsFile(), { ...PROVIDER, ...DEVICES })
    await install({ dryRun: false, deviceAccess: true, deviceReadiness: null })
    expect(await read(settingsFile())).toMatchObject(DEVICES)
  })

  test("screenless setup can enable verified simulator readiness without legacy path guessing", async () => {
    await machine({ sdk: false })
    const options = { deviceAccess: true, deviceReadiness: "verified local Android AVD" } as const
    await install({ ...options, dryRun: true })
    expect(await exists(settingsFile())).toBe(false)
    await install({ ...options, dryRun: false })
    expect(await read(settingsFile())).toMatchObject(DEVICES)
  })

  test("the screenless device phase keeps its unverified result through T3 setup", async () => {
    await machine()
    const shell = withPi()
    const preview = await runSetup({
      t3Workflow: true,
      dryRun: true,
      deviceAccess: true,
      devicePreparation: "apply",
      shell,
    })
    expect(t3Lines(preview)[0]).toContain("simulator readiness was not verified")
    expect(await exists(settingsFile())).toBe(false)
    expect(
      shell.lines().some((line) => /(?:sdkmanager|xcodebuild|simctl|emulator).*install/.test(line)),
    ).toBe(false)
  })

  test("screenless opt-in never overrides existing T3 opt-outs or prepares against corrupt settings", async () => {
    await machine()
    const options = { t3Workflow: true, deviceAccess: true, devicePreparation: "apply" } as const
    for (const flag of ["enableDeviceSupport", "enableAgentDeviceAccess"]) {
      await write(settingsFile(), { [flag]: false })
      const result = await runSetup(options)
      expect(result.lines.join("\n")).toContain(`${flag} setting is not enabled`)
      expect(await read(settingsFile())).toMatchObject({ [flag]: false })
      expect(await read(settingsFile())).not.toHaveProperty(
        flag === "enableDeviceSupport" ? "enableAgentDeviceAccess" : "enableDeviceSupport",
      )
    }
    const corrupt = "{not-json"
    await write(settingsFile(), corrupt)
    const result = await runSetup(options)
    expect(result.ok).toBe(false)
    expect(result.lines.join("\n")).toContain(
      "not prepared because T3 Code settings could not be read",
    )
    expect(await readText(settingsFile())).toBe(corrupt)
  })

  test("is written where Xcode's iOS simulator platform is found on macOS only", async () => {
    await machine({ sdk: false })
    const developer = join(t3Home, "..", "Xcode", "Developer")
    await mkdir(join(developer, "Platforms", "iPhoneSimulator.platform"), { recursive: true })
    await install({ dryRun: false, platform: "darwin" }, { DEVELOPER_DIR: developer })
    expect(await read(settingsFile())).toMatchObject(DEVICES)
    await Bun.file(settingsFile()).delete()
    await install({ dryRun: false, platform: "linux" }, { DEVELOPER_DIR: developer })
    expect(await read(settingsFile())).not.toHaveProperty("enableAgentDeviceAccess")
  })

  test("is not written when pi.t3.deviceAccess is false in the config, SDK or not", async () => {
    await machine()
    await setConfig({ pi: { t3: { deviceAccess: false } } })
    const report = await runSetup()
    expect(await read(settingsFile())).not.toHaveProperty("enableAgentDeviceAccess")
    expect(await read(settingsFile())).not.toHaveProperty("enableDeviceSupport")
    expect(await read(settingsFile())).toMatchObject(WORKTREES)
    expect(t3Lines(report)[0]).not.toContain("device access left out")
  })

  test("is not written when the option is off, SDK or not", async () => {
    await machine()
    await install({ dryRun: false, deviceAccess: false })
    expect(await read(settingsFile())).not.toHaveProperty("enableAgentDeviceAccess")
    expect(await read(settingsFile())).not.toHaveProperty("enableDeviceSupport")
  })
})

describe("T3 settings, worktrees and the config", () => {
  test("new threads in worktrees follow pi.t3.worktrees and the option", async () => {
    await machine()
    await setConfig({ pi: { t3: { worktrees: false } } })
    await runSetup()
    expect(await read(settingsFile())).not.toHaveProperty("defaultThreadEnvMode")
    await Bun.file(settingsFile()).delete()
    await setConfig({})
    await install({ dryRun: false, worktrees: false })
    expect(await read(settingsFile())).not.toHaveProperty("defaultThreadEnvMode")
    await Bun.file(settingsFile()).delete()
    await install({ dryRun: false })
    expect(await read(settingsFile())).toMatchObject(WORKTREES)
  })

  test("pi.enable false writes nothing and prints nothing", async () => {
    await machine()
    await setConfig({ pi: { enable: false } })
    const report = await runSetup()
    expect(t3Lines(report)).toEqual([])
    expect(await exists(settingsFile())).toBe(false)
  })

  test("pi.t3.scope project writes nothing globally and says why", async () => {
    await machine()
    await setConfig({ pi: { t3: { scope: "project" } } })
    const report = await runSetup()
    expect(await exists(settingsFile())).toBe(false)
    expect(t3Lines(report)[0]).toStartWith('- t3 settings: pi.t3.scope is "project"')
  })

  test("is skipped without a T3 home folder, and creates no folder", async () => {
    await machine({ t3: false })
    const report = await runSetup()
    expect(report.ok).toBe(true)
    expect(t3Lines(report)).toEqual([
      `- t3 settings: T3 Code is not installed (no ${t3Home}); nothing written`,
    ])
    expect(await exists(t3Home)).toBe(false)
  })

  test("the home folder defaults to ~/.t3 and T3CODE_HOME moves it", () => {
    expect(t3SettingsFile({ HOME: home })).toBe(join(home, ".t3", "userdata", "settings.json"))
    expect(t3SettingsFile({ HOME: home, T3CODE_HOME: "/x" })).toBe(
      join("/x", "userdata", "settings.json"),
    )
    expect(t3SettingsFile({ HOME: home, T3CODE_HOME: "" })).toBe(
      join(home, ".t3", "userdata", "settings.json"),
    )
  })

  test("runs only when Pi is in use, and only at scope user", async () => {
    await machine()
    const plain = fakeShell({ commands: ["bun", "ctx7"] })
    const unused = await runSetup({ shell: plain, env: { HOLYAGENT_HOST: "" } })
    expect(t3Lines(unused)).toEqual([])
    expect(await exists(settingsFile())).toBe(false)
    const project = await runSetup({ scope: "project" })
    expect(t3Lines(project)).toEqual([])
    expect(await exists(settingsFile())).toBe(false)
  })
})

describe("T3 settings, failures", () => {
  test("a settings.json that does not decode stops the step, names the file and stays as it is", async () => {
    await machine()
    for (const content of ['{"a": ', "[1, 2]", '"text"']) {
      await write(settingsFile(), content)
      const report = await runSetup()
      expect(report.ok).toBe(false)
      expect(t3Lines(report)).toHaveLength(1)
      expect(t3Lines(report)[0]).toStartWith("! t3 settings: ")
      expect(t3Lines(report)[0]).toContain(settingsFile())
      expect(await readText(settingsFile())).toBe(content)
    }
    // The Pi tool settings step records its own keys; none are recorded for T3's file.
    expect(await readText(recordPath(env()))).not.toContain(settingsFile())
  })

  test("a read-back that differs puts the previous content back and names the file", async () => {
    await machine()
    const before = { theme: "mine" }
    await write(settingsFile(), before)
    // A client that saves its cached settings right after ours.
    const failure = await installFailure({
      dryRun: false,
      write: (file) =>
        Effect.promise(() => Bun.write(file, JSON.stringify({ ...before, raced: true }, null, 2))),
    })
    expect(failure.message).toContain(settingsFile())
    expect(failure.message).toContain("differs from what was written")
    expect(await read(settingsFile())).toEqual(before)
    expect(await exists(recordPath(env()))).toBe(false)
  })

  test("a read-back that does not decode removes a file that did not exist", async () => {
    await machine()
    const failure = await installFailure({
      dryRun: false,
      write: (file) => Effect.promise(() => Bun.write(file, '{"torn": ')),
    })
    expect(failure.message).toContain(settingsFile())
    expect(failure.message).toContain("does not decode afterwards")
    expect(await exists(settingsFile())).toBe(false)
  })

  test("a T3 save between reading and writing is never overwritten: the step fails naming the file", async () => {
    await machine()
    await write(settingsFile(), { theme: "mine" })
    const saved = JSON.stringify({ theme: "mine", t3Saved: true })
    const failure = await installFailure({
      dryRun: false,
      write: (file, value, since) =>
        Effect.promise(() => Bun.write(file, saved)).pipe(
          Effect.andThen(writeSettings(file, value, since)),
        ),
    })
    expect(failure.message).toContain(settingsFile())
    expect(failure.message).toContain("changed while setup was working on it")
    expect(await readText(settingsFile())).toBe(saved)
    expect(await exists(recordPath(env()))).toBe(false)
    // Run again, and T3's save is still in the file beside setup's keys.
    await install({ dryRun: false })
    expect(await read(settingsFile())).toEqual({ ...ALL, theme: "mine", t3Saved: true })
  })

  test("a restore is refused when the file changed after the read-back, and the file is left as it is", async () => {
    await machine()
    await write(settingsFile(), { theme: "mine" })
    const saved = JSON.stringify({ theme: "mine", t3Saved: true })
    const failure = await installFailure({
      dryRun: false,
      // A client overwrites our write with its cached settings.
      write: (file) =>
        Effect.promise(() => Bun.write(file, JSON.stringify({ theme: "mine", raced: true }))),
      // Then T3 saves again before the restore.
      restore: (file, previous, since) =>
        Effect.promise(() => Bun.write(file, saved)).pipe(
          Effect.andThen(restoreSettings(file, previous, since)),
        ),
    })
    expect(failure.message).toContain(settingsFile())
    expect(failure.message).toContain("differs from what was written")
    expect(failure.message).toContain("it changed again, so it was left as it is")
    expect(await readText(settingsFile())).toBe(saved)
    expect(await exists(recordPath(env()))).toBe(false)
  })

  test("a file that did not exist is deleted only while it holds what the read-back saw", async () => {
    await machine()
    const saved = JSON.stringify({ t3Saved: true })
    const failure = await installFailure({
      dryRun: false,
      write: (file) => Effect.promise(() => Bun.write(file, '{"torn": ')),
      // T3 saves its own settings before the removal.
      restore: (file, previous, since) =>
        Effect.promise(() => Bun.write(file, saved)).pipe(
          Effect.andThen(restoreSettings(file, previous, since)),
        ),
    })
    expect(failure.message).toContain(settingsFile())
    expect(failure.message).toContain("it changed again, so it was left as it is")
    expect(await readText(settingsFile())).toBe(saved)
  })

  test("a setup record that cannot be read stops the step before the file changes", async () => {
    await machine()
    await write(settingsFile(), { theme: "mine" })
    await write(recordPath(env()), "not json")
    const report = await runSetup()
    expect(report.ok).toBe(false)
    expect(t3Lines(report)[0]).toStartWith("! t3 settings: ")
    expect(await read(settingsFile())).toEqual({ theme: "mine" })
  })
})

describe("holyagent setup --undo, T3 Code settings", () => {
  test("removes only the keys the record says setup wrote", async () => {
    await machine()
    // Set before setup, so setup does not write or record it.
    const mine = { defaultAutoPull: true, theme: "mine" }
    await write(settingsFile(), mine)
    await runSetup()
    // Changed since: stays, and is named.
    await write(settingsFile(), {
      ...ALL,
      ...mine,
      snoozeLimitedThreads: false,
      storageCleanup: { ...CLEANUP.storageCleanup, logsAfterDays: 7 },
      userAdded: 1,
    })
    const report = await runSetup({ undo: true })
    expect(await read(settingsFile())).toEqual({
      ...mine,
      snoozeLimitedThreads: false,
      storageCleanup: { logsAfterDays: 7 },
      userAdded: 1,
    })
    const line = t3Lines(report)[0] ?? ""
    expect(line).toStartWith(`- t3 settings ${settingsFile()}: removed `)
    expect(line).toContain("kept snoozeLimitedThreads false (setup wrote true)")
    expect(line).toContain("storageCleanup.logsAfterDays 7 (setup wrote 30)")
    // The record is cleared: a second undo has nothing to do.
    expect(t3Lines(await runSetup({ undo: true }))).toEqual([])
  })

  test("a file setup created is left as an empty object, and a dry run changes nothing", async () => {
    await machine()
    await runSetup()
    const before = await readText(settingsFile())
    const dry = await runSetup({ undo: true, dryRun: true })
    expect(await readText(settingsFile())).toBe(before)
    expect(t3Lines(dry)[0]).toEndWith("(dry run, nothing written)")
    await runSetup({ undo: true })
    expect(await read(settingsFile())).toEqual({})
  })

  test("prints nothing on a machine where the step never ran", async () => {
    await machine()
    await write(settingsFile(), { defaultAutoPull: true })
    expect(t3Lines(await runSetup({ undo: true }))).toEqual([])
    expect(await read(settingsFile())).toEqual({ defaultAutoPull: true })
  })

  test("a file that does not decode stops the undo, names the file and keeps the record", async () => {
    await machine()
    await runSetup()
    await write(settingsFile(), "{ nope")
    const report = await runSetup({ undo: true })
    expect(report.ok).toBe(false)
    expect(t3Lines(report)[0]).toContain(settingsFile())
    expect(await readText(settingsFile())).toBe("{ nope")
    await write(settingsFile(), ALL)
    expect(t3Lines(await runSetup({ undo: true }))[0]).toStartWith("- t3 settings ")
  })

  test("a T3 save between reading and writing is never overwritten by the undo, and the record stays", async () => {
    await machine()
    await runSetup()
    const saved = JSON.stringify({ ...ALL, t3Saved: true })
    const failure = await Effect.runPromise(
      undoT3Settings(env(), {
        dryRun: false,
        write: (file, value, since) =>
          Effect.promise(() => Bun.write(file, saved)).pipe(
            Effect.andThen(writeSettings(file, value, since)),
          ),
      }).pipe(Effect.flip),
    )
    expect(failure.message).toContain(settingsFile())
    expect(failure.message).toContain("changed while setup was working on it")
    expect(await readText(settingsFile())).toBe(saved)
    // The record is kept, so a rerun removes setup's keys and keeps T3's save.
    expect(t3Lines(await runSetup({ undo: true }))[0]).toStartWith("- t3 settings ")
    expect(await read(settingsFile())).toEqual({ t3Saved: true })
  })

  test("a read-back that differs puts the file back as it was and keeps the record", async () => {
    await machine()
    await runSetup()
    const before = await readText(settingsFile())
    const failure = await Effect.runPromise(
      undoT3Settings(env(), {
        dryRun: false,
        // A client overwrites the undo with its cached settings.
        write: (file) =>
          Effect.promise(() => Bun.write(file, JSON.stringify({ ...ALL, raced: true }))),
      }).pipe(Effect.flip),
    )
    expect(failure.message).toContain(settingsFile())
    expect(failure.message).toContain("differs from what was written")
    expect(failure.message).toContain("its previous content was put back")
    expect(await read(settingsFile())).toEqual(JSON.parse(before))
    // The record is kept, so the undo can be run again.
    expect(t3Lines(await runSetup({ undo: true }))[0]).toStartWith("- t3 settings ")
    expect(await read(settingsFile())).toEqual({})
  })

  test("removes the branch naming keys setup wrote, and keeps ones the user changed", async () => {
    await machine()
    await runSetup()
    await write(settingsFile(), { ...ALL, branchNameInstructions: "mine" })
    const line = t3Lines(await runSetup({ undo: true }))[0] ?? ""
    expect(line).toContain('branchNamingMode "custom"')
    expect(line).toContain('kept branchNameInstructions "mine" (setup wrote')
    expect(await read(settingsFile())).toEqual({ branchNameInstructions: "mine" })
  })

  test("undoes through the step's own entry", async () => {
    await machine()
    await install({ dryRun: false })
    const lines = await Effect.runPromise(undoT3Settings(env(), { dryRun: false }))
    expect(lines[0]).toStartWith(`- t3 settings ${settingsFile()}: removed `)
    expect(await read(settingsFile())).toEqual({})
  })
})

describe("holyagent doctor, T3 Code settings", () => {
  test("reports a file that lacks the keys, then that it holds them", async () => {
    await machine()
    const lacking = t3Lines(await runDoctor())
    expect(lacking).toHaveLength(1)
    expect(lacking[0]).toStartWith(
      `~ t3 settings ${settingsFile()} lacks providerInstances.pi.driver`,
    )
    expect(lacking[0]).toEndWith("run `holyagent setup`")
    await runSetup()
    const report = await runDoctor()
    expect(t3Lines(report)).toEqual([
      `ok   t3 settings: ${settingsFile()} holds the settings HolyAgent writes`,
    ])
    expect(report.ok).toBe(true)
  })

  test("counts a key the user set to another value as held, and a device key without a host as not wanted", async () => {
    await machine({ sdk: false })
    await runSetup()
    expect(t3Lines(await runDoctor())[0]).toStartWith("ok   t3 settings")
    await write(settingsFile(), { ...ALL, defaultAutoPull: false })
    expect(t3Lines(await runDoctor())[0]).toStartWith("ok   t3 settings")
  })

  test("names the branch naming keys a file lacks", async () => {
    await machine()
    await runSetup()
    const { branchNamingMode: _mode, branchNameInstructions: _text, ...rest } = ALL
    await write(settingsFile(), rest)
    const line = t3Lines(await runDoctor())[0] ?? ""
    expect(line).toContain("lacks branchNamingMode, branchNameInstructions;")
    await write(settingsFile(), {
      ...rest,
      branchNamingMode: "static",
      branchNameInstructions: "",
    })
    expect(t3Lines(await runDoctor())[0]).toStartWith("ok   t3 settings")
  })

  test("names a file that does not decode, without failing doctor", async () => {
    await machine()
    await write(settingsFile(), "{ nope")
    const report = await runDoctor()
    expect(t3Lines(report)[0]).toStartWith("~ t3 settings: ")
    expect(t3Lines(report)[0]).toContain(settingsFile())
    expect(report.ok).toBe(true)
    expect(await readText(settingsFile())).toBe("{ nope")
  })

  test("prints nothing without a T3 home folder, with pi.enable off or without Pi", async () => {
    await machine({ t3: false })
    expect(t3Lines(await runDoctor())).toEqual([])
    await machine()
    await setConfig({ pi: { enable: false } })
    expect(t3Lines(await runDoctor())).toEqual([])
    await setConfig({})
    const plain = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await Effect.runPromise(
      doctor(env({ HOLYAGENT_HOST: "" }), { fix: false, cwd: project, scope: "user" }).pipe(
        Effect.provide(plain.layer),
      ),
    )
    expect(t3Lines(report)).toEqual([])
  })

  test("says nothing about per-device client settings", async () => {
    await machine()
    const report = await runDoctor()
    expect(report.lines.join("\n")).not.toMatch(
      /client settings|contextWindowMeter|followUpBehavior/i,
    )
  })
})

describe("the supported T3 Code onboarding", () => {
  test("directs users to initialize T3 Code before setup writes any config", async () => {
    await machine({ t3: false })
    const result = await runSetup({ t3Workflow: true })
    expect(result.ok).toBe(false)
    expect(result.lines.join("\n")).toContain("open T3 Code once")
    expect(await exists(settingsFile())).toBe(false)
    const doctorReport = await runDoctor({}, true)
    expect(doctorReport.ok).toBe(false)
    expect(doctorReport.lines.join("\n")).toContain("open T3 Code once")
  })

  test("setup enables Pi and doctor verifies it without reading or changing Claude settings", async () => {
    await machine()
    const claude = join(home, ".claude", "settings.json")
    await write(claude, "[1]")
    const before = await runDoctor({}, true)
    expect(before.ok).toBe(false)
    expect(before.lines.join("\n")).toContain("Pi provider is not enabled")
    const configured = await runSetup({ t3Workflow: true })
    expect(configured.ok).toBe(true)
    expect(await read(settingsFile())).toMatchObject(PROVIDER)
    expect(await readText(claude)).toBe("[1]")
    const after = await runDoctor({}, true)
    expect(after.ok).toBe(true)
    expect(after.lines.join("\n")).toContain("holds the settings HolyAgent writes")
    expect(after.lines.join("\n")).not.toContain(claude)
  })

  test("doctor reports a disabled provider without overwriting the user's choice", async () => {
    await machine()
    const disabled = { providerInstances: { pi: { driver: "pi", enabled: false } } }
    await write(settingsFile(), disabled)
    const report = await runDoctor({}, true)
    expect(report.ok).toBe(false)
    expect(report.lines.join("\n")).toContain("Pi provider is not enabled")
    expect(await read(settingsFile())).toEqual(disabled)
  })
})
