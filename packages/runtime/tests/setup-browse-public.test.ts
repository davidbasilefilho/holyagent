import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
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

const choiceSession = async (options: {
  readonly select: boolean
  readonly profile?: number
  readonly dryRun?: boolean
  readonly cancel?: boolean
  readonly noTui?: boolean
  readonly headless?: boolean
  readonly pairExit?: number
  readonly pairWrites?: boolean
  readonly combined?: boolean
}) => {
  const shell = fixtureShell()
  const calls: Array<string> = []
  let review: ReadonlyArray<string> | undefined
  let displayed = false
  let closed = false
  const pair: BrowsePair = (command, args, { cwd, env: childEnv }) =>
    Effect.gen(function* () {
      if (!closed) return yield* Effect.die("pairing started before terminal restored")
      if (options.pairWrites !== false) yield* Effect.promise(paired)
      calls.push([command, ...args].join(" "))
      expect(cwd).toBe(home)
      expect(childEnv["OPENCODE_BROWSER_AUTO_UPDATE"]).toBe("off")
      return options.pairExit ?? 0
    })
  const apply = () => Effect.succeed({ ok: true, lines: ["= Pi fixture configured"] })
  const drive: SetupTuiModule["runSetupTui"] = async (input: TuiInput) => {
    displayed = true
    const choices: Choices = {
      ...input.initial,
      piProviders: { providers: ["kimi-coding-global"] },
      browseSetup: options.select,
      ...(options.profile === undefined ? {} : { browseProfile: options.profile }),
    }
    review = (await input.review(choices)).browse
    if (options.cancel === true) return { _tag: "Cancelled" }
    const applied = await input.apply(choices, new AbortController().signal)
    expect(calls).toEqual([])
    closed = true
    return { _tag: "Applied", applied }
  }
  const result = await Effect.runPromise(
    runInteractive({
      env: env(),
      cwd: home,
      scope: "user",
      undo: false,
      dryRun: options.dryRun ?? false,
      terminal,
      noTui: options.noTui ?? false,
      choiceFlag: false,
      t3Workflow: true,
      form: options.headless === true ? chooseForm({}, "headless") : NORMAL,
      browse: { packageRoot: pkg(), pair },
      load: () => Effect.succeed({ runSetupTui: drive }),
      notify: () => Effect.void,
      apply,
      previewPi: apply,
      ...(options.combined === true ? { combined: { run: apply } } : {}),
    }).pipe(Effect.provide(shell.layer)),
  )
  return { result, calls, review, displayed, versions: shell.lines() }
}

describe("public setup's OpenCode Browse choice", () => {
  test.each([false, true])(
    "reviews selected browser/profile and uses official pair after renderer closes (combined %j)",
    async (combined) => {
      const chrome = await profiles()
      const run = await choiceSession({ select: true, combined })
      expect(run.review?.join("\n")).toContain(`${chrome}, Profile 1`)
      expect(run.review?.join("\n")).toContain(`${chrome}, Profile 2`)
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
      `add the official Browse extension in ${chrome}, Profile 2`,
    )
    expect(run.calls).toEqual([])
    expect(run.versions).toEqual([`bunx --package ${PIN} browse --version`])
    expect(await Bun.file(receipt()).exists()).toBe(false)
    expect(JSON.stringify(run.result)).toContain("pairing is not complete")
  })

  test("skipping, cancelling, dry-run, headless and unattended never invoke Browse", async () => {
    await profiles()
    const skip = await choiceSession({ select: false })
    expect(skip.review?.join("\n")).toContain("Skip Browser Use setup")
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
    expect(JSON.stringify(unverified.result)).toContain("no browser pairing was found")
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

  test("OpenTUI offers Skip by default and supports keyboard Configure and mouse profile choice", async () => {
    await profiles()
    const browse = await offer()
    open = await mount({
      width: 90,
      height: 30,
      t3: false,
      browse,
      capabilities: capabilityOffers(NORMAL).filter(({ feature }) => feature === "browserUse"),
    })
    const screen = open
    expect(screen.lines().find((line) => line.includes("OpenCode Browse setup"))).toContain(
      "[ ] Skip",
    )
    await screen.keys("down", "enter")
    expect(screen.lines().find((line) => line.includes("OpenCode Browse setup"))).toContain(
      "[x] Configure",
    )
    const y = screen.lines().findIndex((line) => line.includes("Browse browser profile"))
    expect(y).toBeGreaterThan(0)
    await screen.click(4, y)
    expect(screen.lines().join("\n")).toContain("Selected: Google Chrome, Profile 2")
    await screen.keys("end", "enter")
    expect(screen.reviews[0]).toMatchObject({ browseSetup: true, browseProfile: 1 })
  })
})
