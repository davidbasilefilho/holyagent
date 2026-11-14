import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { Deferred, Effect, Fiber } from "effect"

import { type Context, withState } from "../src/api/context.ts"
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
    `#!/bin/sh\ncase "$*" in *"$GATE_PATTERN"*) if [ "$GATE_COMMIT_FIRST" = 1 ]; then "${real}" "$@" || exit $?; fi; touch "$GATE_READY"; while [ ! -f "$GATE_RELEASE" ]; do sleep 0.01; done; if [ -n "$GATE_AFTER" ]; then touch "$GATE_AFTER"; fi; if [ "$GATE_COMMIT_FIRST" = 1 ]; then exit 0; fi;; esac\nexec "${real}" "$@"\n`,
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
  "a successful migration commit interrupted before its caller sees success is recoverable",
  async () => {
    const f = await fixture()
    try {
      const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      const target = join(state.directory, "user-edit")
      await writeFile(target, "staged edit")
      f.git("-C", join(state.directory, ".."), "add", "-f", ".holyagent/user-edit")
      await writeFile(target, "unstaged edit")
      const targetBefore = f.git(
        "-C",
        join(state.directory, ".."),
        "diff",
        "--cached",
        "--",
        ".holyagent/user-edit",
      )
      await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
      const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
      await mkdir(join(source, ".."), { recursive: true })
      await writeFile(source, "source")
      f.git("add", ".holyagent/intents/fixture/intent.json")
      const sourceBefore = f.git("status", "--porcelain", "--", ".holyagent")
      const beforeHead = f.git("-C", join(state.directory, ".."), "rev-parse", "HEAD")
      const after = join(f.cwd, "descendant-continued")
      const fiber = Effect.runFork(
        resolveState(
          f.cwd,
          {
            ...f.env,
            GATE_PATTERN: "update-ref refs/heads/holyagent/state",
            GATE_COMMIT_FIRST: "1",
            GATE_AFTER: after,
          },
          "create",
        ),
      )
      await f.wait()
      expect(f.git("-C", join(state.directory, ".."), "rev-parse", "HEAD")).not.toBe(beforeHead)
      const journal = join(f.cwd, ".git", "holyagent", "migration", "journal.json")
      const pending = await readFile(journal, "utf8")
      expect((await Effect.runPromiseExit(resolveState(f.cwd, { HOME: f.cwd }, "peek")))._tag).toBe(
        "Failure",
      )
      expect(await readFile(journal, "utf8")).toBe(pending)
      const interrupted = await Promise.race([
        Effect.runPromise(Fiber.interrupt(fiber)).then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
      ])
      if (!interrupted) {
        await f.release()
        await Effect.runPromise(Fiber.await(fiber))
      }
      expect(interrupted).toBe(true)
      expect(await readFile(source, "utf8")).toBe("source")
      expect(f.git("status", "--porcelain", "--", ".holyagent")).toBe(sourceBefore)
      await f.release()
      expect(await Bun.file(after).exists()).toBe(false)
      await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      expect(
        await readFile(join(state.directory, "intents", "fixture", "intent.json"), "utf8"),
      ).toBe("source")
      expect(await readFile(target, "utf8")).toBe("unstaged edit")
      expect(
        f.git("-C", join(state.directory, ".."), "diff", "--cached", "--", ".holyagent/user-edit"),
      ).toBe(targetBefore)
    } finally {
      await f.release()
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "migration preserves unrelated staged and unstaged shared-state edits",
  async () => {
    const f = await fixture()
    try {
      const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      const tree = join(state.directory, "..")
      const target = join(state.directory, "user-edit")
      await writeFile(target, "staged edit")
      f.git("-C", tree, "add", "-f", ".holyagent/user-edit")
      await writeFile(target, "unstaged edit")
      const staged = f.git("-C", tree, "diff", "--cached", "--", ".holyagent/user-edit")
      await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
      const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
      await mkdir(join(source, ".."), { recursive: true })
      await writeFile(source, "source")
      f.git("add", ".holyagent/intents/fixture/intent.json")
      await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      expect(
        await readFile(join(state.directory, "intents", "fixture", "intent.json"), "utf8"),
      ).toBe("source")
      expect(await readFile(target, "utf8")).toBe("unstaged edit")
      expect(f.git("-C", tree, "diff", "--cached", "--", ".holyagent/user-edit")).toBe(staged)
    } finally {
      await f.close()
    }
  },
)

test("migration retains the separate staged and unstaged source versions", async () => {
  const f = await fixture()
  try {
    const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
    await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
    const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
    await mkdir(join(source, ".."), { recursive: true })
    await writeFile(source, "staged source")
    f.git("add", ".holyagent/intents/fixture/intent.json")
    await writeFile(source, "unstaged source")
    const index = f.git("show", ":.holyagent/intents/fixture/intent.json")
    await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
    expect(await readFile(source, "utf8")).toBe("unstaged source")
    expect(f.git("show", ":.holyagent/intents/fixture/intent.json")).toBe(index)
    expect(await readFile(join(state.directory, "intents", "fixture", "intent.json"), "utf8")).toBe(
      "unstaged source",
    )
  } finally {
    await f.close()
  }
})

test("migration refuses a conflicting owned target before consuming its index", async () => {
  const f = await fixture()
  try {
    const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
    const tree = join(state.directory, "..")
    const target = join(state.directory, "fixture")
    await writeFile(target, "staged target")
    f.git("-C", tree, "add", "-f", ".holyagent/fixture")
    await writeFile(target, "unstaged target")
    const index = f.git("-C", tree, "show", ":.holyagent/fixture")
    await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
    const source = join(f.cwd, ".holyagent", "fixture")
    await mkdir(join(source, ".."), { recursive: true })
    await writeFile(source, "source")
    const result = await Effect.runPromiseExit(resolveState(f.cwd, { HOME: f.cwd }, "create"))
    expect(result._tag).toBe("Failure")
    expect(await readFile(source, "utf8")).toBe("source")
    expect(await readFile(target, "utf8")).toBe("unstaged target")
    expect(f.git("-C", tree, "show", ":.holyagent/fixture")).toBe(index)
  } finally {
    await f.close()
  }
})

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

test.skipIf(process.platform === "win32")(
  "interrupting a stalled migration commit preserves source and permits retry",
  async () => {
    const f = await fixture()
    try {
      const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
      const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
      await mkdir(join(source, ".."), { recursive: true })
      await writeFile(source, "source")
      f.git("add", ".holyagent/intents/fixture/intent.json")
      const before = f.git("status", "--porcelain", "--", ".holyagent")
      const after = join(f.cwd, "descendant-continued")
      const fiber = Effect.runFork(
        resolveState(
          f.cwd,
          { ...f.env, GATE_PATTERN: "update-ref refs/heads/holyagent/state", GATE_AFTER: after },
          "create",
        ),
      )
      await f.wait()
      const interrupted = await Promise.race([
        Effect.runPromise(Fiber.interrupt(fiber)).then(() => true),
        new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
      ])
      if (!interrupted) {
        await f.release()
        await Effect.runPromise(Fiber.await(fiber))
      }
      expect(interrupted).toBe(true)
      expect(await readFile(source, "utf8")).toBe("source")
      expect(f.git("status", "--porcelain", "--", ".holyagent")).toBe(before)
      await f.release()
      await new Promise((done) => setTimeout(done, 100))
      expect(await Bun.file(after).exists()).toBe(false)
      await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      expect(
        await readFile(join(state.directory, "intents", "fixture", "intent.json"), "utf8"),
      ).toBe("source")
    } finally {
      await f.release()
      await f.close()
    }
  },
)

test("a read spanning completed migration is rejected instead of returning a mixed snapshot", async () => {
  const f = await fixture()
  try {
    const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
    await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
    const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
    await mkdir(join(source, ".."), { recursive: true })
    await writeFile(source, "source")
    const readOnly = {
      ...context(f.cwd, { HOME: f.cwd }, () => false),
      authorize: (capability: string) => capability === "intent.list",
    }
    const result = await Effect.runPromiseExit(
      withState(readOnly, "intent.list", "peek", () =>
        resolveState(f.cwd, { HOME: f.cwd }, "create").pipe(Effect.as("snapshot")),
      ),
    )
    expect(result._tag).toBe("Failure")
    expect(await readFile(join(state.directory, "intents", "fixture", "intent.json"), "utf8")).toBe(
      "source",
    )
    expect(
      await Bun.file(join(f.cwd, ".git", "holyagent", "migration", "journal.json")).exists(),
    ).toBe(false)
  } finally {
    await f.close()
  }
})

test.skipIf(process.platform === "win32")(
  "a read spanning an active migration fails without recovering it",
  async () => {
    const f = await fixture()
    try {
      await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
      const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
      await mkdir(join(source, ".."), { recursive: true })
      await writeFile(source, "source")
      const readOnly = {
        ...context(f.cwd, { HOME: f.cwd }, () => false),
        authorize: (capability: string) => capability === "intent.list",
      }
      let migration: ReturnType<typeof Effect.runFork> | undefined
      const result = await Effect.runPromiseExit(
        withState(readOnly, "intent.list", "peek", () =>
          Effect.promise(async () => {
            migration = Effect.runFork(
              resolveState(
                f.cwd,
                { ...f.env, GATE_PATTERN: "update-ref refs/heads/holyagent/state" },
                "create",
              ),
            )
            await f.wait()
            return "snapshot"
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      const journal = join(f.cwd, ".git", "holyagent", "migration", "journal.json")
      expect(await Bun.file(journal).exists()).toBe(true)
      if (migration !== undefined) await Effect.runPromise(Fiber.interrupt(migration))
      await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      expect(await Bun.file(journal).exists()).toBe(false)
    } finally {
      await f.release()
      await f.close()
    }
  },
)

test("migration refuses a matching untracked target without staging it", async () => {
  const f = await fixture()
  try {
    const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
    const tree = join(state.directory, "..")
    await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
    const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
    const target = join(state.directory, "intents", "fixture", "intent.json")
    await mkdir(join(source, ".."), { recursive: true })
    await mkdir(join(target, ".."), { recursive: true })
    await writeFile(source, "same data")
    await writeFile(target, "same data")
    f.git("add", ".holyagent/intents/fixture/intent.json")
    const head = f.git("-C", tree, "rev-parse", "HEAD")
    const index = f.git("-C", tree, "ls-files", "--stage")
    expect((await Effect.runPromiseExit(resolveState(f.cwd, { HOME: f.cwd }, "create")))._tag).toBe(
      "Failure",
    )
    expect(f.git("-C", tree, "rev-parse", "HEAD")).toBe(head)
    expect(f.git("-C", tree, "ls-files", "--stage")).toBe(index)
    expect(await readFile(target, "utf8")).toBe("same data")
    expect(await readFile(source, "utf8")).toBe("same data")
    expect(
      await Bun.file(join(f.cwd, ".git", "holyagent", "migration", "journal.json")).exists(),
    ).toBe(false)
  } finally {
    await f.close()
  }
})

test.skipIf(process.platform === "win32")(
  "recovery refuses a journal whose source is not a planned state file",
  async () => {
    const f = await fixture()
    try {
      const state = await Effect.runPromise(resolveState(f.cwd, { HOME: f.cwd }, "create"))
      const targetRoot = join(state.directory, "..")
      const head = f.git("-C", targetRoot, "rev-parse", "HEAD")
      await rm(join(f.cwd, ".git", "holyagent", "migrated"), { recursive: true, force: true })
      const source = join(f.cwd, ".holyagent", "intents", "fixture", "intent.json")
      const victim = join(f.cwd, "unrelated")
      await mkdir(join(source, ".."), { recursive: true })
      await writeFile(source, "source")
      await writeFile(victim, "source")
      const fiber = Effect.runFork(
        resolveState(
          f.cwd,
          { ...f.env, GATE_PATTERN: "update-ref refs/heads/holyagent/state" },
          "create",
        ),
      )
      await f.wait()
      await Effect.runPromise(Fiber.interrupt(fiber))
      const journal = join(f.cwd, ".git", "holyagent", "migration", "journal.json")
      const record = JSON.parse(await readFile(journal, "utf8")) as {
        source: Array<{ path: string }>
      }
      record.source[0]!.path = "unrelated"
      const forged = JSON.stringify(record)
      await writeFile(journal, forged)
      expect(
        (await Effect.runPromiseExit(resolveState(f.cwd, { HOME: f.cwd }, "create")))._tag,
      ).toBe("Failure")
      expect(f.git("-C", targetRoot, "rev-parse", "HEAD")).toBe(head)
      expect(await readFile(journal, "utf8")).toBe(forged)
      expect(await readFile(source, "utf8")).toBe("source")
      expect(await readFile(victim, "utf8")).toBe("source")
      expect(
        await Bun.file(join(state.directory, "intents", "fixture", "intent.json")).exists(),
      ).toBe(false)
    } finally {
      await f.release()
      await f.close()
    }
  },
)
