import { describe, expect, test } from "bun:test"

import { Effect, FileSystem, Path } from "effect"

import { install } from "../src/cmd/install.ts"
import { envLayer, fakeShell, parseJson, run, tempDir } from "./support.ts"

const both = { skipBillionContext: false, skipCtx7: false }
const pluginList = (ids: ReadonlyArray<string>) => (line: string) =>
  line === "claude plugin list --json"
    ? { stdout: JSON.stringify(ids.map((id) => ({ id, scope: "user" }))) }
    : undefined

/** A fake home with the paths `install` reads. */
const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* tempDir
  const write = (relative: string, content: string) =>
    Effect.gen(function* () {
      const file = path.join(root, relative)
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, content)
    })
  const biliConfig = path.join(root, ".config", "billion-context", "billion-context.json")
  const markBiliNative = Effect.all([
    write(".claude/settings.json", '{"hooks":"claude-native-bootstrap"}'),
    write(".claude/commands/acp-cache.md", "x"),
    write(".claude.json", '{"mcpServers":{"bili":{}}}'),
  ])
  const markCtx7Skill = Effect.all([
    write(".claude/skills/find-docs/SKILL.md", "x"),
    write(".claude/rules/context7.md", "x"),
  ])
  return {
    root,
    write,
    biliConfig,
    markBiliNative,
    markCtx7Skill,
    read: (file: string) => fs.readFileString(file),
    fs,
  }
})

