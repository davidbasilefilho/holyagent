import { afterEach, describe, expect, spyOn, test } from "bun:test"
import * as filesystem from "node:fs/promises"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { Effect } from "effect"

import { cleanupLeftovers, findLeftovers } from "../src/setup/leftovers.ts"
import { fakeShell } from "./setup-fixture.ts"

/** Runs a test effect. */
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

/** Parses a JSON object, failing the test on anything else. */
const parseJson = (text: string): Record<string, unknown> =>
  JSON.parse(text) as Record<string, unknown>

const temporaries: Array<string> = []
afterEach(async () => {
  await Promise.all(temporaries.splice(0).map((directory) => rm(directory, { recursive: true })))
})

/** Creates a temporary directory that is removed after the test. */
const tempDir = Effect.promise(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "holyagent-leftovers-"))
  temporaries.push(directory)
  return directory
})

/** The file operations the tests use, as effects. */
const fs = {
  readFileString: (file: string) => Effect.promise(() => readFile(file, "utf8")),
  writeFileString: (file: string, text: string) => Effect.promise(() => writeFile(file, text)),
  exists: (file: string) => Effect.promise(() => Bun.file(file).exists()),
  makeDirectory: (directory: string, options?: { readonly recursive?: boolean }) =>
    Effect.promise(() => mkdir(directory, options)),
}

const PROXY = "http://127.0.0.1:18787/bili/https://api.anthropic.com"
/** `commands/acp-cache.md` as Billion Context's installer writes it (src/plugin-install.ts). */
const COMMAND_BODY = [
  "---",
  "description: billion-context prompt-cache reconciliation report (same as the acp_cache tool)",
  "---",
  'Run the `acp_cache` tool provided by the `bili` MCP server now. If the arguments below contain the word "full", call it with detail:"full"; otherwise call it with no arguments. Then paste the tool\'s complete output verbatim in a fenced code block \u2014 do not summarize, translate, reorder, or omit anything. If the tool is unavailable, reply exactly: bili: acp_cache tool not available (is the bili MCP server registered?)',
  "",
  "Arguments: $ARGUMENTS",
  "",
].join("\n")
/** The `SessionStart` hook command and the MCP server entry Billion Context registers. */
const BOOTSTRAP = "node /opt/bili/dist/claude-native-bootstrap.js"
const BILI_SERVER = { type: "stdio", command: "node", args: ["/opt/bili/dist/claude-mcp-entry.js"] }

