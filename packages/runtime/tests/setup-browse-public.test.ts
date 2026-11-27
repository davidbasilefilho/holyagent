import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { type BrowsePair, configureBrowse, planBrowse } from "../src/setup/browse-setup.ts"
import {
  BROWSE_EXTENSION_IDS,
  BROWSE_VERSION,
  browsePairingFile,
  browserDirectories,
} from "../src/setup/browse.ts"
import { chooseForm } from "../src/setup/form.ts"
import { capabilityOffers, runInteractive } from "../src/setup/tui/session.ts"
import type { Choices, SetupTuiModule, TuiInput } from "../src/setup/tui/types.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"
import { mount, type Mounted } from "./setup-tui-harness.ts"

let home: string
let remove: () => Promise<void>
let open: Mounted | undefined
const TOKEN = "O".repeat(43)
const PIN = `@opencode/browse@${BROWSE_VERSION}`
const pkg = (prefix = "/tmp/bunx-12345678-holyagent@dev") => `${prefix}/node_modules/holyagent`
const env = () => ({
  HOME: home,
  LOCALAPPDATA: join(home, "local"),
  APPDATA: join(home, "app"),
  DISPLAY: ":0",
  HOLYAGENT_HOST: "pi",
})
const receipt = () => join(home, ".holyagent", "browse-setup.json")
const selectionFile = () => join(home, ".holyagent", "browse-selection.json")
const terminal = { stdin: true, stdout: true }
const NORMAL = { form: "normal", source: "flag", reason: "--form normal" } as const

beforeEach(async () => {
  const made = await scratch("holyagent-public-browse-")
  home = made.directory
  remove = made.remove
})
afterEach(async () => {
  open?.destroy()
  open = undefined
  await remove()
})

const json = async (file: string, content: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(content))
}

const profiles = async () => {
  const chrome = browserDirectories(env())[0]
  if (chrome === undefined) throw new Error("no supported fixture browser")
  await json(join(chrome.directory, "Local State"), {
    profile: { info_cache: { "Profile 1": {}, "Profile 2": {}, "Profile 3": {} } },
  })
  const prefs = (setting: unknown) => ({
    extensions: { settings: { [BROWSE_EXTENSION_IDS[0] ?? ""]: setting } },
  })
  await json(join(chrome.directory, "Profile 1", "Preferences"), prefs({}))
  await json(join(chrome.directory, "Profile 2", "Preferences"), {})
  await json(join(chrome.directory, "Profile 3", "Preferences"), prefs({ disable_reasons: [1] }))
  return chrome.name
}

const paired = () =>
  json(browsePairingFile(env()), {
    local: { token: TOKEN, name: "Chrome fixture", lastSeen: Date.now() },
  })
const fixtureShell = (version = BROWSE_VERSION, exitCode = 0) =>
  fakeShell({
    commands: ["pi"],
    respond: () => ({ stdout: `${version}\n`, exitCode }),
  })
const offer = (root?: string) => Effect.runPromise(planBrowse(env(), root ?? pkg()))

