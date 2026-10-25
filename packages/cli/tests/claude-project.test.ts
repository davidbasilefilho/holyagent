import { describe, expect, test } from "bun:test"

import { Effect, FileSystem, Path } from "effect"

import { setupProject } from "../src/claude/project.ts"
import { parseJson, run, tempDir } from "./support.ts"

const defaults = { subagentCacheTtl: "1h", dryRun: false } as const

const project = (existing?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* tempDir
    const file = path.join(directory, ".claude", "settings.json")
    if (existing !== undefined) {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, existing)
    }
    return { directory, file, read: fs.readFileString(file), exists: fs.exists(file) }
  })

describe("holyagent setup claude: project settings", () => {
  test("creates the settings file in an empty project", () =>
    run(
      Effect.gen(function* () {
        const { directory, file, read } = yield* project()
        const report = yield* setupProject({ directory, ...defaults })
        const text = yield* read
        expect(report.ok).toBe(true)
        expect(report.lines.at(-1)).toBe("added 8")
        expect(text.endsWith("}\n")).toBe(true)
        expect(text).toContain('\n  "attribution": {')
        expect(parseJson(text)).toEqual({
          attribution: { commit: "", pr: "", sessionUrl: false },
          includeGitInstructions: false,
          subagentPromptCacheTtl: "1h",
          extraKnownMarketplaces: {
            holyagent: { source: { source: "github", repo: "davidbasilefilho/holyagent" } },
            "billion-context": {
              source: { source: "github", repo: "ranxianglei/billion-context" },
            },
          },
          enabledPlugins: { "holyagent@holyagent": true },
        })
        expect(report.lines[0]).toBe(file)
      }),
    ))

  test("honors --subagent-cache-ttl when the key is missing", () =>
    run(
      Effect.gen(function* () {
        const { directory, read } = yield* project()
        yield* setupProject({ directory, subagentCacheTtl: "5m", dryRun: false })
        expect(parseJson(yield* read).subagentPromptCacheTtl).toBe("5m")
      }),
    ))

  test("keeps every existing value, even when it conflicts", () =>
    run(
      Effect.gen(function* () {
        const existing = {
          model: "opus",
          includeGitInstructions: true,
          subagentPromptCacheTtl: "5m",
          attribution: false,
          extraKnownMarketplaces: { other: { source: { source: "github", repo: "a/b" } } },
          enabledPlugins: { "holyagent@holyagent": false, "x@y": true },
        }
        const { directory, read } = yield* project(JSON.stringify(existing))
        const report = yield* setupProject({ directory, ...defaults })
        const result = parseJson(yield* read)
        expect(result).toEqual({
          ...existing,
          extraKnownMarketplaces: {
            ...existing.extraKnownMarketplaces,
            holyagent: { source: { source: "github", repo: "davidbasilefilho/holyagent" } },
            "billion-context": {
              source: { source: "github", repo: "ranxianglei/billion-context" },
            },
          },
        })
        expect(report.lines).toContain("~ includeGitInstructions: kept true (recommended false)")
        expect(report.lines).toContain('~ subagentPromptCacheTtl: kept "5m" (recommended "1h")')
        expect(report.lines).toContain('~ attribution: kept false (recommended "")')
        expect(report.lines).toContain(
          "~ enabledPlugins.holyagent@holyagent: kept false (recommended true)",
        )
        expect(report.lines.at(-1)).toBe("added 2")
      }),
    ))

  test("adds only the missing attribution keys", () =>
    run(
      Effect.gen(function* () {
        const { directory, read } = yield* project(
          JSON.stringify({ attribution: { commit: "Co-Authored-By: me", extra: 1 } }),
        )
        const report = yield* setupProject({ directory, ...defaults })
        expect(parseJson(yield* read).attribution).toEqual({
          commit: "Co-Authored-By: me",
          extra: 1,
          pr: "",
          sessionUrl: false,
        })
        expect(report.lines).toContain(
          '~ attribution.commit: kept "Co-Authored-By: me" (recommended "")',
        )
        expect(report.lines).toContain('+ attribution.pr: added ""')
      }),
    ))

  test("a second run reports no changes and leaves the file byte-identical", () =>
    run(
      Effect.gen(function* () {
        const { directory, read } = yield* project()
        yield* setupProject({ directory, ...defaults })
        const first = yield* read
        const report = yield* setupProject({ directory, ...defaults })
        expect(report.lines.at(-1)).toBe("no changes")
        expect(report.lines.some((line) => line.startsWith("+ "))).toBe(false)
        expect(yield* read).toBe(first)
      }),
    ))

  test("a file with nothing to add is not rewritten, whatever its formatting", () =>
    run(
      Effect.gen(function* () {
        const { directory, read } = yield* project()
        yield* setupProject({ directory, ...defaults })
        const compact = JSON.stringify(parseJson(yield* read))
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.writeFileString(path.join(directory, ".claude", "settings.json"), compact)
        yield* setupProject({ directory, ...defaults })
        expect(yield* read).toBe(compact)
      }),
    ))

  test("--dry-run reports the additions and writes nothing", () =>
    run(
      Effect.gen(function* () {
        const empty = yield* project()
        const dry = yield* setupProject({
          directory: empty.directory,
          subagentCacheTtl: "1h",
          dryRun: true,
        })
        expect(dry.lines.at(-1)).toBe("dry run: would add 8, nothing written")
        expect(yield* empty.exists).toBe(false)

        const existing = yield* project('{"model":"opus"}')
        yield* setupProject({ directory: existing.directory, subagentCacheTtl: "1h", dryRun: true })
        expect(yield* existing.read).toBe('{"model":"opus"}')
      }),
    ))

  test("refuses a settings file that is not a JSON object and leaves it alone", () =>
    run(
      Effect.gen(function* () {
        for (const content of ["[1]", '{"a":', ""]) {
          const { directory, read } = yield* project(content)
          const error = yield* setupProject({ directory, ...defaults }).pipe(Effect.flip)
          expect(error._tag).toBe("CliFailure")
          expect(error.message).toContain("is not a JSON object")
          expect(yield* read).toBe(content)
        }
      }),
    ))

  test("a write keeps the file's permissions", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const { directory, file } = yield* project('{"model":"opus"}')
        yield* fs.chmod(file, 0o600)
        yield* setupProject({ directory, ...defaults })
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600)
      }),
    ))

  test("a symlinked settings file stays a symlink and its target gets the keys", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { directory, file } = yield* project()
        const shared = path.join(yield* tempDir, "shared-settings.json")
        yield* fs.writeFileString(shared, '{"model":"opus"}')
        yield* fs.makeDirectory(path.dirname(file), { recursive: true })
        yield* fs.symlink(shared, file)
        yield* setupProject({ directory, ...defaults })
        expect((yield* fs.lstat(file)).type).toBe("SymbolicLink")
        expect(parseJson(yield* fs.readFileString(shared))).toMatchObject({
          model: "opus",
          includeGitInstructions: false,
        })
      }),
    ))

  test("a leftover temporary file is never overwritten", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { directory, file, read } = yield* project('{"model":"opus"}')
        const temporary = path.join(path.dirname(file), `.settings.json.${process.pid}.tmp`)
        yield* fs.writeFileString(temporary, "keep")
        const error = yield* setupProject({ directory, ...defaults }).pipe(Effect.flip)
        expect(error.message).toContain("cannot write")
        expect(yield* fs.readFileString(temporary)).toBe("keep")
        expect(yield* read).toBe('{"model":"opus"}')
      }),
    ))
})