/** A fake home whose Claude Code files can be written and read as JSON. */
const home = Effect.gen(function* () {
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
    env: { HOME: root },
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
  env: {
    ANTHROPIC_BASE_URL: PROXY,
    ANTHROPIC_VERTEX_BASE_URL: "http://127.0.0.1:18787/bili/vertex/https://aiplatform.example",
    DISABLE_AUTO_COMPACT: "1",
    FOO: "bar",
  },
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: BOOTSTRAP }] },
      { hooks: [{ type: "command", command: "echo mine" }] },
    ],
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
            bili: BILI_SERVER,
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
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))

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
        expect(yield* fs.exists(h.command)).toBe(false)
        expect(shell.lines()).toEqual([
          "claude plugin uninstall billion-context@billion-context",
          "claude plugin marketplace remove billion-context",
        ])
        expect(lines.every((line) => line.startsWith("+ billion-context: removed "))).toBe(true)
        expect(lines.join("\n")).toContain("env.ANTHROPIC_BASE_URL")
        expect(lines.join("\n")).toContain("env.ANTHROPIC_VERTEX_BASE_URL")
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
        yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        const again = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
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
        const before = yield* fs.readFileString(h.settings)
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        expect(lines).toEqual(["= billion-context: no leftovers"])
        expect(yield* fs.readFileString(h.settings)).toBe(before)
        expect(shell.lines()).toEqual([])
      }),
    ))

  test("DISABLE_AUTO_COMPACT goes with the other native-mode artifacts, and only then", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, { env: { DISABLE_AUTO_COMPACT: "1" } })
        const shell = fakeShell({ commands: ["claude"] })
        expect(yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))).toEqual([
          "= billion-context: no leftovers",
        ])
        yield* h.write(h.command, COMMAND_BODY)
        yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        expect(yield* h.read(h.settings)).toEqual({})
      }),
    ))

  test("a dry run lists what would be removed and changes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, leftoverSettings)
        yield* h.write(h.command, COMMAND_BODY)
        yield* h.write(h.installed, { plugins: { "billion-context@billion-context": [{}] } })
        const before = yield* fs.readFileString(h.settings)
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.env, true).pipe(Effect.provide(shell.layer))
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
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        expect(lines).toEqual([
          "~ billion-context: marketplace billion-context stays; `claude` not found, run: claude plugin marketplace remove billion-context",
        ])
      }),
    ))

  test("a failed uninstall is reported as a failed line", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.installed, { plugins: { "billion-context@billion-context": [{}] } })
        const shell = fakeShell({
          commands: ["claude"],
          respond: () => ({ exitCode: 1, stderr: "in use" }),
        })
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
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
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        expect(lines[0]).toContain("is not a JSON object")
        expect(yield* fs.readFileString(h.settings)).toBe("[1]")
        expect(yield* fs.exists(h.command)).toBe(false)
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
        const one = path.join(yield* tempDir, "one")
        const two = path.join(yield* tempDir, "two")
        yield* fs.makeDirectory(one)
        yield* fs.makeDirectory(two)
        yield* h.write(h.installed, {
          version: 2,
          plugins: {
            "billion-context@billion-context": [
              { scope: "user", installPath: "/a" },
              { scope: "project", projectPath: one },
              { scope: "local", projectPath: two },
            ],
          },
        })
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        expect(shell.calls.map((call) => [call.line, call.cwd])).toEqual([
          ["claude plugin uninstall billion-context@billion-context", h.env.HOME],
          ["claude plugin uninstall billion-context@billion-context --scope project", one],
          ["claude plugin uninstall billion-context@billion-context --scope local", two],
        ])
        expect(lines).toEqual([
          "+ billion-context: removed plugin billion-context@billion-context",
          `+ billion-context: removed plugin billion-context@billion-context (project scope in ${one})`,
          `+ billion-context: removed plugin billion-context@billion-context (local scope in ${two})`,
        ])
      }),
    ))

  test("a project-scope install that records no project folder is skipped with the manual command", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.installed, {
          plugins: {
            "billion-context@billion-context": [{ scope: "project" }, { scope: "local" }],
          },
        })
        const shell = fakeShell({ commands: ["claude"] })
        for (const dryRun of [true, false]) {
          const lines = yield* cleanupLeftovers(h.env, dryRun).pipe(Effect.provide(shell.layer))
          expect(lines).toEqual([
            "~ billion-context: plugin billion-context@billion-context (project scope) stays; its install records no project folder, run in that project: claude plugin uninstall billion-context@billion-context --scope project",
            "~ billion-context: plugin billion-context@billion-context (local scope) stays; its install records no project folder, run in that project: claude plugin uninstall billion-context@billion-context --scope local",
          ])
        }
        expect(shell.lines()).toEqual([])
      }),
    ))

  test.skipIf(process.getuid === undefined)(
    "claude is not run in a project folder that is missing, relative, a file or owned by someone else",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* home
          const root = yield* tempDir
          const file = path.join(root, "a-file")
          const foreign = path.join(root, "foreign")
          yield* fs.writeFileString(file, "x")
          yield* fs.makeDirectory(foreign)
          const projects = [path.join(root, "missing"), "relative/dir", file, foreign]
          yield* h.write(h.installed, {
            plugins: {
              "billion-context@billion-context": projects.map((projectPath) => ({
                scope: "project",
                projectPath,
              })),
            },
          })
          // The one folder that exists is owned by the test user; the process claims to be someone else.
          const getuid = process.getuid
          ;(process as { getuid?: unknown }).getuid = () => (getuid?.() ?? 0) + 1
          const shell = fakeShell({ commands: ["claude"] })
          const lines = yield* cleanupLeftovers(h.env, false).pipe(
            Effect.provide(shell.layer),
            Effect.ensuring(
              Effect.sync(() => {
                ;(process as { getuid?: unknown }).getuid = getuid
              }),
            ),
          )
          expect(shell.lines()).toEqual([])
          expect(lines.length).toBe(4)
          for (const [index, line] of lines.entries()) {
            expect(line).toStartWith("~ billion-context: plugin billion-context@billion-context")
            expect(line).toContain(`in ${projects[index]}`)
            expect(line).toEndWith(
              "run in that project: claude plugin uninstall billion-context@billion-context --scope project",
            )
          }
        }),
      ),
  )

  test("a project folder that cannot be inspected is reported with the cause and claude is not run there", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const root = yield* tempDir
        // A path below a regular file cannot be inspected, and is not merely missing.
        const file = path.join(root, "a-file")
        yield* fs.writeFileString(file, "x")
        const below = path.join(file, "project")
        yield* h.write(h.installed, {
          plugins: {
            "billion-context@billion-context": [{ scope: "project", projectPath: below }],
          },
        })
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        expect(shell.lines()).toEqual([])
        expect(lines.length).toBe(1)
        expect(lines[0]).toStartWith(
          `~ billion-context: plugin billion-context@billion-context (project scope in ${below}) stays; cannot check ${below}: `,
        )
        expect(lines[0]).toContain("ENOTDIR")
        expect(lines[0]).not.toContain("not an existing folder of yours")
        expect(lines[0]).toEndWith(
          "run in that project: claude plugin uninstall billion-context@billion-context --scope project",
        )
      }),
    ))

  test("where the system has no user ids the removal runs and its line says the owner was not checked", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const root = yield* tempDir
        yield* h.write(h.installed, {
          plugins: { "billion-context@billion-context": [{ scope: "project", projectPath: root }] },
        })
        const getuid = process.getuid
        // Windows has no `process.getuid`.
        ;(process as { getuid?: unknown }).getuid = undefined
        try {
          for (const dryRun of [true, false]) {
            const shell = fakeShell({ commands: ["claude"] })
            const lines = yield* cleanupLeftovers(h.env, dryRun).pipe(Effect.provide(shell.layer))
            expect(lines.length).toBe(1)
            expect(lines[0]).toStartWith("+ billion-context: ")
            expect(lines[0]).toContain("owner was not checked")
            expect(shell.lines().length).toBe(dryRun ? 0 : 1)
          }
        } finally {
          ;(process as { getuid?: unknown }).getuid = getuid
        }
      }),
    ))

  test("an empty install list is no install", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.installed, { plugins: { "billion-context@billion-context": [] } })
        const shell = fakeShell({ commands: ["claude"] })
        const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
        expect(lines).toEqual(["= billion-context: no leftovers"])
        expect((yield* findLeftovers(h.files)).found).toEqual([])
        expect(shell.lines()).toEqual([])
      }),
    ))

  test("DISABLE_AUTO_COMPACT goes when the plugin, the marketplace or their settings entries show Billion Context set it", () =>
    run(
      Effect.gen(function* () {
        const evidence: ReadonlyArray<
          (h: Effect.Success<typeof home>) => Effect.Effect<void, unknown>
        > = [
          (h) => h.write(h.installed, { plugins: { "billion-context@billion-context": [{}] } }),
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
          yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
          expect((yield* h.read(h.settings))["env"]).toBeUndefined()
        }
      }),
    ))

  test("the base URLs are Billion Context's when they match its proxy pattern, on any port", () =>
    run(
      Effect.gen(function* () {
        const kept = [
          "http://127.0.0.1:18787",
          "http://127.0.0.1:18787/",
          "http://127.0.0.1:18787/other/https://x",
          "http://localhost:18787/bili/https://x",
          "https://127.0.0.1:18787/bili/https://x",
          "http://127.0.0.1:187871/bili/https://x",
          "http://127.0.0.1:18787@evil.example/bili/https://x",
          "http://127.0.0.1:18787/bili/Vertex/https://x",
          "http://127.0.0.1:18787/bili/ftp://x",
          "not a url",
        ]
        for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"]) {
          for (const url of kept) {
            const h = yield* home
            yield* h.write(h.settings, { env: { [key]: url } })
            const lines = yield* cleanupLeftovers(h.env, false).pipe(
              Effect.provide(fakeShell({ commands: ["claude"] }).layer),
            )
            expect(lines).toEqual(["= billion-context: no leftovers"])
          }
          for (const url of [
            "http://127.0.0.1:18787/bili/https://api.anthropic.com",
            "http://127.0.0.1:9/bili/http://upstream",
            "http://127.0.0.1:65535/bili/vertex-ai/https://x",
          ]) {
            const h = yield* home
            yield* h.write(h.settings, { env: { [key]: url } })
            yield* cleanupLeftovers(h.env, false).pipe(
              Effect.provide(fakeShell({ commands: ["claude"] }).layer),
            )
            expect(yield* h.read(h.settings)).toEqual({})
          }
        }
      }),
    ))

  test("the bili server is Billion Context's when node runs its entry script, at the top and under a project", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const entry = (command: string, script: string) => ({ command, args: ["--x", script] })
        yield* h.write(h.files.claudeJson, {
          mcpServers: {
            bili: entry("C:\\Program Files\\nodejs\\node.exe", "C:\\b\\dist\\claude-mcp-entry.mjs"),
          },
          projects: {
            "/work/a": {
              allowedTools: [],
              mcpServers: {
                bili: entry("/usr/bin/node", "/b/dist/mcp.js"),
                mine: { command: "x" },
              },
            },
            "/work/b": { mcpServers: { bili: entry("node.cmd", "dist/claude-mcp-entry.js") } },
            "/work/c": { mcpServers: { bili: entry("node", "/b/dist/claude-mcp-entry.ts") } },
            "/work/d": { mcpServers: { bili: entry("bun", "/b/dist/claude-mcp-entry.js") } },
            "/work/e": { mcpServers: { bili: { command: "bili", args: ["mcp"] } } },
            "/work/f": { mcpServers: { bili: { command: "node /b/dist/claude-mcp-entry.js" } } },
            "/work/g": { mcpServers: { bili: entry("nodejs", "/b/dist/claude-mcp-entry.js") } },
            "/work/h": { mcpServers: { bili: entry("node", "/b/distclaude-mcp-entry.js") } },
          },
        })
        const lines = yield* cleanupLeftovers(h.env, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        const foreign = (command: string, script: string) => ({ bili: entry(command, script) })
        expect(yield* h.read(h.files.claudeJson)).toEqual({
          projects: {
            "/work/a": { allowedTools: [], mcpServers: { mine: { command: "x" } } },
            "/work/b": {},
            "/work/c": { mcpServers: foreign("node", "/b/dist/claude-mcp-entry.ts") },
            "/work/d": { mcpServers: foreign("bun", "/b/dist/claude-mcp-entry.js") },
            "/work/e": { mcpServers: { bili: { command: "bili", args: ["mcp"] } } },
            "/work/f": { mcpServers: { bili: { command: "node /b/dist/claude-mcp-entry.js" } } },
            "/work/g": { mcpServers: foreign("nodejs", "/b/dist/claude-mcp-entry.js") },
            "/work/h": { mcpServers: foreign("node", "/b/distclaude-mcp-entry.js") },
          },
        })
        expect(lines.filter((line) => line.includes("mcpServers.bili")).length).toBe(3)
      }),
    ))

  test("a project named __proto__ keeps its place when another project is cleaned", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const server = JSON.stringify(BILI_SERVER)
        yield* h.write(
          h.files.claudeJson,
          `{"projects":{"__proto__":{"allowedTools":["a"]},"/work":{"mcpServers":{"bili":${server}}}}}`,
        )
        yield* cleanupLeftovers(h.env, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        const text = yield* fs.readFileString(h.files.claudeJson)
        const projects = parseJson(text)["projects"] as Record<string, unknown>
        expect(Object.keys(projects).sort()).toEqual(["/work", "__proto__"])
        expect(Object.getOwnPropertyDescriptor(projects, "__proto__")?.value).toEqual({
          allowedTools: ["a"],
        })
        expect(projects["/work"]).toEqual({})
      }),
    ))

  test("commands/acp-cache.md is removed only when its text equals what Billion Context writes", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({ commands: ["claude"] })
        const kept = [
          "My own command: summarise the cache.",
          "Part of Billion Context.",
          COMMAND_BODY.replace("reconciliation", "summary"),
          `${COMMAND_BODY.trimEnd()}\nExtra line`,
          ` ${COMMAND_BODY}`,
        ]
        for (const text of kept) {
          yield* h.write(h.command, text)
          const lines = yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
          expect(yield* fs.readFileString(h.command)).toBe(text)
          expect(lines.length).toBe(1)
          expect(lines[0]).toStartWith(`~ billion-context: ${h.command}`)
          expect((yield* findLeftovers(h.files)).found).toEqual([])
        }
        for (const text of [COMMAND_BODY, COMMAND_BODY.trimEnd(), `${COMMAND_BODY}\n\n`]) {
          yield* h.write(h.command, text)
          const dry = yield* cleanupLeftovers(h.env, true).pipe(Effect.provide(shell.layer))
          expect(dry).toEqual([`+ billion-context: would remove ${h.command}`])
          expect(yield* fs.exists(h.command)).toBe(true)
          yield* cleanupLeftovers(h.env, false).pipe(Effect.provide(shell.layer))
          expect(yield* fs.exists(h.command)).toBe(false)
        }
      }),
    ))

  test("only a SessionStart handler that runs Billion Context's bootstrap script is removed", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const hook = (command: string) => ({ hooks: [{ type: "command", command }] })
        const removed = [
          "node /a/dist/claude-native-bootstrap.js",
          'node "/a b/dist/claude-native-bootstrap.mjs"',
          "node '/a/dist/claude-native-bootstrap.ts'",
          "claude-native-bootstrap.js",
        ]
        const kept = [
          "bili hook claude-native-bootstrap",
          "node /a/claude-native-bootstrap.js --label x",
          "node /a/claude-native-bootstrap.sh",
          "node /a/my-claude-native-bootstrap.cjs",
          "echo claude-native-bootstrap.js done",
          "bili hook",
        ]
        const settings = {
          hooks: {
            SessionStart: [...removed, ...kept].map(hook),
            Stop: [hook(BOOTSTRAP)],
            PreToolUse: [{ hooks: [{ type: "command", command: BOOTSTRAP }] }],
          },
        }
        yield* h.write(h.settings, settings)
        const lines = yield* cleanupLeftovers(h.env, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* h.read(h.settings)).toEqual({
          hooks: { ...settings.hooks, SessionStart: kept.map(hook) },
        })
        expect(lines.length).toBe(removed.length)
      }),
    ))

  test("a group keeps its other handlers and the event goes when its last handler does", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, {
          hooks: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [
                  { type: "command", command: BOOTSTRAP },
                  { type: "command", command: "echo mine" },
                ],
              },
            ],
          },
        })
        yield* cleanupLeftovers(h.env, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* h.read(h.settings)).toEqual({
          hooks: {
            SessionStart: [
              { matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] },
            ],
          },
        })
        yield* h.write(h.settings, {
          hooks: { SessionStart: [{ hooks: [{ command: BOOTSTRAP }] }] },
        })
        yield* cleanupLeftovers(h.env, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* h.read(h.settings)).toEqual({})
      }),
    ))

  test("DISABLE_AUTO_COMPACT goes only when it is the string 1, and the backup's value is put back", () =>
    run(
      Effect.gen(function* () {
        const backup = (h: Effect.Success<typeof home>) => `${h.settings}.bili-bak`
        const withProxy = (compact: unknown) => ({
          env: { ANTHROPIC_BASE_URL: PROXY, DISABLE_AUTO_COMPACT: compact },
        })
        const cases: ReadonlyArray<{
          readonly compact: unknown
          readonly backup: object | string | undefined
          readonly env: Record<string, unknown> | undefined
        }> = [
          { compact: "1", backup: undefined, env: undefined },
          { compact: "1", backup: { env: { FOO: "x" } }, env: undefined },
          {
            compact: "1",
            backup: { env: { DISABLE_AUTO_COMPACT: "0" } },
            env: { DISABLE_AUTO_COMPACT: "0" },
          },
          {
            compact: "1",
            backup: { env: { DISABLE_AUTO_COMPACT: "1" } },
            env: { DISABLE_AUTO_COMPACT: "1" },
          },
          { compact: 1, backup: undefined, env: { DISABLE_AUTO_COMPACT: 1 } },
          {
            compact: "true",
            backup: { env: { DISABLE_AUTO_COMPACT: "0" } },
            env: { DISABLE_AUTO_COMPACT: "true" },
          },
          { compact: "1", backup: "not json", env: { DISABLE_AUTO_COMPACT: "1" } },
        ]
        for (const item of cases) {
          const h = yield* home
          yield* h.write(h.settings, withProxy(item.compact))
          if (item.backup !== undefined) yield* h.write(backup(h), item.backup)
          const lines = yield* cleanupLeftovers(h.env, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          )
          const settings = yield* h.read(h.settings)
          expect(settings["env"]).toEqual(item.env)
          if (item.backup === "not json")
            expect(lines.join("\n")).toContain("settings.json.bili-bak")
          // A second run changes nothing.
          const again = yield* cleanupLeftovers(h.env, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          )
          expect(yield* h.read(h.settings)).toEqual(settings)
          expect(again.filter((line) => line.startsWith("+ ")).length).toBe(0)
        }
      }),
    ))

  test("the backup value is put back when other Billion Context entries show the setting is its own", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, { env: { DISABLE_AUTO_COMPACT: "1" } })
        yield* h.write(`${h.settings}.bili-bak`, { env: { DISABLE_AUTO_COMPACT: "0", FOO: "x" } })
        yield* h.write(h.files.claudeJson, { mcpServers: { bili: BILI_SERVER } })
        const lines = yield* cleanupLeftovers(h.env, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* h.read(h.settings)).toEqual({ env: { DISABLE_AUTO_COMPACT: "0" } })
        expect(lines.join("\n")).toContain("put back the value in settings.json.bili-bak")
      }),
    ))

  test("settings.json, commands/ and .claude.json come from CLAUDE_CONFIG_DIR when it is set", () =>
    run(
      Effect.gen(function* () {
        const root = yield* tempDir
        const config = path.join(root, "custom")
        const write = (file: string, content: string | object) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(path.dirname(file), { recursive: true })
            yield* fs.writeFileString(
              file,
              typeof content === "string" ? content : JSON.stringify(content),
            )
          })
        const decoy = JSON.stringify({ mcpServers: { bili: BILI_SERVER } })
        yield* write(path.join(root, ".claude.json"), decoy)
        yield* write(path.join(root, ".claude", "settings.json"), leftoverSettings)
        yield* write(path.join(root, ".claude", "commands", "acp-cache.md"), COMMAND_BODY)
        yield* write(path.join(config, ".claude.json"), { mcpServers: { bili: BILI_SERVER } })
        yield* write(path.join(config, "settings.json"), leftoverSettings)
        yield* write(path.join(config, "commands", "acp-cache.md"), COMMAND_BODY)
        yield* write(path.join(config, "settings.json.bili-bak"), {
          env: { DISABLE_AUTO_COMPACT: "0" },
        })
        yield* cleanupLeftovers({ HOME: root, CLAUDE_CONFIG_DIR: config }, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(yield* fs.exists(path.join(config, "commands", "acp-cache.md"))).toBe(false)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.map(parseJson))
        expect(yield* read(path.join(config, ".claude.json"))).toEqual({})
        expect((yield* read(path.join(config, "settings.json")))["env"]).toEqual({
          FOO: "bar",
          DISABLE_AUTO_COMPACT: "0",
        })
        // The default locations are not touched.
        expect(yield* fs.readFileString(path.join(root, ".claude.json"))).toBe(decoy)
        expect(yield* fs.exists(path.join(root, ".claude", "commands", "acp-cache.md"))).toBe(true)
      }),
    ))

  test("the lines name the matched marker and never print a command string", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.settings, {
          hooks: {
            SessionStart: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "LABEL=hidden-value-one node /x/claude-native-bootstrap.js",
                  },
                ],
              },
            ],
          },
        })
        yield* h.write(h.files.claudeJson, {
          mcpServers: { bili: { ...BILI_SERVER, env: { LABEL: "hidden-value-three" } } },
        })
        for (const dryRun of [true, false]) {
          const lines = yield* cleanupLeftovers(h.env, dryRun).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          )
          expect(lines.join("\n")).not.toContain("hidden-value")
          expect(lines.join("\n")).toContain("claude-native-bootstrap")
          expect(lines.join("\n")).toContain("mcpServers.bili")
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
        const lines = yield* cleanupLeftovers(h.env, false).pipe(
          Effect.provide(fakeShell({ commands: ["claude"] }).layer),
        )
        expect(lines.length).toBe(2)
        expect(lines.every((line) => line.startsWith("! billion-context: "))).toBe(true)
      }),
    ))

  /**
   * Runs `effect` while every temporary file the cleanup writes is followed by `during`, which
   * stands for another program rewriting the file just before the cleanup replaces it.
   */
  const racing = <A, E, R>(
    during: () => Effect.Effect<void, unknown>,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = filesystem.writeFile
        return spyOn(filesystem, "writeFile").mockImplementation((async (
          ...args: Parameters<typeof filesystem.writeFile>
        ) => {
          const written = await original(...args)
          if (typeof args[0] === "string" && args[0].endsWith(".tmp"))
            await Effect.runPromise(Effect.ignore(during()))
          return written
        }) as typeof filesystem.writeFile)
      }),
      () => effect,
      (spy) => Effect.sync(() => spy.mockRestore()),
    )

  test("a ~/.claude.json that Claude Code rewrites during the cleanup keeps that update", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const original = { numStartups: 3, mcpServers: { bili: BILI_SERVER } }
        yield* h.write(h.files.claudeJson, original)
        let writes = 0
        const lines = yield* racing(
          () => {
            writes += 1
            return writes === 1
              ? h.write(h.files.claudeJson, { ...original, numStartups: 4 })
              : Effect.void
          },
          cleanupLeftovers(h.env, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          ),
        )
        expect(yield* h.read(h.files.claudeJson)).toEqual({ numStartups: 4 })
        expect(lines.every((line) => line.startsWith("+ billion-context: removed "))).toBe(true)
        expect(writes).toBe(2)
      }),
    ))

  test("a file that turns into invalid JSON during the retry is left as it is, with a note", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.files.claudeJson, { mcpServers: { bili: BILI_SERVER } })
        const lines = yield* racing(
          () => h.write(h.files.claudeJson, "{ half written"),
          cleanupLeftovers(h.env, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          ),
        )
        expect(lines.length).toBe(1)
        expect(lines[0]).toStartWith(`~ billion-context: ${h.files.claudeJson} changed while`)
        expect(lines[0]).toContain("cannot be read now")
        expect(yield* fs.readFileString(h.files.claudeJson)).toBe("{ half written")
      }),
    ))

  test("a file that turns blank during the retry is left as it is, with a note", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.write(h.files.claudeJson, { mcpServers: { bili: BILI_SERVER } })
        const lines = yield* racing(
          () => h.write(h.files.claudeJson, ""),
          cleanupLeftovers(h.env, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          ),
        )
        expect(lines.length).toBe(1)
        expect(lines[0]).toStartWith(`~ billion-context: ${h.files.claudeJson} changed while`)
        expect(lines[0]).toContain("cannot be read now")
        expect(yield* fs.readFileString(h.files.claudeJson)).toBe("")
      }),
    ))

  test("a file that keeps changing is left as it is, with a note", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        let count = 0
        yield* h.write(h.files.claudeJson, { n: 0, mcpServers: { bili: BILI_SERVER } })
        const lines = yield* racing(
          () => {
            count += 1
            return h.write(h.files.claudeJson, {
              n: count,
              mcpServers: { bili: BILI_SERVER },
            })
          },
          cleanupLeftovers(h.env, false).pipe(
            Effect.provide(fakeShell({ commands: ["claude"] }).layer),
          ),
        )
        expect(lines.length).toBe(1)
        expect(lines[0]).toContain("kept changing")
        expect((yield* h.read(h.files.claudeJson))["mcpServers"]).toBeDefined()
        expect(lines[0]?.startsWith("~ billion-context: ")).toBe(true)
      }),
    ))
})
