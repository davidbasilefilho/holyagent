import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { piPackages } from "../src/config/packages.ts"
import { defaultConfig } from "../src/config/schema.ts"
import { programName, scratch, writeCompleteSettings } from "./setup-fixture.ts"

let home: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-setup-cli-")
  home = made.directory
  remove = made.remove
})
afterEach(() => remove())

/** Runs one command line in-process; the config folder is a temp folder, never the real one. */
const cli = (argv: ReadonlyArray<string>, extra: Record<string, string> = {}) =>
  Effect.runPromise(
    run(argv, {
      cwd: home,
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        PATH: dirname(process.execPath),
        ...extra,
      },
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
    }),
  )

const settings = () => join(home, "claude", "settings.json")

const publicEnv = () => ({
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, "config"),
  CLAUDE_CONFIG_DIR: join(home, "claude"),
  PI_CODING_AGENT_DIR: join(home, "pi"),
  T3CODE_HOME: join(home, "t3"),
  PATH: join(home, "bin"),
  TERM: "xterm",
})

const publicCli = (argv: ReadonlyArray<string>) =>
  Effect.runPromise(
    run(
      argv,
      {
        cwd: home,
        env: publicEnv(),
        terminal: { stdin: true, stdout: true },
        stdin: Effect.die("non-interactive setup must not read stdin"),
        setupTui: () => Effect.die("this setup must not open the TUI"),
      },
      "public",
    ),
  )

describe("public setup harnesses", () => {
  test("a Pi preview with no backend or initialized T3 names each next step without activating another host", async () => {
    const result = await publicCli(["setup", "pi", "--dry-run", "--non-interactive"])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("open T3 Code once")
    expect(result.stdout).toContain("then run holyagent setup pi")
    expect(result.stdout).toContain("install the Pi backend from https://pi.dev")
    expect(result.stdout).toContain("see holyagent setup codex --help")
    expect(result.stdout).toContain("activates the current session")
    expect(await Bun.file(join(home, "t3", "userdata", "settings.json")).exists()).toBe(false)
    expect(await Bun.file(join(home, ".holyagent", "codex", "config.toml")).exists()).toBe(false)
    expect(await Bun.file(settings()).exists()).toBe(false)
  })

  test("install is shown inline once and uses setup's exact help and validation", async () => {
    const help = await publicCli(["--help"])
    const setup = help.stdout.split("\n").filter((line) => line.startsWith("setup "))
    expect(setup).toHaveLength(1)
    expect(setup[0]).toContain("(alias: install)")
    expect(help.stdout).not.toMatch(/^install /m)
    for (const args of [
      ["--help"],
      ["pi", "-h"],
      ["claude", "--help"],
      ["claude", "--form", "normal"],
    ]) {
      expect(await publicCli(["install", ...args])).toEqual(await publicCli(["setup", ...args]))
    }
    expect((await publicCli(["setup", "claude", "--form", "normal"])).code).toBe(2)
    expect((await publicCli(["setup", "pi", "--subagent-cache-ttl", "5m"])).code).toBe(2)
    expect((await publicCli(["setup", "codex", "--help"])).code).toBe(0)
    for (const command of ["doctor", "update"]) {
      expect((await publicCli([command, "claude"])).code).toBe(2)
    }
  })

  test("Pi and Claude setup and undo only touch their own settings even with Pi on PATH", async () => {
    const bin = join(home, "bin")
    await mkdir(bin)
    await writeFile(join(bin, programName("pi")), "", { mode: 0o755 })
    const config = await Effect.runPromise(defaultConfig)
    await Bun.write(
      join(home, ".holyagent", "config.json"),
      JSON.stringify({ pi: { providers: ["kimi-coding-global"] } }),
    )
    const pi = join(home, "pi", "settings.json")
    const t3 = join(home, "t3", "userdata", "settings.json")
    await Bun.write(pi, JSON.stringify({ packages: piPackages(config, undefined, "headless") }))
    await mkdir(join(home, "t3"), { recursive: true })
    const piResult = await publicCli([
      "setup",
      "pi",
      "--form",
      "headless",
      "--non-interactive",
      "--skip-ctx7",
    ])
    expect(piResult.code).toBe(0)
    expect(await Bun.file(t3).exists()).toBe(true)
    expect(await Bun.file(settings()).exists()).toBe(false)
    const before = await Promise.all([Bun.file(pi).text(), Bun.file(t3).text()])

    const ownClaude = { includeGitInstructions: true, unrelatedSetting: "keep" }
    await Bun.write(settings(), JSON.stringify(ownClaude))
    const result = await publicCli([
      "install",
      "claude",
      "--skip-ctx7",
      "--subagent-cache-ttl",
      "5m",
    ])
    expect(result.code).toBe(0)
    expect(result.stdout).not.toMatch(/pi packages|tool settings|t3 settings/)
    expect(await Bun.file(settings()).json()).toMatchObject({
      ...ownClaude,
      subagentPromptCacheTtl: "5m",
    })
    expect(await Promise.all([Bun.file(pi).text(), Bun.file(t3).text()])).toEqual(before)

    expect((await publicCli(["setup", "claude", "--undo", "--non-interactive"])).code).toBe(0)
    expect(await Bun.file(settings()).json()).toEqual(ownClaude)
    expect(await Promise.all([Bun.file(pi).text(), Bun.file(t3).text()])).toEqual(before)

    const piUndo = await publicCli(["setup", "pi", "--undo"])
    expect(piUndo.code).toBe(0)
    expect(piUndo.stdout).toContain("t3 settings")
    expect(await Bun.file(settings()).json()).toEqual(ownClaude)
  })

  test("explicit Claude dry-run and non-interactive Pi undo exit with stdin held open", async () => {
    const entry = join(import.meta.dir, "../../integrations/pi/dist/scripts/holyagent-public.js")
    for (const [args, report] of [
      [
        ["setup", "claude", "--scope", "user", "--dry-run", "--non-interactive", "--skip-ctx7"],
        "nothing written",
      ],
      [["install", "pi", "--undo", "--dry-run", "--non-interactive"], "--undo only removes"],
    ] as const) {
      const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", entry, ...args], {
        cwd: home,
        env: publicEnv(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      })
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        expect(code, `${args.join(" ")}\n${stdout}\n${stderr}`).toBe(0)
        expect(stdout).toContain(report)
        expect(stderr).toBe("")
      } finally {
        await child.stdin.end()
      }
    }
  }, 25_000)
})

