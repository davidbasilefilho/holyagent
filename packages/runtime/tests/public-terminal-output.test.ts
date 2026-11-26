import { afterEach, beforeEach, expect, test } from "bun:test"
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"

import { decode } from "@toon-format/toon"

import { version } from "../../../package.json" with { type: "json" }
import { summarizeResult } from "../src/setup/tui/result.ts"
import { scratch } from "./setup-fixture.ts"

const scripts = join(import.meta.dir, "../../integrations/pi/dist/scripts")
const launcher = join(scripts, "holyagent-public-bin.js")
const node = Bun.which("node") ?? "node"
// oxlint-disable-next-line no-control-regex -- Match only the tested terminal style sequences.
const terminalCodes = /\x1b\[(?:[0-9]+;)*[0-9]+m/g
const posix = process.platform !== "win32"

let directory: string
let remove: () => Promise<void>
let env: Record<string, string | undefined>
beforeEach(async () => {
  const made = await scratch("holyagent-public-output-")
  directory = made.directory
  remove = made.remove
  env = {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    HOLYAGENT_HOME: directory,
    CLAUDE_CONFIG_DIR: join(directory, "claude"),
    T3CODE_HOME: join(directory, "t3"),
    HOLYAGENT_HOST: "claude",
    TERM: "xterm-256color",
    COLORFGBG: "15;0",
    LANG: "C.UTF-8",
    NO_COLOR: "",
    FORCE_COLOR: "1",
    CI: "",
  }
})
afterEach(() => remove())

type OnOutput = (output: string, io: Bun.Terminal) => void

const pty = async (cmd: ReadonlyArray<string>, onOutput?: OnOutput) => {
  let output = ""
  const decoder = new TextDecoder()
  await using terminal = new Bun.Terminal({
    cols: 110,
    rows: 36,
    data(io, bytes) {
      output += decoder.decode(bytes, { stream: true })
      onOutput?.(Bun.stripANSI(output), io)
    },
  })
  const child = Bun.spawn([...cmd], {
    cwd: directory,
    env,
    terminal,
    signal: AbortSignal.timeout(10_000),
  })
  const code = await child.exited
  await Bun.sleep(25)
  return { code, output: (output + decoder.decode()).replaceAll("\r\n", "\n") }
}

const piped = async (cmd: ReadonlyArray<string>) => {
  const child = Bun.spawn([...cmd], {
    cwd: directory,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(10_000),
  })
  // Keep stdin open while the command runs: the public scripted path must never read it.
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test.skipIf(!posix)(
  "the public entry appends styled help, version and errors without terminal control",
  async () => {
    for (const [args, code, expected] of [
      [["--help"], 0, "Manage your HolyAgent installation."],
      [["--version"], 0, version],
      [["bad-command"], 2, "Error: Unknown command bad-command"],
    ] as const) {
      const result = await pty([node, launcher, ...args])
      expect(result.code).toBe(code)
      expect(result.output).toContain(expected)
      expect(result.output).toMatch(terminalCodes)
      expect(result.output.replace(terminalCodes, "")).not.toContain("\x1b")
    }
  },
  15_000,
)

test.skipIf(!posix)(
  "the public entry leaves redirected stderr unstyled and preserves its channel",
  async () => {
    const stderr = join(directory, "stderr")
    env["HOLYAGENT_TEST_STDERR"] = stderr
    const shown = await pty([
      "/bin/sh",
      "-c",
      'exec "$@" 2>"$HOLYAGENT_TEST_STDERR"',
      "fixture",
      node,
      launcher,
      "bad-command",
    ])
    expect(shown).toEqual({ code: 2, output: "" })
    const error = await Bun.file(stderr).text()
    expect(error).toStartWith("Error: Unknown command bad-command")
    expect(error).not.toContain("\x1b")
  },
  15_000,
)

test("with stdin open and pipes, public and agent output keep their plain contracts", async () => {
  const publicHelp = await piped([node, launcher, "--help"])
  expect(publicHelp.code).toBe(0)
  expect(publicHelp.stdout).toStartWith("Manage your HolyAgent installation.")
  expect(publicHelp.stdout).not.toContain("\x1b")
  expect(publicHelp.stderr).toBe("")
  const agent = await piped([node, join(scripts, "holyagent-cli-bin.js"), "-v"])
  expect(agent).toEqual({ code: 0, stdout: `version: ${version}\n`, stderr: "" })
}, 15_000)

test.skipIf(!posix)(
  "a public update child cannot inject ANSI into redirected diagnostics",
  async () => {
    const bin = join(directory, "bin")
    await mkdir(bin)
    await writeFile(
      join(bin, "npm"),
      "#!/bin/sh\nprintf '\\033[31mchild error\\033[0m\\n' >&2\nexit 1\n",
      { mode: 0o700 },
    )
    await writeFile(join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o700 })
    env["PATH"] = [bin, env["PATH"]].join(delimiter)
    const command = [node, launcher, "update", "--dry-run"]
    const redirected = await piped(command)
    expect(redirected.code).toBe(1)
    expect(redirected.stdout).toBe("")
    expect(redirected.stderr).toContain("child error")
    expect(redirected.stderr).not.toContain("\x1b")

    const interactive = await pty(command)
    expect(interactive.code).toBe(1)
    expect(interactive.output.replace(terminalCodes, "")).toBe(redirected.stderr)
  },
  15_000,
)

test.skipIf(!posix || !Bun.which("rg") || !(Bun.which("fd") || Bun.which("fdfind")))(
  "structured search results retain the agent and private host contracts in a terminal",
  async () => {
    await Bun.write(join(directory, "fixture.txt"), "fixture match\n")
    const agent = join(scripts, "holyagent-cli-bin.js")
    const rg = await pty([node, agent, "rg", "--json", "fixture match", "fixture.txt"])
    expect(rg.code).toBe(0)
    expect(rg.output).not.toContain("\x1b")
    expect(decode(rg.output)).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining('"type":"match"'),
      stderr: "",
    })

    const args = ["fd", "--print0", "--type", "f", "fixture.txt", "."]
    const fd = await pty([node, agent, ...args])
    expect(fd.code).toBe(0)
    expect(fd.output).not.toContain("\x1b")
    expect(decode(fd.output)).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("fixture.txt\0"),
      stderr: "",
    })

    const host = await pty([process.execPath, join(scripts, "holyagent.js"), ...args])
    expect(host.code).toBe(0)
    expect(host.output).toContain("fixture.txt\\u0000")
    expect(host.output).not.toContain("\x1b")
  },
  15_000,
)

