import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { $ } from "bun"

import { freshPlugin, ROOT } from "./built.ts"

const root = await Bun.file(
  join(ROOT, "packages/runtime/src/instructions/claude-5.5/root.md"),
).text()

let project: string
let home: string

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "holyagent-hook-project-"))
  home = await mkdtemp(join(tmpdir(), "holyagent-hook-home-"))
})
afterAll(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]),
)

const bundle = join(await freshPlugin, "scripts", "holyagent.js")

/** Runs the built CLI with the text on stdin, as the hooks do. */
const cli = async (args: ReadonlyArray<string>, stdin: string, cwd: string) => {
  const result =
    await $`${process.execPath} --no-env-file ${bundle} ${args} < ${new Response(stdin)}`
      .cwd(cwd)
      .env({ PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home })
      .quiet()
      .nothrow()
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode,
  }
}

/** Runs `holyagent hook <name>` with the payload on stdin; `undefined` is an empty stdin. */
const hook = (name: string, payload: unknown, cwd = project) =>
  cli(
    ["hook", name],
    payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload),
    cwd,
  )

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } })

const preToolUse = (permissionDecision: string, permissionDecisionReason: string) =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason } })}\n`

const COMMIT =
  "Commit with `holyagent vcs commit -m <headline> -- <paths…>`, which commits as the account owner with the Intent's state."
const PUSH = "Push with `holyagent vcs push [branches…]`."

describe("hook vcs-redirect", () => {
  const denied: ReadonlyArray<readonly [string, string]> = [
    ["git commit -m x", COMMIT],
    ["git push", PUSH],
    ["cd a && git push", PUSH],
    ["git status && git commit -m 'a && b'", COMMIT],
    ["git -C repo commit --amend", COMMIT],
    ["git -c user.name=x push origin main", PUSH],
    ["FOO=1 git push origin main", PUSH],
    ["sudo -n git commit -m x", COMMIT],
    ["/usr/bin/git commit -m x", COMMIT],
    ["(cd a; git push)", PUSH],
    ["echo $(git commit -m x)", COMMIT],
    ['echo "$(git push)"', PUSH],
    ["echo `git push`", PUSH],
    ["bash -c 'git push origin main'", PUSH],
    ['sh -lc "cd a && git commit -m x"', COMMIT],
    ["true | git commit -F -", COMMIT],
    ["git commit -m x \\\n  && git push", `${COMMIT} ${PUSH}`],
    ["git commit -m x; git commit -m y; git push", `${COMMIT} ${PUSH}`],
    ["if true; then git push; fi", PUSH],
    ["cat <<EOF\nnotes\nEOF\ngit commit -m x", COMMIT],
  ]
  test.each(denied)("denies %j", async (command, reason) => {
    expect(await hook("vcs-redirect", bash(command))).toEqual({
      stdout: preToolUse("deny", reason),
      stderr: "",
      code: 0,
    })
  })

  const allowedThrough = [
    "git commitizen",
    "git commit-tree abc",
    "git status",
    "git log --oneline -3",
    "git diff HEAD~1",
    "git pushall",
    'echo "git commit"',
    "echo git push",
    "echo 'git push' | cat",
    'grep -r "git commit" docs',
    "# git commit -m x",
    "cat <<'EOF'\ngit commit -m x\ngit push\nEOF",
    "cat <<-EOF\n\tgit push\n\tEOF",
    "holyagent vcs commit -m x -- a.ts",
    "bun test && bun check",
    "",
  ]
  test.each(allowedThrough)("says nothing for %j", async (command) => {
    expect(await hook("vcs-redirect", bash(command))).toEqual({ stdout: "", stderr: "", code: 0 })
  })

  test("ignores a command that is not Bash, or has no command text", async () => {
    const nothing = { stdout: "", stderr: "", code: 0 }
    expect(
      await hook("vcs-redirect", { tool_name: "Edit", tool_input: { command: "git push" } }),
    ).toEqual(nothing)
    expect(await hook("vcs-redirect", { tool_name: "Bash", tool_input: {} })).toEqual(nothing)
    expect(await hook("vcs-redirect", { tool_name: "Bash" })).toEqual(nothing)
  })

  test("fails with exit 1 and a stderr line on a payload it cannot read, never exit 2", async () => {
    for (const payload of ["not json", "[]", undefined]) {
      const result = await hook("vcs-redirect", payload)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toStartWith("holyagent hook vcs-redirect: ")
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1)
    }
  })
})

describe("hook workflow", () => {
  const workflow = (input: Record<string, unknown>) => ({
    tool_name: "Workflow",
    tool_input: input,
  })

  test.each(["run-assignments", "review-diff", "implement-review"])(
    "allows the prebuilt holyagent:%s by name",
    async (name) => {
      expect(
        await hook("workflow", workflow({ name: `holyagent:${name}`, args: { pairs: [] } })),
      ).toEqual({
        stdout: preToolUse("allow", `Prebuilt workflow holyagent:${name} of the holyagent plugin.`),
        stderr: "",
        code: 0,
      })
    },
  )

  const NOTHING = { stdout: "", stderr: "", code: 0 }
  test.each<readonly [string, Record<string, unknown>]>([
    ["another plugin's workflow", { name: "other:run-assignments" }],
    ["an unknown holyagent workflow", { name: "holyagent:validate-criteria" }],
    ["the bare name", { name: "run-assignments" }],
    ["a name with a suffix", { name: "holyagent:run-assignments-x" }],
    ["an inline script", { script: "export const meta = {}" }],
    ["our name with an inline script", { name: "holyagent:review-diff", script: "return 1" }],
    ["our name with a script path", { name: "holyagent:review-diff", scriptPath: "/tmp/x.js" }],
    ["our name with a resume", { name: "holyagent:review-diff", resumeFromRunId: "run-1" }],
    ["a run id alone", { runId: "run-1" }],
    ["no name", { args: [] }],
    ["a name that is not text", { name: ["holyagent:review-diff"] }],
  ])("says nothing for %s", async (_label, input) => {
    expect(await hook("workflow", workflow(input))).toEqual(NOTHING)
  })

  test("says nothing for another tool, and fails closed on an unreadable payload", async () => {
    expect(
      await hook("workflow", { tool_name: "Bash", tool_input: { name: "holyagent:review-diff" } }),
    ).toEqual(NOTHING)
    expect((await hook("workflow", "{")).code).toBe(1)
  })
})

describe("hook session-start", () => {
  const start = (agent_type?: string) => ({
    hook_event_name: "SessionStart",
    source: "startup",
    ...(agent_type === undefined ? {} : { agent_type }),
  })
  const context = (additionalContext: string) =>
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`

  test("prints nothing in a project without a .holyagent folder, whatever the agent", async () => {
    for (const agent of [undefined, "holyagent", "other"])
      expect(await hook("session-start", start(agent))).toEqual({ stdout: "", stderr: "", code: 0 })
  })

  test("adds the status, and the root rules only when the root is not the main thread", async () => {
    const stated = await mkdtemp(join(tmpdir(), "holyagent-hook-state-"))
    try {
      const created = await cli(["intent", "create"], '{"objective":"Ship it"}', stated)
      expect(created.code).toBe(0)
      const status = await cli(["status"], "", stated)
      const state = `holyagent status:\n${status.stdout.trimEnd()}`
      expect(state).toContain("Ship it")

      for (const agent of ["holyagent", "holyagent:holyagent"])
        expect(await hook("session-start", start(agent), stated)).toEqual({
          stdout: context(state),
          stderr: "",
          code: 0,
        })
      for (const agent of [undefined, "general-purpose"])
        expect(await hook("session-start", start(agent), stated)).toEqual({
          stdout: context(`${root.trim()}\n\n${state}`),
          stderr: "",
          code: 0,
        })
    } finally {
      await rm(stated, { recursive: true, force: true })
    }
  })

  test("an unreadable state is a visible failure, exit 1 with one stderr line", async () => {
    const broken = await mkdtemp(join(tmpdir(), "holyagent-hook-broken-"))
    try {
      const file = join(broken, ".holyagent", "intents", "x-intent-1", "intent.json")
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, "{ not json")
      const result = await hook("session-start", start("holyagent"), broken)
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toStartWith("holyagent hook session-start: ")
      expect(result.stderr.trimEnd().split("\n")).toHaveLength(1)
    } finally {
      await rm(broken, { recursive: true, force: true })
    }
  })
})

