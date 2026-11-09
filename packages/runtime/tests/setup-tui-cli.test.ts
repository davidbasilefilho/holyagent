import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import type { SetupTuiLoader } from "../src/cli/types.ts"
import { TuiUnavailable } from "../src/setup/tui/load.ts"
import type { Choices, Review, SetupTuiModule, TuiInput } from "../src/setup/tui/types.ts"
import { scratch } from "./setup-fixture.ts"

let home: string
let t3Home: string
let androidSdk: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-setup-tui-cli-")
  home = join(made.directory, "home")
  t3Home = join(made.directory, "t3")
  androidSdk = join(made.directory, "sdk")
  await mkdir(home, { recursive: true })
  remove = made.remove
})
afterEach(() => remove())

const TERMINAL = { stdin: true, stdout: true }

/** A machine with T3 Code, and an Android SDK unless `sdk` is false. */
const machine = async (options: { sdk?: boolean; t3?: boolean } = {}) => {
  if (options.t3 !== false) await mkdir(t3Home, { recursive: true })
  if (options.sdk !== false) await mkdir(androidSdk, { recursive: true })
}

const environment = (extra: Record<string, string> = {}) => ({
  HOME: home,
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  PATH: dirname(process.execPath),
  HOLYAGENT_HOST: "pi",
  T3CODE_HOME: t3Home,
  ANDROID_HOME: androidSdk,
  ...extra,
})

const cli = (
  argv: ReadonlyArray<string>,
  options: {
    env?: Record<string, string>
    terminal?: { stdin: boolean; stdout: boolean }
    setupTui?: SetupTuiLoader
  } = {},
) =>
  Effect.runPromise(
    run(["setup", "--skip-ctx7", ...argv], {
      cwd: home,
      env: environment(options.env),
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
      ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      ...(options.setupTui === undefined ? {} : { setupTui: options.setupTui }),
    }),
  )

const t3File = () => join(t3Home, "userdata", "settings.json")
const t3Settings = async (): Promise<Record<string, unknown>> => {
  const file = Bun.file(t3File())
  return (await file.exists()) ? ((await file.json()) as Record<string, unknown>) : {}
}
const t3Line = (stdout: string) => stdout.split("\n").find((line) => line.includes("t3 settings"))
const tuiLine = (stdout: string) => stdout.split("\n").find((line) => line.startsWith("~ t3 tui:"))

/** A loader whose interface the test drives: it receives the input and answers an outcome. */
const interface_ = (
  drive: (input: TuiInput) => Promise<unknown>,
): { loader: SetupTuiLoader; loaded: () => number } => {
  let loaded = 0
  return {
    loaded: () => loaded,
    loader: () => {
      loaded += 1
      return Effect.succeed({ runSetupTui: drive } as unknown as SetupTuiModule)
    },
  }
}

describe("setup flags for the T3 choices", () => {
  test("--worktrees off leaves new threads local and keeps device access on, without the interface", async () => {
    await machine()
    const shown = interface_(() => Promise.reject(new Error("must not run")))
    const result = await cli(["--worktrees", "off"], { terminal: TERMINAL, setupTui: shown.loader })
    expect(shown.loaded()).toBe(0)
    const written = await t3Settings()
    expect(written["defaultThreadEnvMode"]).toBeUndefined()
    expect(written["enableDeviceSupport"]).toBe(true)
    expect(written["enableAgentDeviceAccess"]).toBe(true)
    expect(tuiLine(result.stdout)).toBe(
      "~ t3 tui: a choice flag was passed, so it applies directly; using the line-based setup",
    )
  })

  test("--device-access off keeps worktrees on", async () => {
    await machine()
    await cli(["--device-access", "off"])
    const written = await t3Settings()
    expect(written["defaultThreadEnvMode"]).toBe("worktree")
    expect(written["enableDeviceSupport"]).toBeUndefined()
    expect(written["enableAgentDeviceAccess"]).toBeUndefined()
  })

  test("on makes the choice explicitly and both flags together apply both", async () => {
    await machine()
    await cli(["--worktrees", "on", "--device-access", "on"])
    expect(await t3Settings()).toMatchObject({
      defaultThreadEnvMode: "worktree",
      enableDeviceSupport: true,
    })
  })

  test("--no-tui applies both choices on in a terminal, with a note saying why", async () => {
    await machine()
    const shown = interface_(() => Promise.reject(new Error("must not run")))
    const result = await cli(["--no-tui"], { terminal: TERMINAL, setupTui: shown.loader })
    expect(shown.loaded()).toBe(0)
    expect(await t3Settings()).toMatchObject({
      defaultThreadEnvMode: "worktree",
      enableDeviceSupport: true,
    })
    expect(tuiLine(result.stdout)).toBe("~ t3 tui: --no-tui was passed; using the line-based setup")
  })

  test("a value other than on or off is refused with the usage", async () => {
    const result = await cli(["--worktrees", "maybe"])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("Invalid value for --worktrees: maybe")
    expect(result.stderr).toContain("[--worktrees on|off] [--device-access on|off] [--no-tui]")
  })

  test("the setup help documents the flags, the screen and its fallbacks", async () => {
    const result = await cli(["--help"])
    const text = result.stdout
    expect(text).toContain("[--worktrees on|off] [--device-access on|off] [--no-tui]")
    expect(text).toContain("--worktrees on|off and --device-access on|off make a choice")
    expect(text).toContain("--no-tui keeps the screen out")
    expect(text).toContain("XDG_CACHE_HOME, else ~/.cache; LOCALAPPDATA on Windows")
    expect(text).toContain("Esc or Ctrl-C cancels and writes nothing")
  })
})