test.skipIf(!posix)(
  "headless flags skip the renderer bundle even in a real terminal",
  async () => {
    for (const name of [
      "holyagent-public-bin.js",
      "holyagent-public.js",
      "launcher.js",
      "empty-bunfig.toml",
    ])
      await copyFile(join(scripts, name), join(directory, name))
    const preload = join(directory, "node_modules", "@opentui", "solid")
    await mkdir(preload, { recursive: true })
    await Bun.write(
      join(preload, "package.json"),
      JSON.stringify({
        type: "module",
        exports: { "./preload": "./preload.js" },
      }),
    )
    await Bun.write(
      join(preload, "preload.js"),
      'import { writeFileSync } from "node:fs"; writeFileSync("loaded", "yes");',
    )
    await Bun.write(
      join(directory, "setup-tui.js"),
      'export function runSetupTui() { throw new Error("unexpected interactive setup"); } export function renderTerminalOutput() { return "PROBE"; }',
    )
    const copied = join(directory, "holyagent-public-bin.js")
    const spy = Bun.file(join(directory, "loaded"))
    for (const alias of ["--no-tui", "--non-interactive"]) {
      const args = ["setup", "--dry-run", "--skip-ctx7", alias]
      const interactive = await pty([node, copied, ...args])
      const noninteractive = await piped([node, copied, ...args])
      expect(interactive).toEqual({
        code: noninteractive.code,
        output: noninteractive.stdout + noninteractive.stderr,
      })
      expect(interactive.output).toContain("scope:")
      expect(interactive.output).not.toContain("\x1b")
      expect(await spy.exists()).toBe(false)
    }
    expect((await piped([node, copied, "--help"])).stdout).toStartWith("Manage your HolyAgent")
    expect(await spy.exists()).toBe(false)
    expect(await pty([node, copied, "--help"])).toEqual({ code: 0, output: "PROBE" })
    expect(await spy.exists()).toBe(true)
  },
  15_000,
)