const wrapper = join(await freshPlugin, "scripts", "holyagent")

describe("the built wrapper", () => {
  const BUN = dirname(process.execPath)

  const call = async (name: string, payload: unknown, env: Record<string, string>) => {
    const result = await $`${wrapper} hook ${name} < ${new Response(JSON.stringify(payload))}`
      .cwd(project)
      .env(env)
      .quiet()
      .nothrow()
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    }
  }

  test("runs each hook through the bundle", async () => {
    const env = { PATH: `${BUN}:/usr/bin:/bin`, HOME: home }
    expect(await call("vcs-redirect", bash("cd a && git push"), env)).toEqual({
      code: 0,
      stdout: preToolUse("deny", PUSH),
      stderr: "",
    })
    expect(
      await call(
        "workflow",
        { tool_name: "Workflow", tool_input: { name: "holyagent:review-diff" } },
        env,
      ),
    ).toMatchObject({
      code: 0,
      stdout: preToolUse(
        "allow",
        "Prebuilt workflow holyagent:review-diff of the holyagent plugin.",
      ),
    })
    expect(await call("session-start", { agent_type: "holyagent" }, env)).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    })
  })

  test("the project's .env and bunfig.toml cannot change the CLI", async () => {
    const hostile = await mkdtemp(join(tmpdir(), "holyagent-hook-hostile-"))
    try {
      await writeFile(join(hostile, "bunfig.toml"), 'preload = ["./evil.ts"]\n')
      await writeFile(join(hostile, "evil.ts"), 'console.log("PRELOADED")\n')
      await writeFile(join(hostile, ".env"), "HOME=/nonexistent\n")
      const result = await $`${wrapper} hook workflow < ${new Response('{"tool_name":"Bash"}')}`
        .cwd(hostile)
        .env({ PATH: `${BUN}:/usr/bin:/bin`, HOME: home })
        .quiet()
        .nothrow()
      expect(result.exitCode).toBe(0)
      expect(result.stdout.toString()).toBe("")
    } finally {
      await rm(hostile, { recursive: true, force: true })
    }
  })

  test("without Bun it says so on stderr and exits 127, hooks included, never 0", async () => {
    const empty = await mkdtemp(join(tmpdir(), "holyagent-hook-nobun-"))
    try {
      for (const args of [["hook", "session-start"], ["hook", "vcs-redirect"], ["status"]]) {
        const result = await $`/bin/sh ${wrapper} ${args}`
          .cwd(project)
          .env({ PATH: empty, HOME: empty })
          .quiet()
          .nothrow()
        expect(result.exitCode).toBe(127)
        expect(result.stdout.toString()).toBe("")
        expect(result.stderr.toString()).toStartWith("error: BunMissing: ")
        expect(result.stderr.toString()).toContain("hint: Install Bun from https://bun.sh")
      }
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
