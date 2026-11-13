import { afterEach, expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"

let root = ""
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

test("CLI guidance is plain under forced color and keeps its structured records on both hosts", async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-plain-cli-"))
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
    const objective = `Keep every requirement ${host}`
    const created = await cli(["intent", "create"], host, {
      objective,
      requirements: ["first", "last"],
    })
    expect(created.code).toBe(0)
    expect(decode(created.stdout)).toMatchObject({ objective, state: "Open" })
    const shown = await cli(["intent", "show"], host)
    expect(shown.code).toBe(0)
    expect(decode(shown.stdout)).toMatchObject({ objective, requirements: ["first", "last"] })
  }
})

test("search displays forced colors and control bytes as plain text", async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-plain-search-"))
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
})

test.skipIf(process.platform === "win32")(
  "search handles controls split across subprocess chunks on both streams",
  async () => {
    root = await mkdtemp(join(tmpdir(), "holyagent-search-chunks-"))
    const bin = await mkdtemp(join(tmpdir(), "holyagent-search-bin-"))
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
