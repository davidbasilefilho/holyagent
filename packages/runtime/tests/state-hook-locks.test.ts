import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect } from "effect"

import { deadlineIn, HOOK_WAIT_MS } from "../src/state/lock.ts"
import { resolveState } from "../src/state/tree.ts"
import { cleanup, GIT_ENV, initRepo, seed, sh } from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }

/**
 * A lock file of this live test process, taken `ageMs` ago. Written with Bun.write, which makes the
 * folders above it.
 */
const holdLock = (file: string, ageMs: number) =>
  Bun.write(
    file,
    JSON.stringify({ pid: process.pid, token: "held", acquiredAt: Date.now() - ageMs }),
  )

/** The files of `folder` matching `pattern`, as paths. */
const filesIn = async (folder: string, pattern: string) =>
  (await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: folder, onlyFiles: true }))).map(
    (name) => join(folder, name),
  )

const repo = async () => {
  const dir = await initRepo(OWNER)
  await seed(dir, { "a.txt": "a\n" })
  return dir
}

/**
 * A repository whose state worktree exists and whose next hook resolve takes both the worktree lock
 * (its ready marker is gone) and the migration lock (its migration marker is gone), as the first
 * hook of a work tree does. Only the two markers are removed, so nothing else of the state moves.
 */
const unsettled = async () => {
  const dir = await repo()
  const { directory } = await Effect.runPromise(resolveState(dir, GIT_ENV, "create"))
  const own = join(dir, ".git", "holyagent")
  const [ready = ""] = await filesIn(own, "*.ready")
  const [migrated = ""] = await filesIn(join(own, "migrated"), "*")
  expect(ready).not.toBe("")
  expect(migrated).not.toBe("")
  await Promise.all([Bun.file(ready).delete(), Bun.file(migrated).delete()])
  return {
    dir,
    worktreeLock: join(own, "worktree.lock"),
    stateLock: join(directory, "local", "lock"),
  }
}

/**
 * The tests hold each lock longer than the hook's wait (HOOK_WAIT_MS) and shorter than the lock's
 * own limit, which is where only a deadline gives up at once: without it resolveState would keep
 * waiting for 30 or 60 seconds, far past the default test timeout.
 */
describe("resolveState under a deadline", () => {
  test("gives up on the exclude lock of the local mode", async () => {
    const dir = await repo()
    await sh(dir, ["git", "config", "holyagent.stateMode", "local"])
    await holdLock(join(dir, ".git", "holyagent", "exclude.lock"), 2 * HOOK_WAIT_MS)

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(deadlineIn(HOOK_WAIT_MS), (deadline) =>
          resolveState(dir, GIT_ENV, "ifPresent", false, deadline),
        ),
      ),
    )

    expect(error._tag).toBe("StateLocked")
  })

  test("gives up on the worktree lock", async () => {
    const dir = await repo()
    await holdLock(join(dir, ".git", "holyagent", "worktree.lock"), 2 * HOOK_WAIT_MS)

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(deadlineIn(HOOK_WAIT_MS), (deadline) =>
          resolveState(dir, GIT_ENV, "create", false, deadline),
        ),
      ),
    )

    expect(error._tag).toBe("StateLocked")
  })

  test("gives up on the state lock of the migration", async () => {
    const dir = await repo()
    const { directory } = await Effect.runPromise(resolveState(dir, GIT_ENV, "create"))
    // The first resolve migrated this work tree; forget that so the next one takes the lock again.
    const [marker = ""] = await filesIn(join(dir, ".git", "holyagent", "migrated"), "*")
    expect(marker).not.toBe("")
    await Bun.file(marker).delete()
    await holdLock(join(directory, "local", "lock"), 2 * HOOK_WAIT_MS)

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(deadlineIn(HOOK_WAIT_MS), (deadline) =>
          resolveState(dir, GIT_ENV, "create", false, deadline),
        ),
      ),
    )

    expect(error._tag).toBe("StateLocked")
  })

  test("spends one wait on all its locks, not one for each", async () => {
    const { dir, worktreeLock, stateLock } = await unsettled()
    // Both locks are held by this live process just now, so a contender keeps waiting: the worktree
    // lock is let go after 1 second, the state lock never. A wait of 1.5 seconds for each lock
    // would end at 2.5 seconds; one wait for both ends at 1.5.
    await Promise.all([holdLock(worktreeLock, 0), holdLock(stateLock, 0)])
    const release = setTimeout(() => void Bun.file(worktreeLock).delete(), 1000)

    const started = Date.now()
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.flatMap(deadlineIn(1500), (deadline) =>
          resolveState(dir, GIT_ENV, "ifPresent", false, deadline),
        ),
      ),
    ).finally(() => clearTimeout(release))
    const waited = Date.now() - started

    expect(error._tag).toBe("StateLocked")
    expect(error).toMatchObject({ lockFile: stateLock })
    // It waited for the lock it could still get (the worktree lock came free after a second)...
    expect(waited).toBeGreaterThanOrEqual(1400)
    // ...and stopped at the deadline, with room for a slow machine, but not at a second wait.
    expect(waited).toBeLessThan(3000)
  }, 15_000)
})
