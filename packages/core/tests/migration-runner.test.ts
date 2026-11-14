import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Deferred, Effect, Fiber } from "effect"

import { readMigrationJournal } from "../src/state/migration-journal.ts"
import {
  type MigrationPreparation,
  type MigrationRunnerOptions,
  runMigrationTransaction,
} from "../src/state/migration-runner.ts"

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "holyagent-runner-"))
  if (spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"]).status === 0)
    throw new Error("fixture is inside a Git repository")
  const sourceRoot = join(root, "source")
  const targetRoot = join(root, "target")
  const privateDir = join(root, "private")
  await Promise.all(
    [sourceRoot, targetRoot, privateDir].map((path) => mkdir(path, { mode: 0o700 })),
  )
  const location = { path: join(privateDir, "journal"), sourceRoot, targetRoot }
  const parent = "a".repeat(40)
  const commit = "b".repeat(40)
  const preparation: MigrationPreparation = {
    parent,
    commit,
    tree: "c".repeat(40),
    indexBefore: "d".repeat(64),
    indexAfter: "e".repeat(64),
    files: [
      {
        path: ".holyagent/intents/a/intent.json",
        before: null,
        after: createHash("sha1").update("blob 6\0secret").digest("hex"),
        content: "c2VjcmV0",
        mode: 0o100644,
      },
    ],
    source: [{ path: ".holyagent/intents/a/intent.json", digest: "f".repeat(64), tracked: false }],
  }
  const state = {
    ref: parent,
    files: false,
    index: false,
    cleaned: false,
    allowed: true,
    revokeOnRead: false,
    casError: false,
    casBeforeError: false,
    cleanupFailure: false,
    badCommit: false,
    stall: "" as "" | "read" | "cas" | "files",
    events: [] as string[],
  }
  const started = await Effect.runPromise(Deferred.make<void>())
  const pause = (point: "read" | "cas" | "files") =>
    state.stall === point
      ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      : Effect.void
  const authorize = Effect.suspend(() => (state.allowed ? Effect.void : Effect.fail("revoked")))
  const options: MigrationRunnerOptions<string, string> = {
    location,
    branch: "holyagent/state",
    authorize,
    services: {
      prepare: () =>
        Effect.sync(() => {
          state.events.push("prepare")
          return preparation
        }),
      verifyCommit: () =>
        state.badCommit ? Effect.fail("commit tree or parent mismatch") : Effect.void,
      readRef: () =>
        Effect.gen(function* () {
          state.events.push("read")
          yield* pause("read")
          if (state.revokeOnRead) state.allowed = false
          return state.ref
        }),
      compareAndSwapRef: (_branch, old, next, check) =>
        Effect.gen(function* () {
          yield* check
          const journal = yield* readMigrationJournal(location).pipe(
            Effect.mapError(() => "journal read"),
          )
          if (journal?.phase !== "prepared" || state.ref !== old)
            return yield* Effect.fail("CAS precondition")
          state.events.push("cas")
          if (state.casBeforeError) return yield* Effect.fail("CAS failed before update")
          state.ref = next
          yield* pause("cas")
          if (state.casError) return yield* Effect.fail("uncertain CAS")
        }),
      publishFiles: (_journal, check) =>
        Effect.gen(function* () {
          yield* check
          state.events.push("files")
          state.files = true
          yield* pause("files")
        }),
      publishIndex: (_journal, check) =>
        Effect.gen(function* () {
          yield* check
          state.events.push("index")
          state.index = true
        }),
      verifyTarget: () =>
        Effect.gen(function* () {
          state.events.push("verify")
          if (!state.files || !state.index) return yield* Effect.fail("target mismatch")
        }),
      cleanupSource: (_journal, check) =>
        Effect.gen(function* () {
          yield* check
          state.events.push("cleanup")
          if (state.cleanupFailure) return yield* Effect.fail("cleanup conflict")
          state.cleaned = true
        }),
    },
  }
  const interruptAtGate = async () => {
    const fiber = Effect.runFork(runMigrationTransaction(options))
    await Effect.runPromise(Deferred.await(started))
    const interrupted = await Promise.race([
      Effect.runPromise(Fiber.interrupt(fiber)).then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 2000)),
    ])
    expect(interrupted).toBe(true)
    state.stall = ""
  }
  return {
    root,
    location,
    preparation,
    state,
    options,
    interruptAtGate,
    close: () => rm(root, { recursive: true, force: true }),
  }
}

const runFailure = async (options: MigrationRunnerOptions<string, string>) => {
  expect((await Effect.runPromiseExit(runMigrationTransaction(options)))._tag).toBe("Failure")
}

test("normal publication journals before CAS and verifies before cleanup and finish", async () => {
  const f = await fixture()
  try {
    await Effect.runPromise(runMigrationTransaction(f.options))
    expect(f.state.ref).toBe(f.preparation.commit)
    expect(f.state.cleaned).toBe(true)
    expect(f.state.events.filter((event) => event !== "read")).toEqual([
      "prepare",
      "cas",
      "files",
      "index",
      "verify",
      "verify",
      "cleanup",
      "verify",
      "verify",
    ])
    expect(await Effect.runPromise(readMigrationJournal(f.location))).toBeUndefined()
  } finally {
    await f.close()
  }
})

