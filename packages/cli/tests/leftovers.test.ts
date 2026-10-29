import { describe, expect, test } from "bun:test"

import { Effect, FileSystem, Path } from "effect"

import { cleanupLeftovers, findLeftovers } from "../src/claude/leftovers.ts"
import { fakeShell, parseJson, run, tempDir } from "./support.ts"

const PROXY = "http://127.0.0.1:18787/bili/https://api.anthropic.com"
/** What a command file written by Billion Context says. */
const COMMAND_BODY = "# acp-cache\nShow the bili cache statistics."

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
        yield* h.write(h.command, COMMAND_BODY)
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
        yield* h.write(h.command, COMMAND_BODY)
        yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(yield* h.read(h.settings)).toEqual({})
      }),
    ))

  test("a dry run lists what would be removed and changes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, leftoverSettings)
        yield* h.write(h.command, COMMAND_BODY)
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
        yield* h.write(h.command, COMMAND_BODY)
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

  test("a plugin installed at project or local scope is uninstalled with that scope, from its project", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.installed, {
          version: 2,
          plugins: {
            "billion-context@billion-context": [
              { scope: "user", installPath: "/a" },
              { scope: "project", projectPath: "/work/one" },
              { scope: "local", projectPath: "/work/two" },
            ],
          },
        })
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
        expect(shell.calls.map((call) => [call.line, call.cwd])).toEqual([
          ["claude plugin uninstall billion-context@billion-context", undefined],
          ["claude plugin uninstall billion-context@billion-context --scope project", "/work/one"],
          ["claude plugin uninstall billion-context@billion-context --scope local", "/work/two"],
        ])
        expect(lines.every((line) => line.startsWith("+ billion-context: removed plugin "))).toBe(
          true,
        )
      }),
    ))

  test("DISABLE_AUTO_COMPACT goes when the plugin, the marketplace or their settings entries show Billion Context set it", () =>
    run(
      Effect.gen(function* () {
        const evidence: ReadonlyArray<
          (h: Effect.Success<typeof home>) => Effect.Effect<void, unknown, FileSystem.FileSystem>
        > = [
          (h) => h.write(h.installed, { plugins: { "billion-context@billion-context": [] } }),
          (h) => h.write(h.markets, { "billion-context": {} }),
          (h) =>
            h.write(h.settings, {
              env: { DISABLE_AUTO_COMPACT: "1" },
              enabledPlugins: { "billion-context@billion-context": true },
            }),
          (h) =>
            h.write(h.settings, {
              env: { DISABLE_AUTO_COMPACT: "1" },
              extraKnownMarketplaces: { "billion-context": {} },
            }),
        ]
        for (const [index, arrange] of evidence.entries()) {
          const h = yield* home
          if (index < 2) yield* h.write(h.settings, { env: { DISABLE_AUTO_COMPACT: "1" } })
          yield* arrange(h)
          const shell = fakeShell({ commands: ["claude"] })
          yield* cleanupLeftovers(h.files, false).pipe(Effect.provide(shell.layer))
          expect((yield* h.read(h.settings))["env"]).toBeUndefined()
        }
      }),
    ))

  test("a proxy URL is matched by its exact origin, with any path", () =>
    run(
      Effect.gen(function* () {
        const kept = [
          "http://127.0.0.1:187871/bili",
          "http://127.0.0.1:18787.example.com/x",
          "https://127.0.0.1:18787/x",
          "not a url",
        ]
        for (const url of kept) {
          const h = yield* home
          yield* h.write(h.settings, { env: { ANTHROPIC_BASE_URL: url } })
          const lines = yield* cleanupLeftovers(h.files, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          )
          expect(lines).toEqual(["= billion-context: no leftovers"])
        }
        for (const url of ["http://127.0.0.1:18787", "http://127.0.0.1:18787/"]) {
          const h = yield* home
          yield* h.write(h.settings, { env: { ANTHROPIC_BASE_URL: url } })
          yield* cleanupLeftovers(h.files, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          )
          expect(yield* h.read(h.settings)).toEqual({})
        }
      }),
    ))

  test("the bili server is found behind quotes, env and VAR= wrappers, and under a project", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.files.claudeJson, {
          mcpServers: { bili: { command: '"C:\\Program Files\\bili\\bili.cmd" mcp' } },
          projects: {
            "/work/a": {
              allowedTools: [],
              mcpServers: {
                bili: { command: "env -i FOO=1 bili mcp" },
                mine: { command: "x" },
              },
            },
            "/work/b": { mcpServers: { bili: { command: "FOO=1 /usr/local/bin/bili mcp" } } },
            "/work/c": { mcpServers: { bili: { command: "node bili.js" } } },
          },
        })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* h.read(h.files.claudeJson)).toEqual({
          projects: {
            "/work/a": { allowedTools: [], mcpServers: { mine: { command: "x" } } },
            "/work/b": {},
            "/work/c": { mcpServers: { bili: { command: "node bili.js" } } },
          },
        })
        expect(lines.filter((line) => line.includes("mcpServers.bili")).length).toBe(3)
      }),
    ))

  test("commands/acp-cache.md is removed only when it mentions Billion Context, and is reported otherwise", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const h = yield* home
        yield* h.write(h.command, "My own command: summarise the cache.")
        const lines = yield* cleanupLeftovers(h.files, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* fs.exists(h.command)).toBe(true)
        expect(lines.length).toBe(1)
        expect(lines[0]).toStartWith(`~ billion-context: ${h.command}`)
        const found = yield* findLeftovers(h.files)
        expect(found.found).toEqual([])
        yield* h.write(h.command, "Part of Billion Context.")
        yield* cleanupLeftovers(h.files, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* fs.exists(h.command)).toBe(false)
      }),
    ))

  test("the lines name the matched program or marker and never print a command string", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  { type: "command", command: "node x.js claude-native-bootstrap --token S3CRET1" },
                  { type: "command", command: "TOKEN=S3CRET2 bili hook" },
                ],
              },
            ],
          },
        })
        yield* h.write(h.files.claudeJson, {
          mcpServers: { bili: { command: "env TOKEN=S3CRET3 bili mcp" } },
        })
        for (const dryRun of [true, false]) {
          const lines = yield* cleanupLeftovers(h.files, dryRun).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          )
          expect(lines.join("\n")).not.toContain("S3CRET")
          expect(lines.join("\n")).toContain("claude-native-bootstrap")
          expect(lines.join("\n")).toContain("matching bili")
        }
        const found = yield* findLeftovers(h.files)
        expect(found.found).toEqual([])
      }),
    ))

  test("plugin and marketplace records that cannot be read are reported as unreadable", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.installed, "[1]")
        yield* h.write(h.markets, "not json")
        const found = yield* findLeftovers(h.files)
        expect(found.unreadable.length).toBe(2)
        const lines = yield* cleanupLeftovers(h.files, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(lines.length).toBe(2)
        expect(lines.every((line) => line.startsWith("! billion-context: "))).toBe(true)
      }),
    ))

  /** A file system whose first `chmod` (just before the cleanup's final check) runs `during`. */
  const interrupted = (fs: FileSystem.FileSystem, during: () => Effect.Effect<void, unknown>) =>
    ({
      ...fs,
      chmod: (path: string, mode: number) =>
        during().pipe(Effect.ignore, Effect.andThen(fs.chmod(path, mode))),
    }) as FileSystem.FileSystem

  test("a ~/.claude.json that Claude Code rewrites during the cleanup keeps that update", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const h = yield* home
        const original = { numStartups: 3, mcpServers: { bili: { command: "bili" } } }
        yield* h.write(h.files.claudeJson, original)
        let writes = 0
        const racing = interrupted(fs, () => {
          writes += 1
          return writes === 1
            ? h.write(h.files.claudeJson, { ...original, numStartups: 4 })
            : Effect.void
        })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          Effect.provideService(FileSystem.FileSystem, racing),
        )
        expect(yield* h.read(h.files.claudeJson)).toEqual({ numStartups: 4 })
        expect(lines.every((line) => line.startsWith("+ billion-context: removed "))).toBe(true)
        expect(writes).toBe(2)
      }),
    ))

  test("a file that keeps changing is left as it is, with a note", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const h = yield* home
        let count = 0
        yield* h.write(h.files.claudeJson, { n: 0, mcpServers: { bili: { command: "bili" } } })
        const racing = interrupted(fs, () => {
          count += 1
          return h.write(h.files.claudeJson, {
            n: count,
            mcpServers: { bili: { command: "bili" } },
          })
        })
        const lines = yield* cleanupLeftovers(h.files, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          Effect.provideService(FileSystem.FileSystem, racing),
        )
        expect(lines.length).toBe(1)
        expect(lines[0]).toContain("kept changing")
        expect((yield* h.read(h.files.claudeJson))["mcpServers"]).toBeDefined()
        expect(lines[0]?.startsWith("~ billion-context: ")).toBe(true)
      }),
    ))
})
