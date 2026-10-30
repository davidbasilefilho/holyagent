import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import { scratch, writeCompleteSettings } from "./setup-fixture.ts"

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

describe("holyagent setup and doctor as commands", () => {
  test("setup --dry-run prints the report, exits 0 and writes nothing", async () => {
    const result = await cli(["setup", "--dry-run", "--skip-ctx7"])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("= billion-context: no leftovers\n")
    expect(result.stdout).toContain("+ includeGitInstructions: added false\n")
    expect(result.stdout).toEndWith("dry run: would add 8, nothing written\n")
    expect(await Bun.file(settings()).exists()).toBe(false)
  })

  test("setup merges the user settings of CLAUDE_CONFIG_DIR, and a second run prints no + line", async () => {
    const flags = ["setup", "--skip-ctx7", "--subagent-cache-ttl", "5m"]
    const first = await cli(flags)
    expect(first.code).toBe(0)
    expect(first.stdout).toEndWith("added 8\n")
    const written = (await Bun.file(settings()).json()) as { subagentPromptCacheTtl?: string }
    expect(written.subagentPromptCacheTtl).toBe("5m")
    const second = await cli(flags)
    expect(second.code).toBe(0)
    expect(second.stdout.split("\n").filter((line) => /^[+!~-] /.test(line))).toEqual([
      "- ctx7: skipped by flag",
    ])
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

  test("setup has no --skip-billion-context: Billion Context is no longer installed", async () => {
    const result = await cli(["setup", "--skip-billion-context"])
    expect(result.code).not.toBe(0)
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