test("interrupting before CAS returns promptly and retry uses the prepared journal", async () => {
  const f = await fixture()
  try {
    f.state.stall = "read"
    await f.interruptAtGate()
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe("prepared")
    expect(f.state.ref).toBe(f.preparation.parent)
    await Effect.runPromise(runMigrationTransaction(f.options))
    expect(f.state.events.filter((event) => event === "prepare")).toHaveLength(1)
    expect(f.state.cleaned).toBe(true)
  } finally {
    await f.close()
  }
})

test("an interrupted CAS that advanced the ref is reconciled without a second CAS", async () => {
  const f = await fixture()
  try {
    f.state.stall = "cas"
    await f.interruptAtGate()
    expect(f.state.ref).toBe(f.preparation.commit)
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe("prepared")
    await Effect.runPromise(runMigrationTransaction(f.options))
    expect(f.state.events.filter((event) => event === "cas")).toHaveLength(1)
    expect(f.state.cleaned).toBe(true)
  } finally {
    await f.close()
  }
})

test("partial file publication is retried idempotently after prompt interruption", async () => {
  const f = await fixture()
  try {
    f.state.stall = "files"
    await f.interruptAtGate()
    expect(f.state.files).toBe(true)
    expect(f.state.index).toBe(false)
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe("ref-published")
    await Effect.runPromise(runMigrationTransaction(f.options))
    expect(f.state.events.filter((event) => event === "files")).toHaveLength(2)
    expect(f.state.cleaned).toBe(true)
  } finally {
    await f.close()
  }
})

test("an unexpected ref or revoked authority leaves the prepared journal intact", async () => {
  const f = await fixture()
  try {
    f.state.ref = "9".repeat(40)
    await runFailure(f.options)
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe("prepared")
    expect(f.state.events).not.toContain("cas")
    f.state.ref = f.preparation.parent
    f.state.revokeOnRead = true
    await runFailure(f.options)
    expect(f.state.ref).toBe(f.preparation.parent)
    expect(f.state.events).not.toContain("cas")
  } finally {
    await f.close()
  }
})

test("a cleanup conflict retains the journal and retries only after target verification", async () => {
  const f = await fixture()
  try {
    f.state.cleanupFailure = true
    await runFailure(f.options)
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe(
      "target-published",
    )
    expect(f.state.cleaned).toBe(false)
    f.state.cleanupFailure = false
    f.state.index = false
    await runFailure(f.options)
    expect(f.state.cleaned).toBe(false)
    f.state.index = true
    await Effect.runPromise(runMigrationTransaction(f.options))
    expect(f.state.cleaned).toBe(true)
    expect(await Effect.runPromise(readMigrationJournal(f.location))).toBeUndefined()
  } finally {
    await f.close()
  }
})

test("CAS error after the ref advanced reconciles its actual value", async () => {
  const f = await fixture()
  try {
    f.state.casError = true
    await Effect.runPromise(runMigrationTransaction(f.options))
    expect(f.state.cleaned).toBe(true)
    expect(f.state.events.filter((event) => event === "cas")).toHaveLength(1)
  } finally {
    await f.close()
  }
})

test("CAS error before ref update preserves the journal for retry", async () => {
  const f = await fixture()
  try {
    f.state.casBeforeError = true
    await runFailure(f.options)
    expect(f.state.ref).toBe(f.preparation.parent)
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe("prepared")
    f.state.casBeforeError = false
    await Effect.runPromise(runMigrationTransaction(f.options))
    expect(f.state.cleaned).toBe(true)
  } finally {
    await f.close()
  }
})

test("a journal bound to another branch is refused before touching its ref", async () => {
  const f = await fixture()
  try {
    f.state.stall = "read"
    await f.interruptAtGate()
    const before = [...f.state.events]
    await runFailure({ ...f.options, branch: "other/state" })
    expect(f.state.events).toEqual(before)
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe("prepared")
  } finally {
    await f.close()
  }
})

test("revocation after preparation prevents writing a journal", async () => {
  const f = await fixture()
  try {
    const services = {
      ...f.options.services,
      prepare: () =>
        Effect.sync(() => {
          f.state.allowed = false
          return f.preparation
        }),
    }
    await runFailure({ ...f.options, services })
    expect(await Effect.runPromise(readMigrationJournal(f.location))).toBeUndefined()
    expect(f.state.ref).toBe(f.preparation.parent)
  } finally {
    await f.close()
  }
})

test("an inconsistent prepared commit is never published", async () => {
  const f = await fixture()
  try {
    f.state.badCommit = true
    await runFailure(f.options)
    expect(f.state.ref).toBe(f.preparation.parent)
    expect(f.state.events).not.toContain("cas")
    expect((await Effect.runPromise(readMigrationJournal(f.location)))?.phase).toBe("prepared")
  } finally {
    await f.close()
  }
})
