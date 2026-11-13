import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { Deferred, Effect, Fiber } from "effect"

import type { Context } from "../src/api/context.ts"
import { intent } from "../src/index.ts"
import { withStateLock } from "../src/state/lock.ts"
import { resolveState } from "../src/state/tree.ts"

const fixture = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "holyagent-revocation-"))
  if (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).status === 0)
    throw new Error("fixture is inside a Git repository")
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout
  }
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  git("commit", "--allow-empty", "-m", "fixture")
  const bin = join(cwd, "bin")
  await mkdir(bin)
  const real = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\ncase "$*" in *"$GATE_PATTERN"*) touch "$GATE_READY"; while [ ! -f "$GATE_RELEASE" ]; do sleep 0.01; done;; esac\nexec "${real}" "$@"\n`,
  )
  await chmod(join(bin, "git"), 0o755)
  const ready = join(cwd, "ready")
  const release = join(cwd, "release")
  const env = {
    HOME: cwd,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GATE_READY: ready,
    GATE_RELEASE: release,
  }
  const wait = async () => {
    for (let i = 0; i < 1000; i++) {
      if (await Bun.file(ready).exists()) return
      await new Promise((done) => setTimeout(done, 10))
    }
    throw new Error("Git gate was not reached")
  }
  return {
    cwd,
    git,
    env,
    wait,
    release: () => writeFile(release, ""),
    close: () => rm(cwd, { recursive: true, force: true }),
  }
}

const context = (cwd: string, env: Record<string, string>, authorize: () => boolean): Context => ({
  cwd,
  env,
  host: "claude",
  execution: { host: "claude", ttlMinutes: 55, workflowsAvailable: false },
  authorize,
})

test.skipIf(process.platform === "win32")(
  "revocation during fetch prevents worktree creation",
  async () => {
    const f = await fixture()
    try {
      f.git("remote", "add", "origin", join(f.cwd, "missing-remote"))
      let allowed = true
      const fiber = Effect.runFork(
        intent.create(
          context(f.cwd, { ...f.env, GATE_PATTERN: "fetch -q" }, () => allowed),
          { objective: "fixture" },
        ),
      )
      await f.wait()
      allowed = false
      await f.release()
      expect((await Effect.runPromise(Fiber.await(fiber)))._tag).toBe("Failure")
      expect(f.git("branch", "--list", "holyagent/state").trim()).toBe("")
      expect(f.git("worktree", "list", "--porcelain")).not.toContain("holyagent/state")
    } finally {
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "revocation during migration preparation preserves source and shared state",
  async () => {
    const f = await fixture()
    try {
      const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
      await mkdir(join(f.cwd, ".holyagent"), { recursive: true })
      await writeFile(join(f.cwd, ".holyagent", "fixture"), "source")
      f.git("add", ".holyagent/fixture")
      const before = f.git("status", "--porcelain", "--", ".holyagent")
      let allowed = true
      const fiber = Effect.runFork(
        intent.list(
          context(f.cwd, { ...f.env, GATE_PATTERN: "status --porcelain=v1" }, () => allowed),
          {},
        ),
      )
      await f.wait()
      allowed = false
      await f.release()
      expect((await Effect.runPromise(Fiber.await(fiber)))._tag).toBe("Failure")
      expect(f.git("status", "--porcelain", "--", ".holyagent")).toBe(before)
      expect(await readFile(join(f.cwd, ".holyagent", "fixture"), "utf8")).toBe("source")
      expect(await Bun.file(join(state.directory, "fixture")).exists()).toBe(false)
    } finally {
      await f.close()
    }
  },
)

test("lock setup checks authority after an asynchronous wait before creating local state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "holyagent-lock-guard-"))
  try {
    if (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).status === 0)
      throw new Error("fixture inside Git")
    const started = await Effect.runPromise(Deferred.make<void>())
    const release = await Effect.runPromise(Deferred.make<void>())
    let allowed = true
    const authorize = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(Effect.suspend(() => (allowed ? Effect.void : Effect.fail("revoked")))),
    )
    const fiber = Effect.runFork(
      withStateLock(join(cwd, ".holyagent"), Effect.void, undefined, authorize),
    )
    await Effect.runPromise(Deferred.await(started))
    allowed = false
    await Effect.runPromise(Deferred.succeed(release, undefined))
    expect((await Effect.runPromise(Fiber.await(fiber)))._tag).toBe("Failure")
    expect(await Bun.file(join(cwd, ".holyagent", "local", ".gitignore")).exists()).toBe(false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test.skipIf(process.platform === "win32")(
  "interrupting a stalled checkout returns and a later run recovers",
  async () => {
    const f = await fixture()
    try {
      const fiber = Effect.runFork(
        intent.create(
          context(f.cwd, { ...f.env, GATE_PATTERN: "worktree add -q" }, () => true),
          { objective: "first" },
        ),
      )
      await f.wait()
      const interrupted = await Promise.race([
        Effect.runPromise(Fiber.interrupt(fiber)).then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
      ])
      expect(interrupted).toBe(true)
      expect(f.git("worktree", "list", "--porcelain")).not.toContain("holyagent/state")
      await Effect.runPromise(
        intent.create(
          context(f.cwd, { HOME: f.cwd }, () => true),
          { objective: "recovered" },
        ),
      )
      expect(f.git("worktree", "list", "--porcelain")).toContain("holyagent/state")
    } finally {
      await f.release()
      await f.close()
    }
  },
)
