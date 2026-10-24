import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"

import packageJson from "../package.json" with { type: "json" }
import { parseJson } from "./support.ts"

const entry = join(import.meta.dir, "..", "src", "index.ts")

describe("holyagent binary", () => {
  test("--version prints the package version", async () => {
    const result = await $`bun ${entry} --version`.quiet()
    expect(result.stdout.toString()).toContain(packageJson.version)
  })

  test("--help lists the commands", async () => {
    const text = (await $`bun ${entry} --help`.quiet()).stdout.toString()
    for (const name of ["setup", "install", "doctor"]) expect(text).toContain(name)
  })

  test("setup --dry-run writes nothing and a real run writes the file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "holyagent-cli-"))
    const file = join(directory, ".claude", "settings.json")
    const dry = await $`bun ${entry} setup --dir ${directory} --dry-run`.quiet()
    expect(dry.stdout.toString()).toContain("dry run: would add 7")
    expect(existsSync(file)).toBe(false)
    await $`bun ${entry} setup --dir ${directory} --subagent-cache-ttl 5m`.quiet()
    expect(parseJson(readFileSync(file, "utf8")).subagentPromptCacheTtl).toBe("5m")
  })

  test("a settings file that is not JSON fails with exit code 1 and a message", async () => {
    const directory = mkdtempSync(join(tmpdir(), "holyagent-cli-"))
    await $`mkdir -p ${directory}/.claude && echo '[1]' > ${directory}/.claude/settings.json`.quiet()
    const result = await $`bun ${entry} setup --dir ${directory}`.quiet().nothrow()
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain("is not a JSON object")
  })
})