describe("setup without the interface", () => {
  test.each([
    ["no terminal", undefined, {}, "stdin or stdout is not a terminal"],
    ["stdout piped", { stdin: true, stdout: false }, {}, "stdin or stdout is not a terminal"],
    ["CI", TERMINAL, { CI: "true" }, "CI is set"],
    ["a dumb terminal", TERMINAL, { TERM: "dumb" }, "TERM is dumb"],
  ])(
    "%s falls back with one line saying why and applies the defaults",
    async (_, terminal, env, why) => {
      await machine()
      const shown = interface_(() => Promise.reject(new Error("must not run")))
      const result = await cli([], {
        env,
        ...(terminal === undefined ? {} : { terminal }),
        setupTui: shown.loader,
      })
      expect(shown.loaded()).toBe(0)
      expect(result.stdout.split("\n").filter((line) => line.startsWith("~ t3 tui:"))).toEqual([
        `~ t3 tui: ${why}; using the line-based setup`,
      ])
      expect(await t3Settings()).toMatchObject({ defaultThreadEnvMode: "worktree" })
    },
  )

  test("says nothing about the interface where the T3 part has no work", async () => {
    await machine({ t3: false })
    const shown = interface_(() => Promise.reject(new Error("must not run")))
    const result = await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(shown.loaded()).toBe(0)
    expect(result.stdout).not.toContain("t3 tui")
    const undone = await cli(["--undo"], { terminal: TERMINAL, setupTui: shown.loader })
    expect(undone.stdout).not.toContain("t3 tui")
  })
})