const installedChromium = async () => {
  const files =
    process.platform === "win32"
      ? [
          "local/Google/Chrome/Application/chrome.exe",
          "local/Microsoft/Edge/Application/msedge.exe",
        ]
      : ["bin/google-chrome", "bin/microsoft-edge"]
  for (const file of files) {
    const path = join(home, file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
  }
}

const choiceSession = async (options: {
  readonly select?: boolean
  readonly profile?: number
  readonly browserIds?: ReadonlyArray<string>
  readonly useInitial?: boolean
  readonly defaultDesktop?: string
  readonly beforeApply?: () => Promise<void>
  readonly browserUseEnabled?: boolean
  readonly scope?: "user" | "project"
  readonly dryRun?: boolean
  readonly cancel?: boolean
  readonly noTui?: boolean
  readonly headless?: boolean
  readonly pairExit?: number
  readonly pairWrites?: boolean
  readonly pairExits?: readonly number[]
  readonly combined?: boolean
  readonly profileOnly?: boolean
}) => {
  if (options.profileOnly !== true) await installedChromium()
  const shell =
    options.defaultDesktop === undefined
      ? fixtureShell()
      : fakeShell({
          commands: ["pi", "xdg-settings"],
          respond: (line) => ({
            stdout: line.includes("xdg-settings get")
              ? `${options.defaultDesktop}\n`
              : `${BROWSE_VERSION}\n`,
          }),
        })
  const bin = join(home, "bin")
  const calls: Array<string> = []
  const notices: Array<string> = []
  let review: ReadonlyArray<string> | undefined
  let displayed = false
  let initialBrowserIds: ReadonlyArray<string> | undefined
  let offeredBrowserIds: ReadonlyArray<string> | undefined
  let closed = false
  const pair: BrowsePair = (command, args, { cwd, env: childEnv }) =>
    Effect.gen(function* () {
      if (!closed) return yield* Effect.die("pairing started before terminal restored")
      const exit = options.pairExits?.[calls.length] ?? options.pairExit ?? 0
      if (options.pairWrites !== false && exit === 0)
        yield* Effect.promise(() =>
          (options.browserIds?.length ?? 0) < 2
            ? paired()
            : json(
                browsePairingFile(env()),
                Object.fromEntries(
                  Array.from({ length: calls.length + 1 }, (_, index) => [
                    `profile-${index}`,
                    { token: TOKEN, name: `Browser fixture ${index}`, lastSeen: Date.now() },
                  ]),
                ),
              ),
        )
      calls.push([command, ...args].join(" "))
      expect(cwd).toBe(home)
      expect(childEnv["OPENCODE_BROWSER_AUTO_UPDATE"]).toBe("off")
      return exit
    })
  const apply = () => Effect.succeed({ ok: true, lines: ["= Pi fixture configured"] })
  const drive: SetupTuiModule["runSetupTui"] = async (input: TuiInput) => {
    displayed = true
    initialBrowserIds = input.initial.browseBrowserIds
    offeredBrowserIds = input.offer.browse?.browsers?.map(({ id }) => id)
    const choices: Choices = {
      ...input.initial,
      ...(options.browserUseEnabled === undefined
        ? {}
        : {
            capabilities: { ...input.initial.capabilities, browserUse: options.browserUseEnabled },
          }),
      piProviders: { providers: ["kimi-coding-global"] },
      ...(options.select === undefined ? {} : { browseSetup: options.select }),
      ...(options.profile === undefined ? {} : { browseProfile: options.profile }),
      ...(options.useInitial === true
        ? {}
        : { browseBrowserIds: options.browserIds ?? (options.select === false ? [] : ["chrome"]) }),
    }
    review = (await input.review(choices)).browse
    if (options.cancel === true) return { _tag: "Cancelled" }
    await options.beforeApply?.()
    const applied = await input.apply(choices, new AbortController().signal)
    expect(calls).toEqual([])
    closed = true
    return { _tag: "Applied", applied }
  }
  const result = await Effect.runPromise(
    runInteractive({
      env: { ...env(), PATH: bin },
      cwd: home,
      scope: options.scope ?? "user",
      undo: false,
      dryRun: options.dryRun ?? false,
      terminal,
      noTui: options.noTui ?? false,
      choiceFlag: false,
      t3Workflow: true,
      form: options.headless === true ? chooseForm({}, "headless") : NORMAL,
      browse: { packageRoot: pkg(), pair },
      load: () => Effect.succeed({ runSetupTui: drive }),
      notify: (line) => Effect.sync(() => void notices.push(line)),
      apply,
      previewPi: apply,
      ...(options.combined === true ? { combined: { run: apply } } : {}),
    }).pipe(Effect.provide(shell.layer)),
  )
  return {
    result,
    calls,
    review,
    displayed,
    notices,
    initialBrowserIds,
    offeredBrowserIds,
    defaultQueries: shell.lines().filter((line) => line.includes("xdg-settings")),
    versions: shell.lines().filter((line) => line.includes("browse --version")),
  }
}

describe("public setup's OpenCode Browse choice", () => {
  test.skipIf(process.platform !== "linux")(
    "named Codex desktop setup opens the official browser guide only after reviewed apply and terminal restore",
    async () => {
      const bin = join(home, "bin")
      await mkdir(bin)
      const helium = join(bin, "helium")
      await writeFile(helium, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
      let closed = false
      const shell = fakeShell({
        commands: ["chatgpt"],
        respond: (command) => {
          if (command.startsWith("/usr/bin/dpkg-query "))
            return { stdout: "installed 26.1109.1905-1" }
          if (command.startsWith("/bin/sh ")) expect(closed).toBe(true)
          return undefined
        },
      })
      const calls: Array<[string, boolean]> = []
      const result = await Effect.runPromise(
        runInteractive({
          env: { HOME: home, PATH: bin, DISPLAY: ":0" },
          cwd: home,
          scope: "user",
          undo: false,
          dryRun: false,
          terminal,
          noTui: false,
          choiceFlag: false,
          t3Workflow: true,
          form: NORMAL,
          combined: {
            codexHome: join(home, "codex"),
            onlyCodex: true,
            run: (target, _choices, _capabilities, dryRun) =>
              Effect.sync(() => {
                calls.push([target, dryRun])
                return { ok: true, lines: ["= test profile"] }
              }),
          },
          notify: () => Effect.void,
          apply: () => Effect.die("named Codex must not run another harness"),
          load: () =>
            Effect.succeed({
              runSetupTui: async (input) => {
                expect(input.offer.harnesses?.onlyCodex).toBe(true)
                expect(input.initial.harnesses).toEqual({ pi: false, claude: false, codex: true })
                expect(input.offer.harnesses?.codexDesktop?.extensionBrowsers).toContainEqual({
                  id: "helium",
                  name: "Helium",
                })
                const choices = { ...input.initial, codexBrowserHandoff: "helium" }
                const review = await input.review(choices)
                expect(review.harnesses?.[0]?.lines.join("\n")).toContain("OpenAI's setup guide")
                const applied = await input.apply(choices, new AbortController().signal)
                expect(shell.calls.map(({ command }) => command)).toEqual(["/usr/bin/dpkg-query"])
                closed = true
                return { _tag: "Applied", applied }
              },
            }),
        }).pipe(Effect.provide(shell.layer)),
      )
      expect(calls).toEqual([
        ["codex", true],
        ["codex", false],
      ])
      expect(shell.calls.at(-1)?.args.slice(-2)).toEqual([
        helium,
        "https://learn.chatgpt.com/docs/chrome-extension",
      ])
      expect(result).toMatchObject({ kind: "applied", report: { ok: true } })
    },
  )

  test.each([false, true])(
    "reviews selected browser/profile and uses official pair after renderer closes (combined %j)",
    async (combined) => {
      const chrome = await profiles()
      const run = await choiceSession({ combined })
      expect(run.review?.join("\n")).toContain(`${chrome}, Profile 1: enter its own one-time code`)
      expect(run.review?.join("\n")).not.toContain(`${chrome}, Profile 2: enter`)
      expect(run.review?.join("\n")).toContain(`Configure ${PIN} with bunx`)
      expect(run.calls).toEqual([`bunx --package ${PIN} browse pair`])
      expect(run.versions).toEqual([`bunx --package ${PIN} browse --version`])
      expect(run.result).toMatchObject({ kind: "applied", report: { ok: true } })
      expect(JSON.stringify(run.result)).not.toContain(TOKEN)
      expect(await Bun.file(receipt()).json()).toEqual({ version: BROWSE_VERSION })
      expect(await offer()).toMatchObject({ next: "none" })
      const repeated = await choiceSession({ select: true })
      expect(repeated.calls).toEqual([])
      expect(repeated.versions).toEqual([])
    },
  )

  test("a profile without the extension gets installation guidance rather than pairing a different profile", async () => {
    const chrome = await profiles()
    const run = await choiceSession({ select: true, profile: 1 })
    expect(run.review?.join("\n")).toContain(
      `${chrome}, Profile 2: add the official Browse extension`,
    )
    expect(run.calls).toEqual([])
    expect(run.versions).toEqual([`bunx --package ${PIN} browse --version`])
    expect(await Bun.file(receipt()).exists()).toBe(false)
    expect(JSON.stringify(run.result)).toContain("then review setup again")
  })

  test.skipIf(process.platform !== "linux")(
    "stale profile-only Chromium is not selectable and an ambiguous installed browser never guesses a profile",
    async () => {
      const helium = browserDirectories(env()).find(({ name }) => name === "Helium")
      if (helium === undefined) throw new Error("missing fixture Helium profile root")
      const prefs = { extensions: { settings: { [BROWSE_EXTENSION_IDS[0] ?? ""]: {} } } }
      await json(join(helium.directory, "Default", "Preferences"), prefs)
      await json(selectionFile(), { browsers: ["helium"] })
      const missing = await choiceSession({ useInitial: true, profileOnly: true, select: true })
      expect(missing.offeredBrowserIds).not.toContain("helium")
      expect(missing.initialBrowserIds).toEqual(["helium"])
      expect(missing.calls).toEqual([])
      expect(missing.versions).toEqual([])
      expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: ["helium"] })

      const binary = join(home, "bin", "helium")
      await mkdir(dirname(binary), { recursive: true })
      await writeFile(binary, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
      await json(join(helium.directory, "Local State"), {
        profile: { info_cache: { Default: {}, "Profile 1": {} } },
      })
      await json(join(helium.directory, "Profile 1", "Preferences"), prefs)
      const ambiguous = await choiceSession({ useInitial: true, select: true })
      expect(ambiguous.offeredBrowserIds).toContain("helium")
      expect(ambiguous.review?.join("\n")).toContain("more than one profile is possible")
      expect(ambiguous.calls).toEqual([])
      expect(ambiguous.versions).toEqual([])
      expect(await Bun.file(receipt()).exists()).toBe(false)
    },
  )

  test.each([0, 1])(
    "ready selected browsers each get a labeled official handoff; second exit %i keeps the first",
    async (secondExit) => {
      const chrome = await profiles()
      const edge = browserDirectories(env()).find(({ name }) => name === "Microsoft Edge")
      if (edge === undefined) throw new Error("Microsoft Edge fixture root missing")
      await json(join(edge.directory, "Default", "Preferences"), {
        extensions: { settings: { [BROWSE_EXTENSION_IDS[0] ?? ""]: {} } },
      })
      const browserIds = ["chrome", "edge"]
      const run = await choiceSession({ browserIds, pairExits: [0, secondExit] })
      expect(run.review?.join("\n")).toContain(`${chrome}, Profile 1: enter its own one-time code`)
      expect(run.review?.join("\n")).toContain(
        "Microsoft Edge, Default: enter its own one-time code",
      )
      expect(run.notices.filter((line) => line.includes("Enter this one-time code"))).toEqual([
        `OpenCode Browse: ${chrome}, Profile 1. Enter this one-time code in that profile only.`,
        "OpenCode Browse: Microsoft Edge, Default. Enter this one-time code in that profile only.",
      ])
      expect(run.calls).toEqual(
        Array.from({ length: 2 }, () => `bunx --package ${PIN} browse pair`),
      )
      expect(run.versions).toEqual([`bunx --package ${PIN} browse --version`])
      expect(run.result).toMatchObject({ kind: "applied", report: { ok: secondExit === 0 } })
      const stored = await Bun.file(browsePairingFile(env())).json()
      expect(Object.keys(stored)).toEqual(
        secondExit === 0 ? ["profile-0", "profile-1"] : ["profile-0"],
      )
      const repeated = await choiceSession({ browserIds })
      expect(repeated.calls).toEqual([])
      expect(repeated.review?.join("\n")).toContain("keep existing pairings")
    },
  )

  test("skipping, cancelling, dry-run, headless and unattended never invoke Browse", async () => {
    await profiles()
    const skip = await choiceSession({ select: false })
    expect(skip.review?.join("\n")).toContain("no browser selected")
    const cancel = await choiceSession({ select: true, cancel: true })
    const dry = await choiceSession({ select: true, dryRun: true })
    const unattended = await choiceSession({ select: true, noTui: true })
    const headless = await choiceSession({ select: true, headless: true })
    expect(unattended.displayed).toBe(false)
    for (const result of [skip, cancel, dry, unattended, headless]) {
      expect(result.calls).toEqual([])
      expect(result.versions).toEqual([])
    }
    expect(await Bun.file(receipt()).exists()).toBe(false)
    expect(await Bun.file(browsePairingFile(env())).exists()).toBe(false)
  })

  test("a child success without verified pairing and a pair timeout leave no setup receipt", async () => {
    await profiles()
    const unverified = await choiceSession({ select: true, pairWrites: false })
    expect(unverified.result).toMatchObject({ kind: "applied", report: { ok: false } })
    expect(JSON.stringify(unverified.result)).toContain("no new connected profile was confirmed")
    const timedOut = await choiceSession({ select: true, pairExit: 1, pairWrites: false })
    expect(timedOut.result).toMatchObject({ kind: "applied", report: { ok: false } })
    expect(JSON.stringify(timedOut.result)).toContain("pairing was not confirmed (exit 1)")
    expect(await Bun.file(receipt()).exists()).toBe(false)
  })

  test("exact-version failure retains prior managed receipt and pairing; update replaces only the receipt", async () => {
    await paired()
    await json(receipt(), { version: "0.1.4" })
    const pairingBefore = await readFile(browsePairingFile(env()), "utf8")
    const oldLauncher = join(home, ".local", "bin", "browse")
    const otherMcp = join(home, ".config", "opencode", "opencode.json")
    await json(oldLauncher, { external: true })
    await json(otherMcp, { mcp: { unrelated: {} } })
    const plan = await offer()
    expect(plan).toMatchObject({ action: "Update", next: "paired" })
    const pair = () => Effect.die("an existing pairing must not trigger a new one")
    const failed = await Effect.runPromise(
      configureBrowse(env(), plan, pair).pipe(Effect.provide(fixtureShell("0.1.4").layer)),
    )
    expect(failed.ok).toBe(false)
    expect(await Bun.file(receipt()).json()).toEqual({ version: "0.1.4" })
    const done = await Effect.runPromise(
      configureBrowse(env(), plan, pair).pipe(Effect.provide(fixtureShell().layer)),
    )
    expect(done.ok).toBe(true)
    expect(await Bun.file(receipt()).json()).toEqual({ version: BROWSE_VERSION })
    expect(await readFile(browsePairingFile(env()), "utf8")).toBe(pairingBefore)
    expect(await Bun.file(oldLauncher).json()).toEqual({ external: true })
    expect(await Bun.file(otherMcp).json()).toEqual({ mcp: { unrelated: {} } })
  })

  test.each([
    [pkg("/user/.npm/_npx/abcd"), `npm exec --yes --package=${PIN} -- browse --version`],
    [
      pkg("/user/mise/installs/npm-holyagent/0.4.0/lib"),
      `mise exec npm:${PIN} -- browse --version`,
    ],
  ])("recognizes %s and verifies through its runner", async (root, command) => {
    await paired()
    const shell = fixtureShell()
    await Effect.runPromise(
      configureBrowse(env(), await offer(root), () => Effect.die("already paired")).pipe(
        Effect.provide(shell.layer),
      ),
    )
    expect(shell.lines()).toEqual([command])
  })

  test("the main row only navigates; one page toggles the feature and independent browser checkboxes", async () => {
    open = await mount({
      width: 64,
      height: 21,
      env: { TERM: "vt100", LC_ALL: "C" },
      t3: false,
      browserUseEnabled: false,
      browserIds: [],
      browse: {
        ...(await offer()),
        browsers: [
          { id: "helium", name: "Helium" },
          { id: "registered-aurora", name: "Aurora Browser" },
        ],
      },
      capabilities: capabilityOffers(NORMAL).filter(({ feature }) => feature === "browserUse"),
    })
    const screen = open
    const text = () => screen.lines().join("\n")
    const click = async (label: string) => {
      const y = screen.lines().findIndex((line) => line.includes(label))
      expect(y).toBeGreaterThan(0)
      await screen.click(4, y)
    }
    expect(screen.lines().find((line) => line.includes("browser-use"))).not.toContain("[")
    await screen.keys("enter")
    expect(text()).toContain("Enable browser-use")
    expect(text()).not.toContain("Helium")
    expect(text()).not.toContain("Aurora Browser")
    await screen.keys("escape")
    await click("browser-use")
    expect(text()).toContain("Enable browser-use")
    expect(screen.reviews).toHaveLength(0)

    await screen.keys("enter")
    expect(text()).toContain("Disable browser-use")
    expect(text()).toContain("[ ] Helium")
    expect(text()).toContain("[ ] Aurora Browser")
    expect(text()).not.toMatch(
      /automatic profile|select browsers|browser profile|Firefox|Internet Explorer|compatibility unverified|not supported/i,
    )
    await screen.keys("down", "enter")
    await click("Aurora Browser")
    expect(text()).toContain("[x] Helium")
    expect(text()).toContain("[x] Aurora Browser")
    await screen.keys("escape")
    await click("browser-use")
    expect(text()).toContain("[x] Helium")
    expect(text()).toContain("[x] Aurora Browser")
    await click("Helium")
    expect(text()).toContain("[ ] Helium")
    expect(text()).toContain("[x] Aurora Browser")
    await screen.keys("escape", "end", "enter")
    expect(screen.reviews[0]).toMatchObject({
      capabilities: { browserUse: true },
      browseBrowserIds: ["registered-aurora"],
    })
    expect(screen.applies).toEqual([])
    await click("Back")
    await click("browser-use")
    await screen.keys("enter")
    expect(text()).toContain("Enable browser-use")
    expect(text()).not.toContain("Helium")
    expect(text()).not.toContain("Aurora Browser")
    await screen.keys("escape", "end", "enter")
    expect(screen.reviews.at(-1)).toMatchObject({
      capabilities: { browserUse: false },
      browseBrowserIds: ["registered-aurora"],
    })
  })

  test("Codex extension settings permit separate reviewed choices of two Chromium targets", async () => {
    open = await mount({
      width: 90,
      height: 30,
      t3: false,
      combined: true,
      onlyCodex: true,
      codexHome: "/tmp/fixture-codex",
      codexDesktop: {
        name: "ChatGPT",
        extensionBrowsers: [
          { id: "helium", name: "Helium" },
          { id: "registered-aurora", name: "Aurora Browser" },
        ],
      },
    })
    const screen = open
    const text = () => screen.lines().join("\n")
    const click = async (label: string) => {
      const y = screen.lines().findIndex((line) => line.includes(label))
      expect(y).toBeGreaterThan(0)
      await screen.click(4, y)
    }
    expect(text()).toContain("Codex In-App Browser")
    await click("ChatGPT browser extension")
    expect(text()).toContain("Install in Helium")
    expect(text()).toContain("Install in Aurora Browser")
    expect(text()).not.toMatch(/Firefox|Internet Explorer|not supported|compatibility unverified/i)
    await click("Install in Aurora Browser")
    expect(text()).toContain("Install in Aurora Browser (selected)")
    await click("Install in Helium")
    expect(text()).toContain("Install in Helium (selected)")
    expect(text()).not.toContain("Install in Aurora Browser (selected)")
    expect(text()).toContain("does not install")
    await screen.keys("escape", "end", "enter")
    expect(screen.reviews[0]).toMatchObject({ codexBrowserHandoff: "helium" })
    expect(screen.applies).toEqual([])
  })

  test("an eligible Codex desktop with no Chromium executable keeps In-App Browser only", async () => {
    open = await mount({
      width: 80,
      height: 21,
      t3: false,
      combined: true,
      onlyCodex: true,
      codexHome: "/tmp/fixture-codex",
      codexDesktop: { name: "ChatGPT" },
    })
    const screen = open
    expect(screen.lines().join("\n")).toContain("Codex In-App Browser")
    expect(screen.lines().join("\n")).not.toContain("ChatGPT browser extension")
    expect(screen.reviews).toEqual([])
  })

  test.skipIf(process.platform !== "linux")(
    "defaults once from the detected supported OS browser and restores the saved list including empty",
    async () => {
      await profiles()
      const bin = join(home, "bin")
      await mkdir(bin)
      for (const name of ["google-chrome", "microsoft-edge", "firefox"])
        await writeFile(join(bin, name), "#!/bin/sh\nexit 1\n", { mode: 0o700 })

      const first = await choiceSession({
        useInitial: true,
        defaultDesktop: "microsoft-edge.desktop",
        cancel: true,
      })
      expect(first.initialBrowserIds).toEqual(["edge"])
      expect(first.defaultQueries).toHaveLength(1)
      expect(await Bun.file(selectionFile()).exists()).toBe(false)
      const notDetected = await choiceSession({
        useInitial: true,
        defaultDesktop: "brave-browser.desktop",
        cancel: true,
      })
      expect(notDetected.initialBrowserIds).toEqual([])
      const incompatible = await choiceSession({
        useInitial: true,
        defaultDesktop: "firefox.desktop",
        cancel: true,
      })
      expect(incompatible.initialBrowserIds).toEqual([])
      await choiceSession({
        useInitial: true,
        defaultDesktop: "brave-browser.desktop",
        browserUseEnabled: false,
      })
      expect(await Bun.file(selectionFile()).exists()).toBe(false)
      await choiceSession({
        useInitial: true,
        defaultDesktop: "brave-browser.desktop",
        scope: "project",
      })
      expect(await Bun.file(selectionFile()).exists()).toBe(false)

      const firstEmpty = await choiceSession({
        useInitial: true,
        defaultDesktop: "brave-browser.desktop",
      })
      expect(firstEmpty.initialBrowserIds).toEqual([])
      expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: [] })
      const retainedEmpty = await choiceSession({
        useInitial: true,
        defaultDesktop: "microsoft-edge.desktop",
        cancel: true,
      })
      expect(retainedEmpty.initialBrowserIds).toEqual([])
      expect(retainedEmpty.defaultQueries).toEqual([])
      await rm(selectionFile())

      const unchanged = await choiceSession({
        useInitial: true,
        defaultDesktop: "microsoft-edge.desktop",
        select: false,
      })
      expect(unchanged.initialBrowserIds).toEqual(["edge"])
      expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: ["edge"] })
      const retainedDefault = await choiceSession({
        useInitial: true,
        defaultDesktop: "google-chrome.desktop",
        cancel: true,
      })
      expect(retainedDefault.initialBrowserIds).toEqual(["edge"])
      expect(retainedDefault.defaultQueries).toEqual([])

      await choiceSession({ browserIds: ["chrome", "edge"], select: false })
      expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: ["chrome", "edge"] })
      const restored = await choiceSession({
        useInitial: true,
        defaultDesktop: "microsoft-edge.desktop",
        cancel: true,
      })
      expect(restored.initialBrowserIds).toEqual(["chrome", "edge"])
      expect(restored.defaultQueries).toEqual([])
      const dryRun = await choiceSession({ browserIds: [], dryRun: true })
      expect(dryRun.result).toMatchObject({ kind: "applied", report: { ok: true } })
      expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: ["chrome", "edge"] })
      await choiceSession({ browserIds: [] })
      const empty = await choiceSession({
        useInitial: true,
        defaultDesktop: "microsoft-edge.desktop",
        cancel: true,
      })
      expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: [] })
      expect(empty.initialBrowserIds).toEqual([])
      expect(empty.defaultQueries).toEqual([])
    },
  )

  test("an edit between selection review and Apply keeps the other writer's saved selection", async () => {
    await profiles()
    await json(selectionFile(), { browsers: ["chrome"] })
    const raced = await choiceSession({
      browserIds: [],
      beforeApply: () => json(selectionFile(), { browsers: ["chrome", "edge"] }),
    })
    expect(raced.result).toMatchObject({ kind: "applied", report: { ok: false } })
    expect(raced.calls).toEqual([])
    expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: ["chrome", "edge"] })
  })
})

