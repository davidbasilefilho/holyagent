import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { $ } from "bun"

import { completeSetup } from "../../../runtime/tests/setup-fixture.ts"
import { cleanup, GIT_ENV, initRepo, seed, sh } from "../../../runtime/tests/vcs-fixtures.ts"
import { freshPlugin } from "./built.ts"
import { BUN_FOLDER, pathEnv, systemEnv } from "./host.ts"

// These tests run real processes against locks that live processes hold, so that the agent-launch
// hook is seen to stop waiting on its own inside the 10 second timeout the host kills it at.

let home: string
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "holyagent-hook-locks-home-"))
  await completeSetup(home)
})
afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await cleanup()
})

const bundle = join(await freshPlugin, "scripts", "holyagent.js")
const env = () => ({ ...GIT_ENV, ...pathEnv([BUN_FOLDER]), ...systemEnv(), HOME: home })

/** Runs the built CLI with the text on stdin, as the hooks do, and times it. */
const cli = async (args: ReadonlyArray<string>, stdin: string, cwd: string) => {
  const started = Date.now()
  const result =
    await $`${process.execPath} --no-env-file ${bundle} ${args} < ${new Response(stdin)}`
      .cwd(cwd)
      .env(env())
      .quiet()
      .nothrow()
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    code: result.exitCode,
    ms: Date.now() - started,
  }
}

/**
 * The agent-launch hook as the host runs it: the command, arguments and timeout of `hooks.json`,
 * killed when the timeout expires. Bun's shell cannot kill a process on a timeout, so this spawns
 * directly.
 */
const hostRun = async (stdin: string, cwd: string) => {
  const plugin = await freshPlugin
  const file = (await Bun.file(join(plugin, "hooks", "hooks.json")).json()) as {
    hooks: Record<
      string,
      Array<{
        matcher?: string
        hooks: Array<{ args: Array<string>; timeout: number }>
      }>
    >
  }
  const registered = file.hooks.PostToolUse?.find((entry) => entry.matcher === "Agent")?.hooks.find(
    (candidate) => candidate.args.includes("agent-launch"),
  )
  if (registered === undefined) throw new Error("hooks.json registers no agent-launch hook")
  const started = Date.now()
  const child = Bun.spawn(
    [
      process.execPath,
      ...registered.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", plugin)),
    ],
    {
      cwd,
      env: env(),
      stdin: new Response(stdin),
      stdout: "pipe",
      stderr: "pipe",
      timeout: registered.timeout * 1000,
      killSignal: "SIGKILL",
    },
  )
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return {
    stdout,
    stderr,
    code: child.exitCode,
    killed: child.signalCode !== null,
    timeoutMs: registered.timeout * 1000,
    ms: Date.now() - started,
  }
}

const WRITER = {
  roleTask: "Worker.implementation",
  objective: "Build the parser",
  criteria: [{ text: "parses", blocking: true, dimension: "behavior" }],
  ownershipPaths: ["src/parser.ts"],
}

/** A repository with an Intent and one dispatched Assignment, in the state mode `mode`. */
const project = async (mode: "branch" | "local") => {
  const dir = await initRepo()
  await seed(dir, { "a.txt": "a\n" })
  if (mode === "local") await sh(dir, ["git", "config", "holyagent.stateMode", "local"])
  expect((await cli(["intent", "create"], '{"objective":"Ship it"}', dir)).code).toBe(0)
  const { stdout } = await cli(["assignment", "dispatch"], JSON.stringify(WRITER), dir)
  const [fields = "", prompt = ""] = stdout.split("\nprompt:\n")
  const id = /^id: (\S+)$/m.exec(fields)?.[1] ?? ""
  expect(id).not.toBe("")
  return { dir, id, prompt: prompt.replace(/\n$/, "") }
}

const launch = (prompt: string, agentId: string) =>
  JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: "holyagent:worker-implementation", prompt },
    tool_response: { isAsync: true, status: "async_launched", agentId, prompt },
  })

/** The files below `folder` matching `pattern`. */
const filesIn = async (folder: string, pattern: string) =>
  (await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: folder, onlyFiles: true }))).map(
    (name) => join(folder, name),
  )

/** A lock file of this live test process, taken just now, so that a contender keeps waiting. */
const holdLock = (file: string) =>
  Bun.write(file, JSON.stringify({ pid: process.pid, token: "held", acquiredAt: Date.now() }))

