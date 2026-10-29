import { describe, expect, test } from "bun:test"

import { Effect, FileSystem, Path } from "effect"

import { cleanupLeftovers, findLeftovers } from "../src/claude/leftovers.ts"
import { fakeShell, parseJson, run, tempDir } from "./support.ts"

const PROXY = "http://127.0.0.1:18787/bili/https://api.anthropic.com"

/** A fake home whose Claude Code files can be written and read as JSON. */
const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* tempDir
  const files = {
    claudeDir: path.join(root, ".claude"),
    claudeJson: path.join(root, ".claude.json"),
  }
  const write = (file: string, content: string | object) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(
        file,
        typeof content === "string" ? content : JSON.stringify(content, null, 2),
      )
    })
  const read = (file: string) => fs.readFileString(file).pipe(Effect.map(parseJson))
  return {
    files,
    write,
    read,
    settings: path.join(files.claudeDir, "settings.json"),
    command: path.join(files.claudeDir, "commands", "acp-cache.md"),
    installed: path.join(files.claudeDir, "plugins", "installed_plugins.json"),
    markets: path.join(files.claudeDir, "plugins", "known_marketplaces.json"),
  }
})

const leftoverSettings = {
  model: "opus",
  env: { ANTHROPIC_BASE_URL: PROXY, DISABLE_AUTO_COMPACT: "1", FOO: "bar" },
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: "bili hook claude-native-bootstrap" }] },
      { hooks: [{ type: "command", command: "echo mine" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "bili hook claude-native-bootstrap" }] }],
  },
  enabledPlugins: { "billion-context@billion-context": true, "other@market": true },
  extraKnownMarketplaces: { "billion-context": { source: { source: "github" } } },
}

describe("Billion Context leftovers", () => {
  test("cleanup removes the entries Billion Context wrote, keeps the rest, and says what it removed", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, leftoverSettings)
        yield* h.write(h.files.claudeJson, {
          numStartups: 3,
          mcpServers: {
            bili: { type: "stdio", command: "bili", args: ["mcp"] },
            mine: { command: "x" },
          },
        })
        yield* h.write(h.command, "# acp-cache")
        yield* h.write(h.installed, {
          version: 2,
          plugins: { "billion-context@billion-context": [{}] },
        })
        yield* h.write(h.markets, { "billion-context": {}, holyagent: {} })
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))

        expect(yield* h.read(h.settings)).toEqual({
          model: "opus",
          env: { FOO: "bar" },
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo mine" }] }] },
          enabledPlugins: { "other@market": true },
        })
        expect(yield* h.read(h.files.claudeJson)).toEqual({
          numStartups: 3,
          mcpServers: { mine: { command: "x" } },
        })
        expect(yield* (yield* FileSystem.FileSystem).exists(h.command)).toBe(false)
        expect(shell.lines()).toEqual([
          "claude plugin uninstall billion-context@billion-context",
          "claude plugin marketplace remove billion-context",
        ])
        expect(lines.every((line) => line.startsWith("+ billion-context: removed "))).toBe(true)
        expect(lines.join("\n")).toContain("env.ANTHROPIC_BASE_URL")
        expect(lines.join("\n")).toContain("env.DISABLE_AUTO_COMPACT")
        expect(lines.join("\n")).toContain("mcpServers.bili")
        expect(lines.join("\n")).toContain(h.command)
      }),
    ))

  test("a second run finds nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, leftoverSettings)
        const shell = fakeShell({ commands: ["claude"] })
        yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        const again = yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(again).toEqual(["= billion-context: no leftovers"])
      }),
    ))

  test("settings that Billion Context did not write are left alone", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const mine = {
          env: { ANTHROPIC_BASE_URL: "https://proxy.example.com", DISABLE_AUTO_COMPACT: "1" },
          hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }] },
          enabledPlugins: { "other@market": true },
        }
        yield* h.write(h.settings, mine)
        yield* h.write(h.files.claudeJson, {
          mcpServers: { bili: { command: "node", args: ["x"] } },
        })
        yield* h.write(h.command.replace("acp-cache", "other"), "x")
        const before = yield* (yield* FileSystem.FileSystem).readFileString(h.settings)
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(lines).toEqual(["= billion-context: no leftovers"])
        expect(yield* (yield* FileSystem.FileSystem).readFileString(h.settings)).toBe(before)
        expect(shell.lines()).toEqual([])
      }),
    ))

  test("DISABLE_AUTO_COMPACT goes with the other native-mode artifacts, and only then", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, { env: { DISABLE_AUTO_COMPACT: "1" } })
        const shell = fakeShell({ commands: ["claude"] })
        expect(yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))).toEqual([
          "= billion-context: no leftovers",
        ])
        yield* h.write(h.command, "x")
        yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(yield* h.read(h.settings)).toEqual({})
      }),
    ))

  test("a dry run lists what would be removed and changes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, leftoverSettings)
        yield* h.write(h.command, "x")
        yield* h.write(h.installed, { plugins: { "billion-context@billion-context": [] } })
        const fs = yield* FileSystem.FileSystem
        const before = yield* fs.readFileString(h.settings)
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.files, true).pipe(Effect.provide(shell.layer))
        expect(lines.length).toBeGreaterThan(0)
        expect(lines.every((line) => line.startsWith("+ billion-context: would remove "))).toBe(
          true,
        )
        expect(yield* fs.readFileString(h.settings)).toBe(before)
        expect(yield* fs.exists(h.command)).toBe(true)
        expect(shell.lines()).toEqual([])
      }),
    ))

  test("without claude the plugin stays and the line gives the command", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.markets, { "billion-context": {} })
        const shell = fakeShell({ commands: [] })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(lines).toEqual([
          "~ billion-context: marketplace billion-context stays; `claude` not found, run: claude plugin marketplace remove billion-context",
        ])
      }),
    ))

  test("a failed uninstall is reported as a failed line", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.installed, { plugins: { "billion-context@billion-context": [] } })
        const shell = fakeShell({
          commands: ["claude"],
          respond: () => ({ exitCode: 1, stderr: "in use" }),
        })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(lines).toEqual([
          "! billion-context: claude plugin uninstall billion-context@billion-context failed (exit 1): in use",
        ])
      }),
    ))

  test("a settings file that is not a JSON object is reported and not overwritten", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, "[1]")
        yield* h.write(h.command, "x")
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(lines[0]).toContain("is not a JSON object")
        expect(yield* (yield* FileSystem.FileSystem).readFileString(h.settings)).toBe("[1]")
        expect(yield* (yield* FileSystem.FileSystem).exists(h.command)).toBe(false)
      }),
    ))

  test("findLeftovers lists each leftover without touching anything", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, { env: { ANTHROPIC_BASE_URL: PROXY } })
        const found = yield* findLeftovers(h.files)
        expect(found.found).toEqual([`env.ANTHROPIC_BASE_URL in ${h.settings}`])
      }),
    ))
})
