import assert from "node:assert/strict"
import childProcess, { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Layer, Option } from "effect"

assert.equal(typeof globalThis.Bun, "undefined")
const cwd = await mkdtemp(join(tmpdir(), "holyagent-core-host-"))
const env = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: cwd,
  USERPROFILE: cwd,
  HOLYAGENT_HOME: cwd,
  CLAUDE_CONFIG_DIR: join(cwd, ".claude"),
  XDG_CONFIG_HOME: cwd,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: join(cwd, "no-global-git-config"),
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
}
const git = (...args) => spawnSync("git", args, { cwd, env, encoding: "utf8" })
try {
  assert.equal(
    git("rev-parse", "--show-toplevel").status,
    128,
    "fixture must not be inside a Git repository",
  )
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.name", "Fixture"],
    ["config", "user.email", "fixture@example.test"],
    ["remote", "add", "origin", "https://github.com/example/project.git"],
  ]) {
    const result = git(...args)
    assert.equal(result.status, 0, result.stderr)
  }
  const observed = []
  const original = childProcess.spawn
  childProcess.spawn = function (program, args, options) {
    observed.push(program)
    return original.call(this, program, args, options)
  }
  syncBuiltinESMExports()
  const { setup, vcs, Shell, GitHub, gitLive, FileSystem, nodeFileSystem } =
    await import("../src/index.ts")
  const filesystemCalls = []
  const filesystem = {
    ...nodeFileSystem,
    readFile: (...args) => {
      filesystemCalls.push(["readFile", args[0]])
      return nodeFileSystem.readFile(...args)
    },
    open: (...args) => {
      filesystemCalls.push(["open", args[0], args[1]])
      return nodeFileSystem.open(...args)
    },
    writeFile: (...args) => {
      filesystemCalls.push(["writeFile", args[0]])
      throw new Error("unexpected filesystem write")
    },
    mkdir: (...args) => {
      filesystemCalls.push(["mkdir", args[0]])
      throw new Error("unexpected filesystem write")
    },
    rename: (...args) => {
      filesystemCalls.push(["rename", args[0]])
      throw new Error("unexpected filesystem write")
    },
    rm: (...args) => {
      filesystemCalls.push(["rm", args[0]])
      throw new Error("unexpected filesystem write")
    },
    chmod: (...args) => {
      filesystemCalls.push(["chmod", args[0]])
      throw new Error("unexpected filesystem write")
    },
  }
  const fsLayer = Layer.succeed(FileSystem, filesystem)
  const ctx = {
    cwd,
    env,
    host: "pi",
    execution: { host: "pi", ttlMinutes: 55, workflowsAvailable: false },
    authorize: () => true,
  }
  const run = Effect.runPromise
  const fakeShell = Layer.succeed(Shell, {
    which: () => Effect.succeed(Option.none()),
    run: () => Effect.die("unexpected process"),
  })
  const diagnostic = await run(
    setup.doctor(ctx, { fix: false }).pipe(Effect.provide(Layer.merge(fakeShell, fsLayer))),
  )
  assert.equal(typeof diagnostic.ok, "boolean")
  const dry = await run(
    setup
      .setup(ctx, { subagentCacheTtl: "1h", dryRun: true, skipCtx7: true })
      .pipe(Effect.provide(Layer.merge(fakeShell, fsLayer))),
  )
  assert.equal(typeof dry.ok, "boolean")
  assert.ok(
    filesystemCalls.every(
      ([name]) => !["writeFile", "mkdir", "rename", "rm", "chmod"].includes(name),
    ),
  )
  await assert.rejects(
    run(
      setup
        .doctor({ ...ctx, authorize: () => false }, { fix: false })
        .pipe(Effect.provide(fakeShell)),
    ),
  )
  await assert.rejects(
    run(
      setup
        .setup(
          { ...ctx, authorize: () => false },
          { subagentCacheTtl: "1h", dryRun: true, skipCtx7: true },
        )
        .pipe(Effect.provide(fakeShell)),
    ),
  )
  await assert.rejects(
    run(setup.doctor(ctx, { fix: false, extra: true }).pipe(Effect.provide(fakeShell))),
  )
  const layer = gitLive(cwd, env)
  const author = await run(
    vcs
      .identity(ctx, { name: "Fixture User", email: "fixture@example.test" })
      .pipe(Effect.provide(layer)),
  )
  assert.equal(author.name, "Fixture User")
  assert.equal(git("config", "--local", "author.name").stdout.trim(), "Fixture User")
  await assert.rejects(
    run(
      vcs
        .identity({ ...ctx, authorize: () => false }, { name: "Nobody", email: "no@example.test" })
        .pipe(Effect.provide(layer)),
    ),
  )
  await writeFile(join(cwd, "file.txt"), "fixture\n")
  const state = {
    directory: join(cwd, ".holyagent"),
    read: () => Effect.fail({ _tag: "NoActiveIntent" }),
    update: () => Effect.die("unexpected state write"),
  }
  const done = await run(
    vcs
      .commit(ctx, cwd, state, { messages: ["Add fixture"], paths: ["file.txt"] })
      .pipe(Effect.provide(layer)),
  )
  assert.equal(done.branch, "main")
  assert.equal(git("log", "-1", "--format=%s").stdout.trim(), "Add fixture")
  const calls = []
  const github = Layer.succeed(GitHub, {
    rest: (request) => {
      calls.push(request)
      return Effect.succeed({
        number: 12,
        html_url: "https://example.test/12",
        head: { ref: "main" },
      })
    },
  })
  await writeFile(join(cwd, "body.txt"), "Fixture body\n")
  const pull = await run(
    vcs
      .pr(ctx, cwd, state, { base: "main", title: "Fixture", bodyFile: "body.txt" })
      .pipe(Effect.provide(Layer.mergeAll(layer, github, fsLayer))),
  )
  assert.equal(pull.number, 12)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, "POST")
  assert.ok(filesystemCalls.some(([name]) => name === "readFile"))
  const opened = filesystemCalls.find(([name]) => name === "open")
  assert.ok(opened, "PR body is read through the injected filesystem")
  if (process.platform !== "win32")
    assert.ok((opened[2] & (await import("node:fs")).constants.O_NOFOLLOW) !== 0)
  assert.ok(observed.length > 0)
  assert.ok(
    observed.every((program) => program === "git"),
    JSON.stringify(observed),
  )
  console.log("node host operations passed")
} finally {
  await rm(cwd, { recursive: true, force: true })
}