/** The state lock of a project: the one file that every write of its records takes. */
const stateLockOf = async (dir: string, mode: "branch" | "local") => {
  if (mode === "local") return join(dir, ".holyagent", "local", "lock")
  const [marker = ""] = await filesIn(
    join(dir, ".git", "holyagent"),
    "holyagent-state-*/.holyagent/local/.gitignore",
  )
  expect(marker).not.toBe("")
  return join(dirname(marker), "lock")
}

describe("agent-launch hook and CLI processes contending for the state lock", () => {
  test("each finishes or fails with StateLocked inside its wait, and the state stays whole", async () => {
    const { dir, id, prompt } = await project("branch")
    const lock = await stateLockOf(dir, "branch")
    // The lock is held for 2 seconds while all six processes queue for it.
    await holdLock(lock)
    const release = setTimeout(() => void Bun.file(lock).delete(), 2000)

    const created = [1, 2, 3].map((n) =>
      cli(["intent", "create"], JSON.stringify({ objective: `Contended ${n}` }), dir),
    )
    const hooks = [1, 2, 3].map((n) => hostRun(launch(prompt, `agent-${n}`), dir))
    const [creates, launches] = await Promise.all([Promise.all(created), Promise.all(hooks)])
    clearTimeout(release)

    // A CLI command waits up to 30 seconds and a hook 5, so none can fail for a lock held 2.
    for (const result of creates) {
      expect(result.code).toBe(0)
      expect(result.ms).toBeLessThan(30_000)
    }
    for (const result of launches) {
      expect(result.killed).toBe(false)
      expect(result.code).toBe(0)
      expect(result.ms).toBeLessThan(result.timeoutMs - 1500)
      // It recorded the launch or handed it back; it neither failed nor hung.
      expect(result.stdout).toMatch(
        /recorded agent agent-\d for|could not record the launch of .* \(StateLocked\)/,
      )
    }

    // No write was lost or half made: every Intent that was created is listed, and the records are
    // all committed on the state branch, so the state worktree is clean apart from local files.
    expect((await cli(["intent", "list"], "", dir)).stdout.match(/Contended \d/g)).toHaveLength(3)
    const shown = await cli(["assignment", "show", id, "--full"], "", dir)
    expect(shown.code).toBe(0)
    const recorded = launches.filter((result) => result.stdout.includes("recorded agent")).length
    // The lock is unfair, so the CLI commands may keep it past every hook's wait: a hook need not
    // have recorded, but one that did left its agent in the Assignment.
    if (recorded > 0) expect(shown.stdout).toMatch(/agent: agent-\d/)
    expect(await sh(dirname(dirname(lock)), ["git", "status", "--porcelain"])).toBe("")
  }, 90_000)
})

describe("the agent-launch hook under the host's kill", () => {
  const locks = {
    branch: async (dir: string) => {
      // The ready and migration markers are gone, as for the first hook of a work tree, so the hook
      // takes the worktree lock and then the state lock for the migration and again for the record.
      const own = join(dir, ".git", "holyagent")
      const markers = [
        ...(await filesIn(own, "*.ready")),
        ...(await filesIn(join(own, "migrated"), "*")),
      ]
      expect(markers).toHaveLength(2)
      await Promise.all(markers.map((marker) => Bun.file(marker).delete()))
      return join(own, "worktree.lock")
    },
    local: async (dir: string) => {
      // The clone's exclude file has lost the entry, so the hook takes the exclude lock to add it.
      await Bun.write(join(dir, ".git", "info", "exclude"), "")
      return join(dir, ".git", "holyagent", "exclude.lock")
    },
  } as const

  test.each(["branch", "local"] as const)(
    "exits by itself with the StateLocked hand-back in the %s mode while every lock on its path is held",
    async (mode) => {
      const { dir, id, prompt } = await project(mode)
      const first = await locks[mode](dir)
      const state = await stateLockOf(dir, mode)
      // The first lock of the path is let go after 1.5 seconds, so the hook moves on to the state
      // lock, which is held for good; only the deadline can end its wait.
      await Promise.all([holdLock(first), holdLock(state)])
      const release = setTimeout(() => void Bun.file(first).delete(), 1500)

      const result = await hostRun(launch(prompt, "agent-1"), dir)
      clearTimeout(release)

      expect(result.killed).toBe(false)
      expect(result.code).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain(`could not record the launch of ${id} (StateLocked)`)
      // It waited for the locks it was denied, then stopped well before the host's kill.
      expect(result.ms).toBeGreaterThanOrEqual(4000)
      expect(result.ms).toBeLessThan(result.timeoutMs - 2000)
      await Bun.file(state).delete()
      expect((await cli(["assignment", "show", id, "--full"], "", dir)).stdout).not.toContain(
        "agent-1",
      )
    },
    60_000,
  )
})
