import { describe, expect, test } from "bun:test"

import { Effect, FileSystem, Path } from "effect"

import { doctor } from "../src/cmd/doctor.ts"
import { setup } from "../src/cmd/setup.ts"
import { fakeShell, run, tempDir } from "./support.ts"

const CANARY = "1.4.4-canary.1+a8fcd319b"
const STABLE = "1.4.4+38afee6c8"
const allTools = ["claude", "bili", "ctx7", "bun"]

const answers = (bun: () => string, plugins: ReadonlyArray<string>) => (line: string) =>
  line === "bun --revision"
    ? { stdout: `${bun()}\n` }
    : line === "claude plugin list --json"
      ? { stdout: JSON.stringify(plugins.map((id) => ({ id }))) }
      : undefined

const configuredProject = Effect.gen(function* () {
  const directory = yield* tempDir
  yield* setup({ directory, subagentCacheTtl: "1h", dryRun: false })
  return directory
})

describe("holyagent doctor", () => {
  test("passes on a configured machine, one line per check", () =>
    run(
      Effect.gen(function* () {
        const directory = yield* configuredProject
        const shell = fakeShell({
          commands: allTools,
          respond: answers(() => CANARY, ["holyagent@holyagent"]),
        })
        const report = yield* doctor({ directory, fix: false }).pipe(Effect.provide(shell.layer))
        expect(report.ok).toBe(true)
        expect(report.lines.map((line) => line.split(":")[0])).toEqual([
          "ok   bun",
          "ok   claude",
          "ok   bili",
          "ok   ctx7",
          "ok   settings",
          "ok   plugin",
        ])
      }),
    ))

  test("a stable Bun fails without --fix and runs nothing to change it", () =>
    run(
      Effect.gen(function* () {
        const directory = yield* configuredProject
        const shell = fakeShell({
          commands: allTools,
          respond: answers(() => STABLE, ["holyagent@holyagent"]),
        })
        const report = yield* doctor({ directory, fix: false }).pipe(Effect.provide(shell.layer))
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toBe(
          `FAIL bun: ${STABLE} is not a canary build; run: holyagent doctor --fix`,
        )
        expect(shell.lines()).not.toContain("bun upgrade --canary")
      }),
    ))

  test("--fix upgrades Bun to canary with BUN_OPTIONS unset, then re-checks", () =>
    run(
      Effect.gen(function* () {
        const directory = yield* configuredProject
        let revision = STABLE
        const shell = fakeShell({
          commands: allTools,
          respond: (line) => {
            if (line === "bun upgrade --canary") revision = CANARY
            return answers(() => revision, ["holyagent@holyagent"])(line)
          },
        })
        const report = yield* doctor({ directory, fix: true }).pipe(Effect.provide(shell.layer))
        const upgrade = shell.calls.find((call) => call.line === "bun upgrade --canary")
        expect(upgrade?.unsetEnv).toEqual(["BUN_OPTIONS"])
        expect(report.ok).toBe(true)
        expect(report.lines[0]).toBe(`ok   bun: ${CANARY} (upgraded from ${STABLE})`)
      }),
    ))

  test("--fix that does not produce a canary build still fails", () =>
    run(
      Effect.gen(function* () {
        const directory = yield* configuredProject
        const shell = fakeShell({
          commands: allTools,
          respond: (line) =>
            line === "bun upgrade --canary"
              ? { exitCode: 1 }
              : answers(() => STABLE, ["holyagent@holyagent"])(line),
        })
        const report = yield* doctor({ directory, fix: true }).pipe(Effect.provide(shell.layer))
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toStartWith("FAIL bun:")
      }),
    ))

  test("reports missing tools, missing settings keys and a missing plugin, and is not ok", () =>
    run(
      Effect.gen(function* () {
        const directory = yield* tempDir
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.join(directory, ".claude"), { recursive: true })
        yield* fs.writeFileString(
          path.join(directory, ".claude", "settings.json"),
          '{"includeGitInstructions":false}',
        )
        const shell = fakeShell({ commands: ["bun", "claude"], respond: answers(() => CANARY, []) })
        const report = yield* doctor({ directory, fix: false }).pipe(Effect.provide(shell.layer))
        expect(report.ok).toBe(false)
        expect(report.lines).toContain("FAIL bili: not found on PATH")
        expect(report.lines).toContain("FAIL ctx7: not found on PATH")
        const settings = report.lines.find((line) => line.startsWith("FAIL settings"))
        expect(settings).toContain("attribution.commit")
        expect(settings).not.toContain("includeGitInstructions")
        expect(settings).toEndWith("run: holyagent setup")
        expect(report.lines.at(-1)).toBe(
          "FAIL plugin: holyagent@holyagent not installed; run: holyagent install",
        )
      }),
    ))

  test("a missing or invalid settings file is a failed settings check, not a crash", () =>
    run(
      Effect.gen(function* () {
        const missing = yield* tempDir
        const shell = fakeShell({
          commands: allTools,
          respond: answers(() => CANARY, ["holyagent@holyagent"]),
        })
        const report = yield* doctor({ directory: missing, fix: false }).pipe(
          Effect.provide(shell.layer),
        )
        expect(report.lines.find((line) => line.startsWith("FAIL settings"))).toContain(
          "run: holyagent setup",
        )
      }),
    ))
})
