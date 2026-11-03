import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { resolveState } from "../src/state/tree.ts"
import { cleanup, GIT_ENV, initRepo, seed, sh } from "./vcs-fixtures.ts"

afterEach(cleanup)

const OWNER = { name: "Octo", email: "42+octo@users.noreply.github.com" }

/** A lock file of this live test process, taken `ageMs` ago, so its holder looks busy but stuck. */
const holdLock = async (file: string, ageMs: number) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    JSON.stringify({ pid: process.pid, token: "held", acquiredAt: Date.now() - ageMs }),
  )
}

const repo = async () => {
  const dir = await initRepo(OWNER)
  await seed(dir, { "a.txt": "a\n" })
  return dir
}

/**
 * The tests hold each lock longer than the hook limit (3 seconds) and shorter than the lock's own
 * limit, which is where only the hook patience gives up at once: without it resolveState would keep
 * waiting for 30 or 60 seconds, far past the default test timeout.
 */
describe("resolveState with the hook patience", () => {
  test("gives up on the exclude lock of the local mode", async () => {
    const dir = await repo()
    await sh(dir, ["git", "config", "holyagent.stateMode", "local"])
    await holdLock(join(dir, ".git", "holyagent", "exclude.lock"), 10_000)

    const error = await Effect.runPromise(
      Effect.flip(resolveState(dir, GIT_ENV, "ifPresent", false, "hook")),
    )

    expect(error._tag).toBe("StateLocked")
  })

  test("gives up on the worktree lock", async () => {
    const dir = await repo()
    await holdLock(join(dir, ".git", "holyagent", "worktree.lock"), 10_000)

    const error = await Effect.runPromise(
      Effect.flip(resolveState(dir, GIT_ENV, "create", false, "hook")),
    )

    expect(error._tag).toBe("StateLocked")
  })

  test("gives up on the state lock of the migration", async () => {
    const dir = await repo()
    const { directory } = await Effect.runPromise(resolveState(dir, GIT_ENV, "create"))
    // The first resolve migrated this work tree; forget that so the next one takes the lock again.
    await rm(join(dir, ".git", "holyagent", "migrated"), { recursive: true, force: true })
    await holdLock(join(directory, "local", "lock"), 10_000)

    const error = await Effect.runPromise(
      Effect.flip(resolveState(dir, GIT_ENV, "create", false, "hook")),
    )

    expect(error._tag).toBe("StateLocked")
  })
})
