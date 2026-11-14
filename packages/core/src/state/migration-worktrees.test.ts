import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { Effect, Fiber } from "effect"

import { resolveState } from "./tree.ts"

const fixture = async (withOther = true) => {
  const root = await mkdtemp(join(tmpdir(), "holyagent-migration-worktrees-"))
  if (spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"]).status === 0)
    throw new Error("fixture is inside a Git repository")
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  git("commit", "--allow-empty", "-m", "base")
  const other = join(root, "other")
  const addOther = () => git("worktree", "add", "-b", "other", other)
  if (withOther) addOther()
  const bin = join(root, "bin")
  const ready = join(root, "gate-ready")
  const release = join(root, "gate-release")
  await mkdir(bin)
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim()
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\ncase "$*" in *"$GATE_PATTERN"*) if [ "$GATE_AFTER" = 1 ]; then "${realGit}" "$@" || exit $?; fi; touch "$GATE_READY"; while [ ! -f "$GATE_RELEASE" ]; do sleep 0.01; done; if [ "$GATE_AFTER" = 1 ]; then exit 0; fi;; esac\nexec "${realGit}" "$@"\n`,
  )
  await chmod(join(bin, "git"), 0o755)
  const env = { HOME: root }
  const gateEnv = (pattern: string, after: boolean) => ({
    ...env,
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    GATE_READY: ready,
    GATE_RELEASE: release,
    GATE_PATTERN: pattern,
    GATE_AFTER: after ? "1" : "0",
  })
  const wait = async () => {
    for (let i = 0; i < 1000; i++) {
      if (await Bun.file(ready).exists()) return
      await new Promise((done) => setTimeout(done, 10))
    }
    throw new Error("Git gate was not reached")
  }
  const source = async (tree: string, name: string) => {
    const dir = join(tree, ".holyagent")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, name), name)
  }
  return {
    root,
    other,
    git,
    env,
    gateEnv,
    wait,
    source,
    addOther,
    release: () => writeFile(release, ""),
    resetGate: async () => {
      await rm(ready, { force: true })
      await rm(release, { force: true })
    },
    close: () => rm(root, { recursive: true, force: true }),
  }
}

const interrupt = async (fiber: ReturnType<typeof Effect.runFork>) => {
  const result = await Promise.race([
    Effect.runPromise(Fiber.interrupt(fiber)).then(() => true),
    new Promise<boolean>((done) => setTimeout(() => done(false), 3000)),
  ])
  expect(result).toBe(true)
}

const CAS = "update-ref refs/heads/holyagent/state"

test.skipIf(process.platform === "win32")(
  "a different registered worktree resumes the recorded source",
  async () => {
    const f = await fixture(false)
    try {
      const state = await Effect.runPromise(resolveState(f.root, f.env, "create"))
      f.addOther()
      await f.source(f.other, "second")
      const fiber = Effect.runFork(resolveState(f.other, f.gateEnv(CAS, true), "create"))
      await f.wait()
      await interrupt(fiber)
      const result = await Effect.runPromise(resolveState(f.root, f.env, "create"))
      expect(result.directory).toBe(state.directory)
      expect(await readFile(join(state.directory, "second"), "utf8")).toBe("second")
      expect(
        await Bun.file(join(f.root, ".git", "holyagent", "migration", "journal.json")).exists(),
      ).toBe(false)
    } finally {
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "initial discovery resumes all sources after a CAS interruption",
  async () => {
    const f = await fixture()
    try {
      await f.source(f.root, "first")
      await f.source(f.other, "second")
      const fiber = Effect.runFork(resolveState(f.root, f.gateEnv(CAS, true), "create"))
      await f.wait()
      await interrupt(fiber)
      const state = await Effect.runPromise(resolveState(f.root, f.env, "create"))
      expect(await readFile(join(state.directory, "first"), "utf8")).toBe("first")
      expect(await readFile(join(state.directory, "second"), "utf8")).toBe("second")
    } finally {
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "initial discovery survives interruption before a journal exists",
  async () => {
    const f = await fixture()
    try {
      await f.source(f.root, "first")
      await f.source(f.other, "second")
      const fiber = Effect.runFork(
        resolveState(f.root, f.gateEnv("status --porcelain=v1", false), "create"),
      )
      await f.wait()
      await interrupt(fiber)
      expect(
        await Bun.file(join(f.root, ".git", "holyagent", "migration", "journal.json")).exists(),
      ).toBe(false)
      expect((await Effect.runPromiseExit(resolveState(f.other, f.env, "peek")))._tag).toBe(
        "Failure",
      )
      const state = await Effect.runPromise(resolveState(f.other, f.env, "create"))
      expect(await readFile(join(state.directory, "first"), "utf8")).toBe("first")
      expect(await readFile(join(state.directory, "second"), "utf8")).toBe("second")
    } finally {
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "recovery refuses an unregistered source root",
  async () => {
    const f = await fixture(false)
    try {
      await Effect.runPromise(resolveState(f.root, f.env, "create"))
      f.addOther()
      await f.source(f.other, "second")
      const fiber = Effect.runFork(resolveState(f.other, f.gateEnv(CAS, true), "create"))
      await f.wait()
      await interrupt(fiber)
      const foreign = await mkdtemp(join(tmpdir(), "holyagent-foreign-root-"))
      try {
        const journal = join(f.root, ".git", "holyagent", "migration", "journal.json")
        const record = JSON.parse(await readFile(journal, "utf8")) as { sourceRoot: string }
        record.sourceRoot = foreign
        const forged = JSON.stringify(record)
        await writeFile(journal, forged)
        expect((await Effect.runPromiseExit(resolveState(f.root, f.env, "create")))._tag).toBe(
          "Failure",
        )
        expect(await readFile(journal, "utf8")).toBe(forged)
        expect(await readFile(join(f.other, ".holyagent", "second"), "utf8")).toBe("second")
      } finally {
        await rm(foreign, { recursive: true, force: true })
      }
    } finally {
      await f.close()
    }
  },
)

const sweepMarker = async (root: string) => {
  const parent = join(root, ".git", "holyagent")
  const names = (await readdir(parent)).filter((name) => name.endsWith(".migration-sweep"))
  expect(names).toHaveLength(1)
  return join(parent, names[0]!)
}

test.skipIf(process.platform === "win32")(
  "an old journal gains a durable sweep before a second interruption",
  async () => {
    const f = await fixture()
    try {
      await f.source(f.root, "first")
      await f.source(f.other, "second")
      const first = Effect.runFork(resolveState(f.root, f.gateEnv(CAS, true), "create"))
      await f.wait()
      await interrupt(first)
      await rm(await sweepMarker(f.root)) // A journal produced by the previous release had no marker.
      await f.resetGate()
      const second = Effect.runFork(resolveState(f.other, f.gateEnv(CAS, true), "create"))
      await f.wait()
      await interrupt(second)
      await sweepMarker(f.root)
      const state = await Effect.runPromise(resolveState(f.root, f.env, "create"))
      expect(await readFile(join(state.directory, "first"), "utf8")).toBe("first")
      expect(await readFile(join(state.directory, "second"), "utf8")).toBe("second")
    } finally {
      await f.release()
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "revocation during the first sweep leaves its marker and sources recoverable",
  async () => {
    const f = await fixture()
    try {
      await f.source(f.root, "first")
      await f.source(f.other, "second")
      let allowed = true
      const authorize = Effect.suspend(() => (allowed ? Effect.void : Effect.fail("revoked")))
      const fiber = Effect.runFork(
        resolveState(
          f.root,
          f.gateEnv("status --porcelain=v1", false),
          "create",
          true,
          undefined,
          authorize,
        ),
      )
      await f.wait()
      allowed = false
      await f.release()
      expect((await Effect.runPromise(Fiber.await(fiber)))._tag).toBe("Failure")
      await sweepMarker(f.root)
      expect((await Effect.runPromiseExit(resolveState(f.other, f.env, "peek")))._tag).toBe(
        "Failure",
      )
      expect(await readFile(join(f.root, ".holyagent", "first"), "utf8")).toBe("first")
      allowed = true
      const state = await Effect.runPromise(
        resolveState(f.other, f.env, "create", true, undefined, authorize),
      )
      expect(await readFile(join(state.directory, "first"), "utf8")).toBe("first")
      expect(await readFile(join(state.directory, "second"), "utf8")).toBe("second")
    } finally {
      await f.release()
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "a registered source replaced by a foreign link is not used for recovery",
  async () => {
    const f = await fixture(false)
    const foreign = await mkdtemp(join(tmpdir(), "holyagent-foreign-root-"))
    try {
      await Effect.runPromise(resolveState(f.root, f.env, "create"))
      f.addOther()
      await f.source(f.other, "second")
      const fiber = Effect.runFork(resolveState(f.other, f.gateEnv(CAS, true), "create"))
      await f.wait()
      await interrupt(fiber)
      const journal = join(f.root, ".git", "holyagent", "migration", "journal.json")
      const before = await readFile(journal, "utf8")
      const saved = join(f.root, "saved-other")
      await rename(f.other, saved)
      await symlink(foreign, f.other)
      expect((await Effect.runPromiseExit(resolveState(f.root, f.env, "create")))._tag).toBe(
        "Failure",
      )
      expect(await readFile(journal, "utf8")).toBe(before)
      expect(await readFile(join(saved, ".holyagent", "second"), "utf8")).toBe("second")
      expect(await readdir(foreign)).toEqual([])
    } finally {
      await f.release()
      await rm(foreign, { recursive: true, force: true })
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "a linked sweep marker is refused without following or removing it",
  async () => {
    const f = await fixture()
    try {
      await f.source(f.root, "first")
      const fiber = Effect.runFork(
        resolveState(f.root, f.gateEnv("status --porcelain=v1", false), "create"),
      )
      await f.wait()
      await interrupt(fiber)
      const marker = await sweepMarker(f.root)
      const victim = join(f.root, "victim")
      await writeFile(victim, "keep")
      await rm(marker)
      await symlink(victim, marker)
      expect((await Effect.runPromiseExit(resolveState(f.other, f.env, "peek")))._tag).toBe(
        "Failure",
      )
      expect((await Effect.runPromiseExit(resolveState(f.other, f.env, "create")))._tag).toBe(
        "Failure",
      )
      expect(await readFile(victim, "utf8")).toBe("keep")
      expect(await readFile(join(f.root, ".holyagent", "first"), "utf8")).toBe("first")
    } finally {
      await f.release()
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "sweep cleanup refuses a marker replaced during authorization",
  async () => {
    const f = await fixture()
    try {
      await f.source(f.root, "first")
      const parent = join(f.root, ".git", "holyagent")
      const victim = join(f.root, "victim")
      await writeFile(victim, "keep")
      let replaced = false
      const authorize = Effect.promise(async () => {
        if (replaced) return
        const names = await readdir(parent).catch(() => [] as string[])
        const name = names.find((item) => item.endsWith(".migration-sweep"))
        if (name === undefined) return
        const marker = join(parent, name)
        const tree = marker.slice(0, -".migration-sweep".length)
        const journal = join(parent, "migration", "journal.json")
        if (
          (await Bun.file(join(tree, ".holyagent", "first")).exists()) &&
          !(await Bun.file(journal).exists())
        ) {
          await rm(marker)
          await symlink(victim, marker)
          replaced = true
        }
      })
      const exit = await Effect.runPromiseExit(
        resolveState(f.root, f.env, "create", true, undefined, authorize),
      )
      expect(replaced).toBe(true)
      expect(exit._tag).toBe("Failure")
      const marker = await sweepMarker(f.root)
      expect(await readFile(marker, "utf8")).toBe("keep")
      expect(await readFile(victim, "utf8")).toBe("keep")
      expect((await Effect.runPromiseExit(resolveState(f.root, f.env, "peek")))._tag).toBe(
        "Failure",
      )
    } finally {
      await f.close()
    }
  },
)

test.skipIf(process.platform === "win32")(
  "initial discovery includes a registered worktree whose path contains a newline",
  async () => {
    const f = await fixture(false)
    try {
      const unusual = join(f.root, "line\nbreak ")
      f.git("worktree", "add", "-b", "unusual", unusual)
      await f.source(f.root, "first")
      await f.source(unusual, "second")
      const state = await Effect.runPromise(resolveState(f.root, f.env, "create"))
      expect(await readFile(join(state.directory, "first"), "utf8")).toBe("first")
      expect(await readFile(join(state.directory, "second"), "utf8")).toBe("second")
    } finally {
      await f.close()
    }
  },
)
