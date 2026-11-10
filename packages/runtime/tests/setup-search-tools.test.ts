import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect } from "effect"

import { doctor } from "../src/setup/doctor.ts"
import { INSTALL_COMMANDS } from "../src/setup/search-tools.ts"
import { setup } from "../src/setup/steps.ts"
import { fakeShell, scratch, writeCompleteSettings } from "./setup-fixture.ts"

let home: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-search-tools-")
  home = made.directory
  remove = made.remove
  await writeCompleteSettings(join(home, ".claude"))
})
afterEach(() => remove())

const runDoctor = (
  shell: ReturnType<typeof fakeShell>,
  env: Record<string, string> = {},
  fix = false,
) =>
  Effect.runPromise(
    doctor({ HOME: home, DISPLAY: ":0", ...env }, { fix, cwd: home }).pipe(
      Effect.provide(shell.layer),
    ),
  )

const runSetup = (
  shell: ReturnType<typeof fakeShell>,
  extra: { env?: Record<string, string>; undo?: boolean } = {},
) =>
  Effect.runPromise(
    setup(
      { HOME: home, ...extra.env },
      {
        scope: "user",
        cwd: home,
        subagentCacheTtl: "1h",
        dryRun: false,
        skipCtx7: true,
        undo: extra.undo ?? false,
      },
    ).pipe(Effect.provide(shell.layer)),
  )

/** The lines that name rg or fd, whatever their marker. */
const searchLines = (lines: ReadonlyArray<string>) =>
  lines.filter((line) => /^(?:ok {3}|= |~ |FAIL )(?:rg|fd): /.test(line))

/** Every platform and its install command appears in the line. */
const expectInstallCommands = (line: string | undefined) => {
  for (const [platform, ...commands] of INSTALL_COMMANDS) {
    expect(line).toContain(platform)
    for (const command of commands) expect(line).toContain(command)
  }
  expect(line).toContain("open a new terminal")
}

describe("holyagent doctor, rg and fd", () => {
  test("report each as ok with its path, and fd found as fdfind counts", async () => {
    const both = await runDoctor(fakeShell({ commands: ["bun", "ctx7", "rg", "fd"] }))
    expect(searchLines(both.lines)).toEqual(["ok   rg: /fake/bin/rg", "ok   fd: /fake/bin/fd"])
    const debian = await runDoctor(fakeShell({ commands: ["bun", "ctx7", "rg", "fdfind"] }))
    expect(searchLines(debian.lines)).toEqual([
      "ok   rg: /fake/bin/rg",
      "ok   fd: /fake/bin/fdfind",
    ])
    expect(both.ok && debian.ok).toBe(true)
  })

  test("a missing tool is a warning that names what stops and the install commands, not a failure", async () => {
    const shell = fakeShell({ commands: ["bun", "ctx7"] })
    const report = await runDoctor(shell)
    expect(report.ok).toBe(true)
    const [rg, fd] = searchLines(report.lines)
    expect(rg).toStartWith("~ rg: rg not found on PATH, so `holyagent rg`")
    expect(fd).toStartWith("~ fd: fd or fdfind not found on PATH, so `holyagent fd`")
    expectInstallCommands(rg)
    expectInstallCommands(fd)
    expect(
      report.lines.some((line) => line.startsWith("FAIL rg") || line.startsWith("FAIL fd")),
    ).toBe(false)
  })

  test("only the missing tool warns, and --fix installs neither", async () => {
    const shell = fakeShell({ commands: ["bun", "ctx7", "rg"] })
    const report = await runDoctor(shell, {}, true)
    expect(searchLines(report.lines).map((line) => line.slice(0, 8))).toEqual([
      "ok   rg:",
      "~ fd: fd",
    ])
    expect(shell.calls).toEqual([])
  })

  test("a Pi host reports them too, after the Pi lines, and a cloud session as well", async () => {
    const pi = await runDoctor(fakeShell({ commands: ["bun", "ctx7", "rg"] }), {
      HOLYAGENT_HOST: "pi",
    })
    expect(pi.lines.some((line) => line.startsWith("FAIL pi: not found on PATH"))).toBe(true)
    expect(searchLines(pi.lines).map((line) => line.slice(0, 8))).toEqual(["ok   rg:", "~ fd: fd"])
    expect(pi.lines.at(-1)).toStartWith("~ fd: ")
    const cloud = await runDoctor(fakeShell({ commands: ["bun"] }), {
      CLAUDE_CODE_REMOTE: "true",
    })
    expect(searchLines(cloud.lines)).toHaveLength(2)
  })
})

describe("holyagent setup, rg and fd", () => {
  test("report each as found with its path, before the settings lines", async () => {
    const report = await runSetup(fakeShell({ commands: ["bun", "rg", "fdfind"] }))
    expect(report.ok).toBe(true)
    expect(searchLines(report.lines)).toEqual([
      "= rg: found at /fake/bin/rg",
      "= fd: found at /fake/bin/fdfind",
    ])
    const settingsAt = report.lines.findIndex((line) => line.includes("settings.json"))
    expect(report.lines.indexOf("= rg: found at /fake/bin/rg")).toBeLessThan(settingsAt)
  })

  test("a missing tool is a hint with the install commands, runs nothing and keeps the report ok", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const report = await runSetup(shell)
    expect(report.ok).toBe(true)
    const [rg, fd] = searchLines(report.lines)
    expect(rg).toStartWith("~ rg: not installed, so `holyagent rg`")
    expect(fd).toStartWith("~ fd: not installed, so `holyagent fd`")
    expectInstallCommands(rg)
    expectInstallCommands(fd)
    expect(shell.calls).toEqual([])
  })

  test("a Pi host reports them as well, and --undo does not", async () => {
    const pi = await runSetup(fakeShell({ commands: ["bun", "rg", "fd"] }), {
      env: { HOLYAGENT_HOST: "pi" },
    })
    expect(searchLines(pi.lines)).toHaveLength(2)
    const undone = await runSetup(fakeShell({ commands: ["bun", "rg", "fd"] }), { undo: true })
    expect(searchLines(undone.lines)).toEqual([])
  })
})