describe("setup with the interface", () => {
  test("offers the rows the machine allows, then reviews and applies what the person chose", async () => {
    await machine()
    let seen: TuiInput | undefined
    let review: Review | undefined
    const shown = interface_(async (input) => {
      seen = input
      const choices: Choices = { worktrees: false, deviceAccess: true }
      review = await input.review(choices)
      const applied = await input.apply(choices, new AbortController().signal)
      return { _tag: "Applied", applied }
    })
    const result = await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(seen?.offer).toEqual({ device: `the Android SDK (${androidSdk})`, worktrees: true })
    expect(seen?.initial).toEqual({ worktrees: true, deviceAccess: true })
    expect(seen?.dryRun).toBe(false)
    expect(review?.file).toBe(t3File())
    expect(review?.choices.map((line) => [line.mark, line.name])).toEqual([
      ["+", "Pi provider"],
      ["+", "Agent device access"],
      ["-", "New threads in worktrees"],
    ])
    expect(review?.always.map((line) => line.name)).toEqual([
      "Background activity",
      "Source control writing",
      "Threads and git",
      "Branch naming",
      "Storage cleanup",
    ])
    expect(review?.always.every((line) => line.mark === "+")).toBe(true)
    // The review wrote nothing; the apply wrote what was chosen.
    const written = await t3Settings()
    expect(written["defaultThreadEnvMode"]).toBeUndefined()
    expect(written["enableDeviceSupport"]).toBe(true)
    expect(t3Line(result.stdout)).toContain("added")
    expect(result.stdout).not.toContain("t3 tui")
    expect(result.stdout.startsWith("~ scope: user (default)\n")).toBe(true)
  })

  test("offers no device row on a machine without Xcode or an Android SDK", async () => {
    await machine({ sdk: false })
    let seen: TuiInput | undefined
    const shown = interface_((input) => {
      seen = input
      return Promise.resolve({ _tag: "Cancelled" })
    })
    await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(seen?.offer.device).toBeUndefined()
  })

  test("cancelling writes nothing, says so and exits 1", async () => {
    await machine()
    const shown = interface_(() => Promise.resolve({ _tag: "Cancelled" }))
    const result = await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(result.stdout).toBe("~ setup cancelled; nothing was written\n")
    expect(result.code).toBe(1)
    expect(await Bun.file(t3File()).exists()).toBe(false)
    expect(await Bun.file(join(home, "claude", "settings.json")).exists()).toBe(false)
  })

  test("an interrupted apply is reported as a failure that names the way on", async () => {
    await machine()
    const shown = interface_(() => Promise.resolve({ _tag: "Interrupted" }))
    const result = await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(result.stdout).toBe(
      "! setup was interrupted while applying; run holyagent setup again to finish\n",
    )
    expect(result.code).toBe(1)
  })

  test("a failed apply exits 1 and prints the report the person saw", async () => {
    await machine()
    await Bun.write(t3File(), "[1]")
    const shown = interface_(async (input) => ({
      _tag: "Applied",
      applied: await input.apply(
        { worktrees: true, deviceAccess: true },
        new AbortController().signal,
      ),
    }))
    const result = await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(t3Line(result.stdout)).toStartWith("! t3 settings:")
    expect(result.code).toBe(1)
    expect(await Bun.file(t3File()).text()).toBe("[1]")
  })

  test("a dry run goes through the interface and writes nothing", async () => {
    await machine()
    let dry: boolean | undefined
    const shown = interface_(async (input) => {
      dry = input.dryRun
      return {
        _tag: "Applied",
        applied: await input.apply(
          { worktrees: true, deviceAccess: true },
          new AbortController().signal,
        ),
      }
    })
    const result = await cli(["--dry-run"], { terminal: TERMINAL, setupTui: shown.loader })
    expect(dry).toBe(true)
    expect(t3Line(result.stdout)).toContain("would add")
    expect(await Bun.file(t3File()).exists()).toBe(false)
  })

  test("uses the line-based setup, with the reason, when the interface cannot be installed or imported", async () => {
    await machine()
    const result = await cli([], {
      terminal: TERMINAL,
      setupTui: () =>
        Effect.fail(
          new TuiUnavailable({
            reason: "bun install failed (exit 1): ENOTFOUND registry.npmjs.org",
          }),
        ),
    })
    expect(tuiLine(result.stdout)).toBe(
      "~ t3 tui: unavailable (bun install failed (exit 1): ENOTFOUND registry.npmjs.org); using the line-based setup",
    )
    expect(await t3Settings()).toMatchObject({ defaultThreadEnvMode: "worktree" })
  })

  test("uses the line-based setup when the screen fails to start", async () => {
    await machine()
    const shown = interface_(() => Promise.reject(new Error("no native library for linux-riscv64")))
    const result = await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(tuiLine(result.stdout)).toBe(
      "~ t3 tui: failed to start (no native library for linux-riscv64); using the line-based setup",
    )
    expect(await t3Settings()).toMatchObject({ defaultThreadEnvMode: "worktree" })
  })

  test("uses the line-based setup when the interface answers in a shape the command does not know", async () => {
    await machine()
    const shown = interface_(() => Promise.resolve({ _tag: "Applied", applied: { ok: true } }))
    const result = await cli([], { terminal: TERMINAL, setupTui: shown.loader })
    expect(tuiLine(result.stdout)).toContain("~ t3 tui: failed to start (")
    expect(await t3Settings()).toMatchObject({ defaultThreadEnvMode: "worktree" })
    const extra = interface_(() => Promise.resolve({ _tag: "Cancelled", surprise: 1 }))
    const second = await cli([], { terminal: TERMINAL, setupTui: extra.loader })
    expect(tuiLine(second.stdout)).toContain("~ t3 tui: failed to start (")
  })
})
