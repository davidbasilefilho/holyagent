import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { encodeRecord, renderRecord, run } from "../src/cli/program.ts"
import { WithTrailer } from "../src/cli/types.ts"

test("TOON escapes terminal controls without changing nested records, keys or tables", () => {
  const record = {
    "key\u009b": "literal \\u009b and \u009b and \u001b",
    rows: [
      { "field\u007f": "\u009b", nested: { value: "\\u009b" } },
      { "field\u007f": "\\u009b", nested: { value: "x\u009by" } },
    ],
    "key\\u009b": "distinct",
  }
  const encoded = encodeRecord(record)
  for (const character of encoded) {
    const code = character.charCodeAt(0)
    expect((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)).toBe(false)
  }
  expect(decode(encoded)).toEqual(record)
  const trailer = renderRecord(new WithTrailer(record, "prompt", "line\u009b\nnext"))
  const [fields, text] = trailer.split("\nprompt:\n")
  expect(fields).toBeDefined()
  expect(decode(fields ?? "")).toEqual(record)
  expect(text).toBe("line\\u009b\nnext\n")
  expect(trailer).not.toMatch(/[\u007f-\u009f]/)
})

test("the public entry keeps the private Pi config protocol and agent commands out of its surface", async () => {
  root = await fixture("holyagent-pi-entries-")
  const env = { ...process.env, HOME: root, HOLYAGENT_HOST: "pi" }
  const launch = (entry: string, ...argv: string[]) =>
    Bun.spawnSync([process.execPath, join(import.meta.dir, "../src/hooks", entry), ...argv], {
      cwd: root,
      env,
      stdin: "ignore",
    })
  const hostConfig = launch("pi-entry.ts", "config", join(root, ".holyagent"))
  expect(hostConfig.exitCode).toBe(0)
  expect(JSON.parse(hostConfig.stdout.toString())).toBeObject()

  const help = launch("pi-public-entry.ts", "--help")
  expect(help.exitCode).toBe(0)
  expect(help.stdout.toString()).toContain("Manage your HolyAgent installation for T3 Code")
  expect(help.stdout.toString()).toContain("update")
  expect(help.stdout.toString()).not.toContain("assignment dispatch")
  const setupHelp = launch("pi-public-entry.ts", "setup", "-h")
  expect(setupHelp.stdout.toString()).toContain("interactive screen")
  expect(setupHelp.stdout.toString()).not.toContain("internal Claude")
  const publicVersion = launch("pi-public-entry.ts", "-v")
  expect(publicVersion.exitCode).toBe(0)
  expect(publicVersion.stdout.toString()).toMatch(/^\d+\.\d+\.\d+\n$/)
  for (const argv of [["config"], ["intent", "create"]]) {
    const refused = launch("pi-public-entry.ts", ...argv)
    expect(refused.exitCode).toBe(2)
    expect(refused.stdout.toString()).toBe("")
    expect(refused.stderr.toString()).toStartWith("Error: Unknown command")
  }
}, 60_000)

test("the agent program emits one TOON document for help, version, errors and a prompt trailer", async () => {
  root = await fixture("holyagent-agent-output-")
  const cli = (...argv: string[]) =>
    Effect.runPromise(
      run(
        argv,
        {
          cwd: root,
          env: { HOLYAGENT_HOST: "pi", FORCE_COLOR: "3", HOME: root },
          stdin: Effect.die("agent command must not read stdin"),
          terminal: { stdin: true, stdout: true },
        },
        "agent",
      ),
    )
  const help = await cli("-h")
  expect(help).toEqual(await cli("--help"))
  expect(decode(help.stdout)).toMatchObject({ usage: "holyagent-cli <command> [flags]" })
  for (const group of [["intent"], ["assignment", "dispatch"], ["rg"], ["fd"]]) {
    const short = await cli(...group, "-h")
    expect(short).toEqual(await cli(...group, "--help"))
    expect(decode(short.stdout)).toMatchObject({ usage: `holyagent-cli ${group.join(" ")} --help` })
    expect(short.stderr).toBe("")
    expect(short.code).toBe(0)
  }
  const version = await cli("-v")
  expect(version).toEqual(await cli("--version"))
  expect(decode(version.stdout)).toMatchObject({
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
  })
  for (const argv of [
    ["setup", "-h"],
    ["update", "-h"],
    ["hook", "session-start"],
    ["intent", "create"],
    ["intent", "create", "--input\u001b[31m", "{}"],
  ]) {
    const failed = await cli(...argv)
    expect(failed.code).toBe(2)
    expect(failed.stderr).toBe("")
    expect(failed.stdout).not.toContain("\u001b")
    expect(decode(failed.stdout)).toMatchObject({ error: { tag: "Usage", code: 2 } })
  }
  const created = await cli("intent", "create", "--objective", "One document")
  expect(created.code).toBe(0)
  const dispatched = await cli(
    "assignment",
    "dispatch",
    "--role-task",
    "Reviewer.code",
    "--objective",
    "Read the brief",
    "--criterion",
    "blocking:behavior:Read the output",
  )
  expect(dispatched.code).toBe(0)
  expect(dispatched.stderr).toBe("")
  expect(decode(dispatched.stdout)).toMatchObject({
    id: expect.stringMatching(/^assignment-/),
    state: "Running",
    prompt: expect.stringMatching(/^Role: Reviewer\.code[^\n]+\nRead the brief at /),
  })
  expect(dispatched.stdout).not.toContain("\nprompt:\n")
}, 60_000)