test.skipIf(!posix)(
  "one q closes setup and leaves a colored copyable report link in scrollback",
  async () => {
    const steps = [
      ["change harness", "\x1b[C"],
      ["Configure Claude Code", "\r\x1b[F\r"],
      ["❯ Apply", "\r"],
      ["Close (Enter or q)", "q"],
    ] as const
    let stage = 0
    let offset = 0
    const result = await pty(
      [node, launcher, "setup", "--scope", "user", "--skip-ctx7"],
      (out, io) => {
        const step = steps[stage]
        if (step === undefined || !out.slice(offset).includes(step[0])) return
        stage += 1
        offset = out.length
        io.write(step[1])
      },
    )
    expect(stage).toBe(steps.length)
    expect(result.code).toBe(0)
    const close = result.output.lastIndexOf("\x1b[?1049l")
    expect(close).toBeGreaterThan(0)
    const inline = result.output.slice(close)
    expect(inline).not.toContain("\x1b[?1049h")
    expect(inline).toContain("\x1b[38;2;115;218;202mSetup finished.")
    expect(inline).toContain("\x1b]8;;file://")
    const reportPath = /Full report: ([^\n]+)/.exec(Bun.stripANSI(inline))?.[1]
    expect(reportPath).toBeDefined()
    expect(await Bun.file(reportPath ?? "").text()).toContain("Setup finished.")
    expect(await readdir(dirname(dirname(reportPath ?? "")))).toHaveLength(1)
  },
  15_000,
)

test("typical Pi and Codex outcomes keep configuration and next actions out of warnings", () => {
  const pi = summarizeResult(
    {
      ok: true,
      lines: [
        "~ form: headless",
        "+ Pi model providers: enabled openai-codex (config.json)",
        "= pi package: installed HolyAgent already listed in settings.json",
        '+ pi package: replace "old" with "current" in settings.json',
        "~ OpenCode Browse: close this screen to finish pairing",
        "~ Pi device: profile conflicts with the existing access",
      ],
    },
    false,
  )
  expect(pi).toContainEqual({ title: "Changes", lines: ["Pi model providers", "pi package"] })
  expect(pi).toContainEqual({ title: "Warnings", lines: ["Pi device"] })
  expect(pi).toContainEqual({
    title: "Next steps",
    lines: [
      "OpenCode Browse: close this screen to finish pairing",
      "Check the warnings in the full report.",
    ],
  })

  const start =
    "Start Codex with this CODEX_HOME set before launch; setup does not change a running session."
  const codex = summarizeResult(
    {
      ok: false,
      lines: [
        "~ Codex home: /path/to/profile",
        "~ Startup: direct-only",
        "+ Codex plugin: register the local marketplace",
        `= Codex plugin: ${version} already present in the local cache`,
        `~ ${start}`,
        "! Codex asset: could not be installed",
      ],
    },
    true,
  )
  expect(codex).toContainEqual({ title: "Planned changes", lines: ["Codex plugin"] })
  expect(codex).toContainEqual({ title: "Failures", lines: ["Codex asset"] })
  expect(codex).toContainEqual({
    title: "Next steps",
    lines: [start, "Check the failures in the full report before running setup again."],
  })
  expect(codex.some(({ title }) => title === "Warnings")).toBe(false)
})