describe("holyagent install", () => {
  test("on a fresh machine installs everything in order and skips the unauthenticated ctx7 skill", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({ commands: ["claude", "bun"], respond: pluginList([]) })
        const report = yield* install(both).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual([
          "claude plugin list --json",
          "claude plugin marketplace list --json",
          "claude plugin marketplace add davidbasilefilho/holyagent",
          "claude plugin install holyagent@holyagent",
          "bun add -g billion-context",
          "bili plugin install claude",
          "bun add -g ctx7",
        ])
        expect(report.ok).toBe(true)
        expect(report.lines.filter((line) => line.startsWith("- "))).toEqual([
          "- ctx7 skill: no CONTEXT7_API_KEY and no saved login; run `ctx7 login` or export CONTEXT7_API_KEY, then re-run",
        ])
        expect(parseJson(yield* h.read(h.biliConfig))).toEqual({ compress: { rules: true } })
        expect((yield* h.fs.stat(h.biliConfig)).mode & 0o777).toBe(0o600)
      }),
    ))

  test("when everything is installed it only reads the plugin list and changes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.markBiliNative
        yield* h.markCtx7Skill
        const config = '{"compress":{"rules":false},"port":9000}'
        yield* h.write(".config/billion-context/billion-context.json", config)
        const shell = fakeShell({
          commands: ["claude", "bun", "bili", "ctx7"],
          respond: pluginList(["holyagent@holyagent", "other@market"]),
        })
        const report = yield* install(both).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual(["claude plugin list --json"])
        expect(report.ok).toBe(true)
        expect(report.lines.every((line) => line.startsWith("= "))).toBe(true)
        expect(yield* h.read(h.biliConfig)).toBe(config)
      }),
    ))

  test("installs the Claude plugin when the marketplace plugin is missing but bili is native-ready", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.markBiliNative
        yield* h.write(".config/billion-context/billion-context.json", '{"port":9000}')
        const shell = fakeShell({
          commands: ["claude", "bili"],
          respond: pluginList(["other@market"]),
        })
        yield* install({ skipBillionContext: false, skipCtx7: true }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual([
          "claude plugin list --json",
          "claude plugin marketplace list --json",
          "claude plugin marketplace add davidbasilefilho/holyagent",
          "claude plugin install holyagent@holyagent",
        ])
        expect(parseJson(yield* h.read(h.biliConfig))).toEqual({
          port: 9000,
          compress: { rules: true },
        })
      }),
    ))

  test("an already registered marketplace is not added again", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({
          commands: ["claude"],
          respond: (line) =>
            line === "claude plugin marketplace list --json"
              ? { stdout: JSON.stringify([{ name: "holyagent", source: "github" }]) }
              : pluginList([])(line),
        })
        const report = yield* install({ skipBillionContext: true, skipCtx7: true }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(report.ok).toBe(true)
        expect(shell.lines()).toEqual([
          "claude plugin list --json",
          "claude plugin marketplace list --json",
          "claude plugin install holyagent@holyagent",
        ])
      }),
    ))

  test("an unreadable HOME fails its steps but keeps the lines already printed; an empty CONTEXT7_API_KEY counts as unset", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.markCtx7Skill
        const shell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const noHome = yield* install(both).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({})),
        )
        expect(noHome.ok).toBe(false)
        expect(noHome.lines[0]).toBe("= plugin holyagent@holyagent: already installed")
        expect(noHome.lines.filter((line) => line.startsWith("! "))).toHaveLength(2)

        const emptyKeyShell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const emptyKey = yield* install({ skipBillionContext: true, skipCtx7: false }).pipe(
          Effect.provide(emptyKeyShell.layer),
          Effect.provide(envLayer({ HOME: (yield* home).root, CONTEXT7_API_KEY: "" })),
        )
        expect(emptyKey.ok).toBe(true)
        expect(emptyKey.lines.at(-1)).toStartWith("- ctx7 skill: no CONTEXT7_API_KEY")
        expect(emptyKeyShell.lines()).toEqual(["claude plugin list --json"])
      }),
    ))

  test("the skip flags leave Billion Context and ctx7 alone", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({
          commands: ["claude"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const report = yield* install({ skipBillionContext: true, skipCtx7: true }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual(["claude plugin list --json"])
        expect(report.lines).toContain("- billion-context: skipped by flag")
        expect(report.lines).toContain("- ctx7: skipped by flag")
      }),
    ))

  test("ctx7 setup uses CONTEXT7_API_KEY, else a saved login, else is skipped", () =>
    run(
      Effect.gen(function* () {
        const setupLine = (calls: ReadonlyArray<string>) =>
          calls.find((line) => line.startsWith("ctx7 setup"))
        const options = { skipBillionContext: true, skipCtx7: false }
        const withKey = yield* home
        const keyShell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        yield* install(options).pipe(
          Effect.provide(keyShell.layer),
          Effect.provide(envLayer({ HOME: withKey.root, CONTEXT7_API_KEY: "ctx7sk-test" })),
        )
        expect(setupLine(keyShell.lines())).toBe(
          "ctx7 setup --cli --claude --yes --api-key ctx7sk-test",
        )

        const withLogin = yield* home
        yield* withLogin.write(".config/context7/credentials.json", "{}")
        const loginShell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        yield* install(options).pipe(
          Effect.provide(loginShell.layer),
          Effect.provide(envLayer({ HOME: withLogin.root })),
        )
        expect(setupLine(loginShell.lines())).toBe("ctx7 setup --cli --claude --yes")

        const bare = yield* home
        const bareShell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        yield* install(options).pipe(
          Effect.provide(bareShell.layer),
          Effect.provide(envLayer({ HOME: bare.root })),
        )
        expect(setupLine(bareShell.lines())).toBeUndefined()
      }),
    ))

  test("a failing step is reported, later steps still run, and the report is not ok", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({
          commands: ["claude", "bun"],
          respond: (line) =>
            line === "claude plugin marketplace add davidbasilefilho/holyagent"
              ? { exitCode: 1, stderr: "network down\nmore" }
              : pluginList([])(line),
        })
        const report = yield* install({ skipBillionContext: true, skipCtx7: false }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toBe(
          "! claude plugin marketplace add: failed (exit 1): network down",
        )
        expect(shell.lines()).not.toContain("claude plugin install holyagent@holyagent")
        expect(shell.lines()).toContain("bun add -g ctx7")
      }),
    ))

  test("missing claude is a failed plugin step with a pointer to the Claude Code setup docs", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({ commands: [] })
        const report = yield* install({ skipBillionContext: true, skipCtx7: true }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toContain("`claude` not found")
        expect(shell.lines()).toEqual([])
      }),
    ))

  test("a Billion Context config that is not a JSON object is reported and left alone", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.markBiliNative
        yield* h.write(".config/billion-context/billion-context.json", "[1]")
        const shell = fakeShell({
          commands: ["claude", "bili"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const report = yield* install({ skipBillionContext: false, skipCtx7: true }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(report.ok).toBe(false)
        expect(report.lines.find((line) => line.startsWith("! bili config"))).toContain(
          "is not a JSON object",
        )
        expect(yield* h.read(h.biliConfig)).toBe("[1]")
      }),
    ))
})