test("the installed Pi runtime keeps Claude authorship out even with inherited Claude variables", async () => {
  root = await fixture("holyagent-pi-agent-host-")
  const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root }).exitCode
  expect(git(["init", "-q"])).toBe(0)
  const entry = join(import.meta.dir, "../src/hooks/pi-agent-entry.ts")
  const child = Bun.spawnSync(
    [
      process.execPath,
      entry,
      "vcs",
      "identity",
      "--name",
      "Test Fixture",
      "--email",
      "fixture@example.com",
    ],
    {
      cwd: root,
      env: { ...process.env, HOME: root, HOLYAGENT_HOST: "claude", CLAUDE_CODE_REMOTE: "true" },
      stdin: "ignore",
    },
  )
  expect(child.exitCode).toBe(3)
  expect(child.stderr.toString()).toBe("")
  expect(decode(child.stdout.toString())).toMatchObject({ error: { tag: "Unauthorized", code: 3 } })
  expect(git(["config", "--local", "--get", "author.name"])).toBe(1)
}, 60_000)

test.skipIf(process.platform === "win32" || Bun.which("script") === null)(
  "the internal Pi entry keeps setup line based on a terminal",
  async () => {
    root = await fixture("holyagent-plain-tty-")
    const entry = join(import.meta.dir, "../src/hooks/pi-entry.ts")
    const command = [process.execPath, entry, "setup", "--dry-run", "--skip-ctx7"]
      .map((part) => `'${part.replaceAll("'", "'\\''")}'`)
      .join(" ")
    const scriptArgs = (cmd: string) =>
      process.platform === "darwin"
        ? ["script", "-q", "/dev/null", "sh", "-c", cmd]
        : ["script", "-q", "-e", "-c", cmd, "/dev/null"]
    const child = Bun.spawnSync(scriptArgs(command), {
      cwd: root,
      env: {
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        T3CODE_HOME: root,
        HOLYAGENT_HOST: "pi",
        TERM: "xterm-256color",
        PATH: process.env["PATH"],
      },
    })
    expect(child.exitCode).not.toBeNull()
    const output = child.stdout.toString()
    expect(output).toContain("stdin or stdout is not a terminal")
    expect(output).not.toContain("installing the setup interface")
    expect(output).not.toContain("\u001b")
    const publicEntry = join(import.meta.dir, "../src/hooks/pi-public-entry.ts")
    const publicCommand = command.replace(entry, publicEntry)
    const publicChild = Bun.spawnSync(scriptArgs(publicCommand), {
      cwd: root,
      env: {
        HOME: root,
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        T3CODE_HOME: root,
        HOLYAGENT_HOST: "pi",
        TERM: "xterm-256color",
        PATH: process.env["PATH"],
      },
    })
    expect(publicChild.exitCode).not.toBeNull()
    // An unbuilt source tree has no setup bundle; reaching its loader proves this entry opted in.
    expect(publicChild.stdout.toString()).toContain("the interface bundle")
  },
  60_000,
)

const fixture = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: dir })
  if (git.exitCode !== 128) {
    await rm(dir, { recursive: true, force: true })
    throw new Error(`Fixture must be outside a Git repository: ${dir}`)
  }
  return dir
}

let root = ""
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

