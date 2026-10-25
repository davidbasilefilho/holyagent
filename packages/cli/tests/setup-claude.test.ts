import { describe, expect, test } from "bun:test"

import { Effect, FileSystem, Path } from "effect"

import { setupClaude } from "../src/cmd/setup-claude.ts"
import { envLayer, fakeShell, parseJson, run, tempDir } from "./support.ts"

const options = {
  subagentCacheTtl: "1h",
  dryRun: false,
  skipBillionContext: false,
  skipCtx7: false,
} as const

const pluginList = (ids: ReadonlyArray<string>) => (line: string) =>
  line === "claude plugin list --json"
    ? { stdout: JSON.stringify(ids.map((id) => ({ id, scope: "user" }))) }
    : undefined

describe("holyagent setup claude", () => {
  test("installs the plugin, Billion Context and ctx7, then writes the project settings", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDir
        const directory = yield* tempDir
        const shell = fakeShell({ commands: ["claude", "bun"], respond: pluginList([]) })
        const report = yield* setupClaude({ directory, ...options }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: home })),
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
        const lines = report.lines
        const at = (prefix: string) => lines.findIndex((line) => line.startsWith(prefix))
        expect(at("+ plugin")).toBeLessThan(at("+ bili:"))
        expect(at("+ bili config")).toBeLessThan(at("- ctx7 skill"))
        expect(at("- ctx7 skill")).toBeLessThan(at(directory))
        expect(lines.at(-1)).toBe("added 7")
        expect(
          parseJson(yield* fs.readFileString(path.join(directory, ".claude", "settings.json")))
            .enabledPlugins,
        ).toEqual({ "holyagent@holyagent": true })
      }),
    ))

  test("a second run changes nothing and reports only present items", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDir
        const directory = yield* tempDir
        const file = path.join(directory, ".claude", "settings.json")
        const skip = { ...options, skipBillionContext: true, skipCtx7: true }
        const first = fakeShell({ commands: ["claude"], respond: pluginList([]) })
        yield* setupClaude({ directory, ...skip }).pipe(
          Effect.provide(first.layer),
          Effect.provide(envLayer({ HOME: home })),
        )
        const written = yield* fs.readFileString(file)
        const second = fakeShell({
          commands: ["claude"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const report = yield* setupClaude({ directory, ...skip }).pipe(
          Effect.provide(second.layer),
          Effect.provide(envLayer({ HOME: home })),
        )
        expect(second.lines()).toEqual(["claude plugin list --json"])
        expect(report.lines.some((line) => line.startsWith("+ "))).toBe(false)
        expect(report.lines.at(-1)).toBe("no changes")
        expect(yield* fs.readFileString(file)).toBe(written)
      }),
    ))

  test("--dry-run installs and writes nothing and says what it would do", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* tempDir
        const directory = yield* tempDir
        const shell = fakeShell({ commands: ["claude", "bun"], respond: pluginList([]) })
        const report = yield* setupClaude({ directory, ...options, dryRun: true }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: home })),
        )
        expect(shell.lines()).toEqual(["claude plugin list --json"])
        expect(report.ok).toBe(true)
        expect(report.lines).toContain("+ plugin holyagent@holyagent: would install")
        expect(report.lines.at(-1)).toBe("dry run: would add 7, nothing written")
        expect(yield* fs.exists(`${directory}/.claude`)).toBe(false)
        expect(yield* fs.readDirectory(home)).toEqual([])
      }),
    ))

  test("a failed user step does not stop the project settings, and the report is not ok", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* tempDir
        const directory = yield* tempDir
        const shell = fakeShell({
          commands: ["claude"],
          respond: (line) =>
            line === "claude plugin install holyagent@holyagent"
              ? { exitCode: 1, stderr: "marketplace not found" }
              : pluginList([])(line),
        })
        const report = yield* setupClaude({
          directory,
          ...options,
          skipBillionContext: true,
          skipCtx7: true,
        }).pipe(Effect.provide(shell.layer), Effect.provide(envLayer({ HOME: home })))
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toBe(
          "! claude plugin install: failed (exit 1): marketplace not found",
        )
        expect(report.lines.at(-1)).toBe("added 7")
        expect(yield* fs.exists(`${directory}/.claude/settings.json`)).toBe(true)
      }),
    ))

  test("a project settings file that is not a JSON object is a failed step after the user steps", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const home = yield* tempDir
        const directory = yield* tempDir
        yield* fs.makeDirectory(`${directory}/.claude`)
        yield* fs.writeFileString(`${directory}/.claude/settings.json`, "[1]")
        const shell = fakeShell({
          commands: ["claude"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const report = yield* setupClaude({
          directory,
          ...options,
          skipBillionContext: true,
          skipCtx7: true,
        }).pipe(Effect.provide(shell.layer), Effect.provide(envLayer({ HOME: home })))
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toBe("= plugin holyagent@holyagent: already installed")
        expect(report.lines.at(-1)).toContain("! project settings: ")
        expect(report.lines.at(-1)).toContain("is not a JSON object")
        expect(yield* fs.readFileString(`${directory}/.claude/settings.json`)).toBe("[1]")
      }),
    ))
})