test.skipIf(process.platform !== "linux")(
  "real Browse discovery offers both known and new Chromium engines and stores an unprofiled OS default",
  async () => {
    const bin = join(home, "bin")
    const vendor = join(home, "vendor")
    const apps = join(home, ".local", "share", "applications")
    for (const path of [bin, vendor, apps]) await mkdir(path, { recursive: true })
    for (const command of ["helium", "firefox"])
      await writeFile(join(bin, command), "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    const browser = join(vendor, "another chromium")
    await writeFile(browser, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    await writeFile(join(vendor, "resources.pak"), "fixture")
    await writeFile(join(vendor, "chrome-sandbox"), "fixture")
    await writeFile(
      join(apps, "aurora.desktop"),
      '[Desktop Entry]\nType=Application\nName=Aurora Browser\nCategories=WebBrowser;\nExec="' +
        browser +
        '" %U\n',
    )
    const first = await choiceSession({ useInitial: true, defaultDesktop: "aurora.desktop" })
    expect(first.offeredBrowserIds).toContain("helium")
    expect(first.offeredBrowserIds).toContain("desktop-aurora")
    expect(first.offeredBrowserIds).not.toContain("firefox")
    expect(first.initialBrowserIds).toEqual(["desktop-aurora"])
    expect(first.review?.join("\n")).toContain(
      "Aurora Browser: open the official Browse extension store",
    )
    expect(first.calls).toEqual([])
    expect(first.versions).toEqual([])
    expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: ["desktop-aurora"] })

    await choiceSession({ browserIds: ["helium", "desktop-aurora"] })
    const reopened = await choiceSession({
      useInitial: true,
      defaultDesktop: "firefox.desktop",
      cancel: true,
    })
    expect(reopened.initialBrowserIds).toEqual(["helium", "desktop-aurora"])
    expect(reopened.defaultQueries).toEqual([])
    expect(reopened.calls).toEqual([])
    expect(reopened.review?.join("\n")).toContain("Helium, Aurora Browser")
    await json(selectionFile(), { browsers: ["firefox", "helium"] })
    const hidden = await choiceSession({
      useInitial: true,
      defaultDesktop: "aurora.desktop",
      cancel: true,
    })
    expect(hidden.offeredBrowserIds).not.toContain("firefox")
    expect(hidden.initialBrowserIds).toEqual(["firefox", "helium"])
    expect(await Bun.file(selectionFile()).json()).toEqual({ browsers: ["firefox", "helium"] })
  },
)
