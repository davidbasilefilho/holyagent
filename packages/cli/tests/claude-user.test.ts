import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"

import { Effect, FileSystem, Path } from "effect"

import { homeDirectory, setupUser } from "../src/claude/user.ts"
import { envLayer, fakeShell, run, tempDir } from "./support.ts"

const everything = { skipCtx7: false, dryRun: false }
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
  const markCtx7Skill = Effect.all([
    write(".claude/skills/find-docs/SKILL.md", "x"),
    write(".claude/rules/context7.md", "x"),
  ])
  return { root, write, markCtx7Skill }
})

describe("holyagent setup claude: user installs", () => {
  test("on a fresh machine installs everything in order and skips the unauthenticated ctx7 skill", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({ commands: ["claude", "bun"], respond: pluginList([]) })
        const report = yield* setupUser(everything).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual([
          "claude plugin list --json",
          "claude plugin marketplace list --json",
          "claude plugin marketplace add davidbasilefilho/holyagent",
          "claude plugin install holyagent@holyagent",
          "bun add -g ctx7",
        ])
        expect(report.ok).toBe(true)
        expect(report.lines.filter((line) => line.startsWith("- "))).toEqual([
          "- ctx7 skill: no CONTEXT7_API_KEY and no saved login; run `ctx7 login` or export CONTEXT7_API_KEY, then re-run",
        ])
      }),
    ))

  test("when everything is installed it only reads the plugin list and changes nothing", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.markCtx7Skill
        const shell = fakeShell({
          commands: ["claude", "bun", "ctx7"],
          respond: pluginList(["holyagent@holyagent", "other@market"]),
        })
        const report = yield* setupUser(everything).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual(["claude plugin list --json"])
        expect(report.ok).toBe(true)
        expect(report.lines.every((line) => line.startsWith("= "))).toBe(true)
      }),
    ))

  test("installs the Claude plugin when it is missing from the installed plugins", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({
          commands: ["claude"],
          respond: pluginList(["other@market"]),
        })
        yield* setupUser({ skipCtx7: true, dryRun: false }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual([
          "claude plugin list --json",
          "claude plugin marketplace list --json",
          "claude plugin marketplace add davidbasilefilho/holyagent",
          "claude plugin install holyagent@holyagent",
        ])
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
        const report = yield* setupUser({ skipCtx7: true, dryRun: false }).pipe(
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

  test("without HOME the home directory is USERPROFILE, else the operating system's; an empty CONTEXT7_API_KEY counts as unset", () =>
    run(
      Effect.gen(function* () {
        expect(
          yield* homeDirectory.pipe(Effect.provide(envLayer({ USERPROFILE: "C:\\Users\\me" }))),
        ).toBe("C:\\Users\\me")
        expect(
          yield* homeDirectory.pipe(Effect.provide(envLayer({ HOME: "/h", USERPROFILE: "/u" }))),
        ).toBe("/h")
        expect(
          yield* homeDirectory.pipe(Effect.provide(envLayer({ HOME: "", USERPROFILE: "/u" }))),
        ).toBe("/u")
        expect(yield* homeDirectory.pipe(Effect.provide(envLayer({})))).toBe(homedir())

        const emptyKeyShell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const emptyKey = yield* setupUser({ skipCtx7: false, dryRun: false }).pipe(
          Effect.provide(emptyKeyShell.layer),
          Effect.provide(envLayer({ HOME: (yield* home).root, CONTEXT7_API_KEY: "" })),
        )
        expect(emptyKey.ok).toBe(true)
        expect(emptyKey.lines.at(-1)).toStartWith("- ctx7 skill: no CONTEXT7_API_KEY")
        expect(emptyKeyShell.lines()).toEqual(["claude plugin list --json"])
      }),
    ))

  test("the skip flag leaves ctx7 alone", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({
          commands: ["claude"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const report = yield* setupUser({ skipCtx7: true, dryRun: false }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual(["claude plugin list --json"])
        expect(report.lines).toContain("- ctx7: skipped by flag")
      }),
    ))

  test("ctx7 setup uses CONTEXT7_API_KEY, else a saved login, else is skipped", () =>
    run(
      Effect.gen(function* () {
        const setupLine = (calls: ReadonlyArray<string>) =>
          calls.find((line) => line.startsWith("ctx7 setup"))
        const options = { skipCtx7: false, dryRun: false }
        const withKey = yield* home
        const keyShell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        yield* setupUser(options).pipe(
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
        yield* setupUser(options).pipe(
          Effect.provide(loginShell.layer),
          Effect.provide(envLayer({ HOME: withLogin.root })),
        )
        expect(setupLine(loginShell.lines())).toBe("ctx7 setup --cli --claude --yes")

        const bare = yield* home
        const bareShell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        yield* setupUser(options).pipe(
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
        const report = yield* setupUser({ skipCtx7: false, dryRun: false }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toBe(
          "! claude plugin marketplace add davidbasilefilho/holyagent: failed (exit 1): network down",
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
        const report = yield* setupUser({ skipCtx7: true, dryRun: false }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(report.ok).toBe(false)
        expect(report.lines[0]).toContain("`claude` not found")
        expect(shell.lines()).toEqual([])
      }),
    ))

  test("--dry-run says what it would install and runs nothing that changes the machine", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        yield* h.markCtx7Skill
        const shell = fakeShell({ commands: ["claude", "bun"], respond: pluginList([]) })
        const report = yield* setupUser({ ...everything, dryRun: true }).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(shell.lines()).toEqual(["claude plugin list --json"])
        expect(report.ok).toBe(true)
        expect(report.lines).toEqual([
          "+ plugin holyagent@holyagent: would install",
          "+ ctx7: would install with bun add -g ctx7",
          "= ctx7 skill: already installed",
        ])
      }),
    ))

  test("--dry-run would install the ctx7 skill only when a key or login exists", () =>
    run(
      Effect.gen(function* () {
        const h = yield* home
        const shell = fakeShell({
          commands: ["claude", "ctx7"],
          respond: pluginList(["holyagent@holyagent"]),
        })
        const options = { skipCtx7: false, dryRun: true }
        const keyed = yield* setupUser(options).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root, CONTEXT7_API_KEY: "ctx7sk-test" })),
        )
        expect(keyed.lines.at(-1)).toBe(
          "+ ctx7 skill: would install with ctx7 setup --cli --claude",
        )
        const bare = yield* setupUser(options).pipe(
          Effect.provide(shell.layer),
          Effect.provide(envLayer({ HOME: h.root })),
        )
        expect(bare.lines.at(-1)).toStartWith("- ctx7 skill: no CONTEXT7_API_KEY")
        expect(shell.lines().every((line) => line === "claude plugin list --json")).toBe(true)
      }),
    ))
})
