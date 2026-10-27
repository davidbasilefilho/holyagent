import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { claudeConfigDirectory, workflowsAvailable } from "../src/cli/config.ts"
import { fromGitPath, toPosix } from "../src/domain/paths.ts"
import { globBelow } from "../src/state/store.ts"
import { commitScope } from "../src/vcs/commit.ts"

// There is no Windows machine behind these tests: the separator is a parameter, so a test can stand
// in for it, and the glob test shows on any platform what a backslash pattern does.

const WINDOWS = "\\"

describe("toPosix and fromGitPath", () => {
  test("a Windows path becomes git's form, and git's form becomes a Windows path", () => {
    expect(toPosix("intents\\x-1\\assignments", WINDOWS)).toBe("intents/x-1/assignments")
    expect(fromGitPath("C:/Users/me/repo/.git", WINDOWS)).toBe("C:\\Users\\me\\repo\\.git")
  })

  test("on a POSIX separator both return the path unchanged, a backslash included", () => {
    expect(toPosix("a/b\\c", "/")).toBe("a/b\\c")
    expect(fromGitPath("/home/me/repo/.git", "/")).toBe("/home/me/repo/.git")
  })

  test("the default separator is the platform's", () => {
    expect(toPosix(join("a", "b", "c"))).toBe("a/b/c")
    expect(fromGitPath("a/b")).toBe(join("a", "b"))
  })
})

describe("glob patterns for the state folder", () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "holyagent-glob-"))
    await mkdir(join(root, "intents", "x-1", "assignments"), { recursive: true })
    await writeFile(join(root, "intents", "x-1", "assignments", "a.json"), "{}")
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const scan = (pattern: string) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }))

  test("a folder with Windows separators is written with slashes, so the glob finds the file", async () => {
    const folder = "intents\\x-1"
    expect(globBelow(folder, "assignments/*.json", WINDOWS)).toBe("intents/x-1/assignments/*.json")
    expect(await scan(globBelow(folder, "assignments/*.json", WINDOWS))).toHaveLength(1)
  })

  test("the pattern a Windows join() would give reads backslashes as escapes and finds nothing", async () => {
    expect(await scan("intents\\x-1\\assignments/*.json")).toEqual([])
  })
})

describe("commit scope", () => {
  const scope = (paths: ReadonlyArray<string>, separator = WINDOWS) =>
    Effect.runPromise(commitScope(paths, separator))

  test("paths relative() gave with Windows separators name the same files as git's", async () => {
    expect(await scope(["src\\a.ts", "packages\\runtime\\", "README.md"])).toEqual([
      "src/a.ts",
      "packages/runtime",
      "README.md",
    ])
  })

  test("a backslash is still refused where it is not the separator", async () => {
    const failure = await Effect.runPromise(Effect.flip(commitScope(["src\\a.ts"], "/")))
    expect(failure.message).toContain("character that is not portable")
  })

  test("Intent state is refused in either spelling", async () => {
    for (const path of [".holyagent\\intents", ".holyagent/intents"]) {
      const failure = await Effect.runPromise(Effect.flip(commitScope([path], WINDOWS)))
      expect(failure.message).toContain("Intent state")
    }
  })

  test("an absolute Windows path is refused", async () => {
    const failure = await Effect.runPromise(Effect.flip(commitScope(["C:\\repo\\a.ts"], WINDOWS)))
    expect(failure.message).toContain("Invalid path")
  })
})

describe("the user's Claude Code settings folder", () => {
  test("CLAUDE_CONFIG_DIR wins, then HOME, then USERPROFILE, then the operating system's home", () => {
    expect(claudeConfigDirectory({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/h" })).toBe("/cfg")
    expect(claudeConfigDirectory({ HOME: "/h", USERPROFILE: "/u" })).toBe(join("/h", ".claude"))
    expect(claudeConfigDirectory({ USERPROFILE: "C:\\Users\\me" })).toBe(
      join("C:\\Users\\me", ".claude"),
    )
    expect(claudeConfigDirectory({})).toBe(join(homedir(), ".claude"))
    expect(claudeConfigDirectory({ HOME: "", CLAUDE_CONFIG_DIR: "" }, () => "/fallback")).toBe(
      join("/fallback", ".claude"),
    )
  })

  test("workflows are read as disabled from the user's settings when HOME is missing", async () => {
    const config = await mkdtemp(join(tmpdir(), "holyagent-claude-config-"))
    const project = await mkdtemp(join(tmpdir(), "holyagent-claude-project-"))
    try {
      await writeFile(join(config, "settings.json"), '{"disableWorkflows":true}')
      expect(
        await Effect.runPromise(workflowsAvailable({ CLAUDE_CONFIG_DIR: config }, project)),
      ).toBe(false)
      expect(await Effect.runPromise(workflowsAvailable({ USERPROFILE: config }, project))).toBe(
        true,
      )
      await mkdir(join(config, ".claude"))
      await writeFile(join(config, ".claude", "settings.json"), '{"enableWorkflows":false}')
      expect(await Effect.runPromise(workflowsAvailable({ USERPROFILE: config }, project))).toBe(
        false,
      )
    } finally {
      await Promise.all([
        rm(config, { recursive: true, force: true }),
        rm(project, { recursive: true, force: true }),
      ])
    }
  })
})
