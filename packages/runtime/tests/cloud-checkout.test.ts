import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { rm } from "node:fs/promises"
import { join } from "node:path"

import { cleanup, fakeGitHub, initRepo, put, scratch, seed, sh, toon, vcs } from "./vcs-fixtures.ts"

// Each case runs a handful of git processes and the CLI in-process, slow on a Windows runner.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))
afterEach(cleanup)

const CLOUD = { CLAUDE_CODE_REMOTE: "true" }
const NOTICE = "primary checkout of this cloud session is on a detached HEAD"

/** A repository whose primary checkout starts on the assigned branch, with an Intent for the status. */
const session = async (branch = "claude/quiet-fox") => {
  const dir = await initRepo()
  await sh(dir, ["git", "checkout", "-q", "-b", branch])
  await seed(dir, { "a.txt": "a\n" })
  const created = await vcs(dir, ["intent", "create"], fakeGitHub().layer, {
    objective: "Ship it",
  })
  expect(created.code).toBe(0)
  return dir
}

const status = async (cwd: string, env: Record<string, string>) =>
  toon(await vcs(cwd, ["status"], fakeGitHub().layer, undefined, env))

const started = async (cwd: string, env: Record<string, string>) => {
  const result = await vcs(
    cwd,
    ["hook", "session-start"],
    fakeGitHub().layer,
    { hook_event_name: "SessionStart", source: "startup", cwd },
    env,
  )
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
  return result.stdout === ""
    ? ""
    : (JSON.parse(result.stdout) as { hookSpecificOutput: { additionalContext: string } })
        .hookSpecificOutput.additionalContext
}

/** Detaches HEAD at a new commit, as a checkout of a commit to review or a stray commit would. */
const detach = async (dir: string) => {
  await sh(dir, ["git", "checkout", "-q", "--detach"])
  await seed(dir, { "b.txt": "b\n" })
}

describe("the notice of a detached primary checkout in a cloud session", () => {
  test("shows in the status and the session start, naming the branch the checkout started on", async () => {
    const dir = await session()
    expect(await status(dir, CLOUD)).not.toHaveProperty("notice")
    expect(await started(dir, CLOUD)).not.toContain(NOTICE)

    await detach(dir)
    const shown = await status(dir, CLOUD)
    expect(String(shown.notice)).toContain(NOTICE)
    expect(String(shown.notice)).toContain("`git switch claude/quiet-fox`")
    expect(String(shown.notice)).toContain("git worktree")
    expect(String(shown.notice)).not.toContain("\n")

    const context = await started(dir, CLOUD)
    expect(context).toContain(NOTICE)
    expect(context).toContain("`git switch claude/quiet-fox`")
    expect(context.split(NOTICE)).toHaveLength(2)
  })

  test("names the default branch when the reflog does not say where the checkout started", async () => {
    const dir = await session()
    await detach(dir)
    await rm(join(dir, ".git", "logs", "HEAD"))
    expect(String((await status(dir, CLOUD)).notice)).toContain("`git switch main`")
  })

  test("is not shown for a checkout on a branch", async () => {
    const dir = await session()
    await sh(dir, ["git", "switch", "-q", "-c", "release/0.3.0/fix/work"])
    await seed(dir, { "b.txt": "b\n" })
    expect(await status(dir, CLOUD)).not.toHaveProperty("notice")
    expect(await started(dir, CLOUD)).not.toContain(NOTICE)
  })

  test("is not shown for a linked worktree on a detached HEAD", async () => {
    const dir = await session()
    const linked = join(await scratch("holyagent-linked-"), "tree")
    await sh(dir, ["git", "worktree", "add", "-q", "--detach", linked])
    await put(linked, { "c.txt": "c\n" })
    expect(await status(linked, CLOUD)).not.toHaveProperty("notice")
    expect(await started(linked, CLOUD)).not.toContain(NOTICE)
  })

  test("is not shown outside a cloud session", async () => {
    const dir = await session()
    await detach(dir)
    for (const env of [{}, { CLAUDE_CODE_REMOTE: "false" }, { CLAUDE_CODE_REMOTE: "1" }]) {
      expect(await status(dir, env)).not.toHaveProperty("notice")
      expect(await started(dir, env)).not.toContain(NOTICE)
    }
  })
})