test("CLI guidance is plain under forced color and keeps its structured records on both hosts", async () => {
  root = await fixture("holyagent-plain-cli-")
  const cli = (argv: string[], host: string, input?: unknown) =>
    Effect.runPromise(
      run(argv, {
        cwd: root,
        env: {
          HOLYAGENT_HOST: host,
          FORCE_COLOR: "3",
          CLICOLOR_FORCE: "1",
          TERM: "xterm-256color",
        },
        terminal: { stdin: true, stdout: true },
        stdin:
          input === undefined
            ? Effect.fail(new StdinMissing({ reason: "no input" }))
            : Effect.succeed(JSON.stringify(input)),
      }),
    )
  for (const host of ["claude", "pi"]) {
    const help = await cli(["--help"], host)
    const version = await cli(["--version"], host)
    const invalid = await cli(["--input\u001b[31m"], host)
    expect(help.code).toBe(0)
    expect(help.stdout).toContain("help [command]")
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+/)
    expect(invalid.code).toBe(2)
    expect(invalid.stderr).toContain("Unknown command")
    expect(invalid.stderr).toContain("\\u001b[31m")
    const schemaError = await cli(["intent", "create"], host, {
      objective: "Task",
      unexpected: true,
    })
    expect(schemaError.code).toBe(2)
    expect(schemaError.stderr).toContain("unexpected")
    expect(schemaError.stderr).toContain("InvalidDraft")
    for (const output of [help.stdout, version.stdout, invalid.stderr])
      for (const character of output) {
        const code = character.charCodeAt(0)
        expect((code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)).toBe(false)
      }
    const objective = `Keep every requirement ${host} \u009b and literal \\u009b`
    const created = await cli(["intent", "create"], host, {
      objective,
      requirements: ["first", "last"],
    })
    expect(created.code).toBe(0)
    expect(created.stdout).not.toMatch(/[\u007f-\u009f]/)
    expect(decode(created.stdout)).toMatchObject({ objective, state: "Open" })
    const shown = await cli(["intent", "show"], host)
    expect(shown.code).toBe(0)
    expect(decode(shown.stdout)).toMatchObject({ objective, requirements: ["first", "last"] })
  }
}, 60_000)

test("search displays forced colors and control bytes as plain text", async () => {
  root = await fixture("holyagent-plain-search-")
  const file = join(root, "sample.txt")
  await Bun.write(file, "needle \u001b[31m data\n")
  const main = join(import.meta.dir, "../src/cli/main.ts")
  const child = Bun.spawnSync([process.execPath, main, "rg", "--color=always", "needle", file], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "3", CLICOLOR_FORCE: "1" },
  })
  expect(child.exitCode).toBe(0)
  expect(child.stdout.toString()).toContain("needle")
  expect(child.stdout.toString()).toContain("\\u001b[31m data")
  expect(child.stdout.includes(0x1b)).toBe(false)
  const absent = Bun.spawnSync([process.execPath, main, "rg", "--color=always", "missing", file], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: "3", CLICOLOR_FORCE: "1" },
  })
  expect(absent.exitCode).toBe(1)
  expect(await Bun.file(file).text()).toBe("needle \u001b[31m data\n")
  const rg = Bun.which("rg")
  expect(rg).not.toBeNull()
  if (rg === null) return
  for (const args of [["-e"], ["--glob"]]) {
    const direct = Bun.spawnSync([rg, ...args], { cwd: root })
    const wrapped = Bun.spawnSync([process.execPath, main, "rg", ...args], { cwd: root })
    expect(direct.exitCode).toBe(2)
    expect(wrapped.exitCode).toBe(direct.exitCode)
    expect(wrapped.stderr.toString()).toContain(args[0] ?? "")
  }
}, 60_000)

test.skipIf(process.platform === "win32")(
  "search handles controls split across subprocess chunks on both streams",
  async () => {
    root = await fixture("holyagent-search-chunks-")
    const bin = await fixture("holyagent-search-bin-")
    try {
      const fake = join(bin, "fd")
      await Bun.write(
        fake,
        "#!/bin/sh\nprintf '\\302'\n/bin/sleep 0.1\nprintf '\\233 UTF8 π \\233\\n'\nprintf '\\033[31m error\\n' >&2\nexit 7\n",
      )
      await chmod(fake, 0o755)
      const main = join(import.meta.dir, "../src/cli/main.ts")
      const result = Bun.spawnSync([process.execPath, main, "fd", "x"], {
        cwd: root,
        env: { ...process.env, PATH: bin, FORCE_COLOR: "3" },
      })
      expect(result.exitCode).toBe(7)
      expect(result.stdout.toString()).toBe("\\u009b UTF8 π \\u009b\n")
      expect(result.stderr.toString()).toBe("\\u001b[31m error\n")
    } finally {
      await rm(bin, { recursive: true, force: true })
    }
  },
)