describe("holyagent setup and doctor as commands", () => {
  test("setup --dry-run prints the report, exits 0 and writes nothing", async () => {
    const result = await cli(["setup", "--dry-run", "--skip-ctx7"])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("+ includeGitInstructions: added false\n")
    expect(result.stdout).toEndWith("dry run: would add 10, nothing written\n")
    expect(await Bun.file(settings()).exists()).toBe(false)
  })

  test("setup merges the user settings of CLAUDE_CONFIG_DIR, and a second run prints no + line", async () => {
    const flags = ["setup", "--skip-ctx7", "--subagent-cache-ttl", "5m"]
    const first = await cli(flags)
    expect(first.code).toBe(0)
    expect(first.stdout).toEndWith("added 10\n")
    const written = (await Bun.file(settings()).json()) as { subagentPromptCacheTtl?: string }
    expect(written.subagentPromptCacheTtl).toBe("5m")
    const second = await cli(flags)
    expect(second.code).toBe(0)
    // Whether rg and fd are installed depends on the machine, so their lines are left out.
    const changes = second.stdout
      .split("\n")
      .filter((line) => /^[+!~-] /.test(line) && !/^~ (?:rg|fd): /.test(line))
    expect(changes).toEqual(["~ scope: user (default)", "- ctx7: skipped by flag"])
    expect(second.stdout).toEndWith("no changes\n")
  })

  test("setup exits 1 when a step failed, here a settings file that is not an object", async () => {
    await Bun.write(settings(), "[1]")
    const result = await cli(["setup", "--skip-ctx7"])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("! user settings: ")
    expect(await Bun.file(settings()).text()).toBe("[1]")
  })

  test("setup in a cloud session skips ctx7 and still merges the settings", async () => {
    const result = await cli(["setup"], { CLAUDE_CODE_REMOTE: "true" })
    expect(result.code).toBe(0)
    expect(result.stdout.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(1)
    expect(await Bun.file(settings()).exists()).toBe(true)
  })

  test("setup refuses a cache lifetime Claude Code does not accept", async () => {
    const result = await cli(["setup", "--subagent-cache-ttl", "2h"])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain("subagent-cache-ttl")
    expect(await Bun.file(settings()).exists()).toBe(false)
  })

  test("setup has no --dir: settings are user-wide", async () => {
    const result = await cli(["setup", "--dir", home])
    expect(result.code).not.toBe(0)
  })

  test("doctor exits 1 on a failing line and 0 when all pass; --fix in a cloud session merges the settings", async () => {
    const failing = await cli(["doctor"], { CLAUDE_CODE_REMOTE: "true" })
    expect(failing.code).toBe(1)
    expect(failing.stdout).toContain("FAIL settings: ")
    expect(failing.stdout).toContain("ok   ctx7: not installed in a claude.ai cloud session")

    const fixed = await cli(["doctor", "--fix"], { CLAUDE_CODE_REMOTE: "true" })
    expect(fixed.code).toBe(0)
    expect(fixed.stdout).toContain("ok   settings: ")

    await writeCompleteSettings(join(home, "claude"))
    expect((await cli(["doctor"], { CLAUDE_CODE_REMOTE: "true" })).code).toBe(0)
  })

  test("doctor takes --fix and nothing else", async () => {
    expect((await cli(["doctor", "--dry-run"])).code).not.toBe(0)
  })
})
