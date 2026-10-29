import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"

import packageJson from "../package.json" with { type: "json" }
import { parseJson } from "./support.ts"

const entry = join(import.meta.dir, "..", "src", "index.ts")

/**
 * An isolated machine for the binary: an empty HOME and a PATH holding only a fake `claude` that
 * reports the HolyAgent plugin as installed, so no run touches the real Claude Code.
 */
const machine = (options: { readonly withClaude: boolean }) => {
  const home = mkdtempSync(join(tmpdir(), "holyagent-cli-home-"))
  const bin = join(home, "bin")
  mkdirSync(bin)
  if (options.withClaude) {
    const claude = join(bin, "claude")
    writeFileSync(claude, `#!/bin/sh\necho '[{"id":"holyagent@holyagent"}]'\n`)
    chmodSync(claude, 0o755)
  }
  return { HOME: home, PATH: bin, BUN_INSTALL: join(home, ".bun") }
}

const project = () => mkdtempSync(join(tmpdir(), "holyagent-cli-"))

describe("holyagent binary", () => {
  test("--version prints the package version", async () => {
    const result = await $`bun ${entry} --version`.quiet()
    expect(result.stdout.toString()).toContain(packageJson.version)
  })

  test("--help lists setup and doctor, and no install command", async () => {
    const text = (await $`bun ${entry} --help`.quiet()).stdout.toString()
    expect(text).toMatch(/^ {2}setup /m)
    expect(text).toMatch(/^ {2}doctor /m)
    expect(text).not.toMatch(/^ {2}install /m)
  })

  test("setup without a harness prints help listing claude", async () => {
    const result = await $`bun ${entry} setup`.quiet()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toMatch(/^ {2}claude /m)
  })

  test("setup claude --help lists the flags", async () => {
    const text = (await $`bun ${entry} setup claude --help`.quiet()).stdout.toString()
    for (const flag of ["--dir", "--subagent-cache-ttl", "--dry-run", "--skip-ctx7"]) {
      expect(text).toContain(flag)
    }
  })

  test("install is not a command", async () => {
    const result = await $`bun ${entry} install`.quiet().nothrow()
    expect(result.exitCode).not.toBe(0)
  })

  test("setup claude --dry-run writes nothing and a real run writes the file", async () => {
    const directory = project()
    const env = machine({ withClaude: true })
    const file = join(directory, ".claude", "settings.json")
    const flags = ["--skip-ctx7"]
    const dry = await $`bun ${entry} setup claude --dir ${directory} --dry-run ${flags}`
      .env(env)
      .quiet()
    expect(dry.stdout.toString()).toContain("dry run: would add 8")
    expect(existsSync(file)).toBe(false)
    const real =
      await $`bun ${entry} setup claude --dir ${directory} --subagent-cache-ttl 5m ${flags}`
        .env(env)
        .quiet()
    expect(real.stdout.toString()).toContain("= plugin holyagent@holyagent: already installed")
    expect(parseJson(readFileSync(file, "utf8")).subagentPromptCacheTtl).toBe("5m")
  })

  test("a missing claude fails the run with exit code 1 but the project settings are still written", async () => {
    const directory = project()
    const result = await $`bun ${entry} setup claude --dir ${directory} --skip-ctx7`
      .env(machine({ withClaude: false }))
      .quiet()
      .nothrow()
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("`claude` not found")
    expect(existsSync(join(directory, ".claude", "settings.json"))).toBe(true)
  })

  test("a settings file that is not JSON fails with exit code 1 and a message", async () => {
    const directory = project()
    await $`mkdir -p ${directory}/.claude && echo '[1]' > ${directory}/.claude/settings.json`.quiet()
    const result = await $`bun ${entry} setup claude --dir ${directory} --skip-ctx7`
      .env(machine({ withClaude: true }))
      .quiet()
      .nothrow()
    expect(result.exitCode).toBe(1)
    expect(result.stdout.toString()).toContain("is not a JSON object")
  })
})
