import { expect, spyOn, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Fiber } from "effect"

import { withStateLock } from "./lock.ts"
import { cleanupMigrationSources, publishMigrationFiles } from "./migration-files.ts"

const fixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "holyagent-authority-test-"))
  try {
    expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root }).status).not.toBe(0)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const digest = (value: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(value)}\0`)
    .update(value)
    .digest("hex")
const postimage = {
  path: "record",
  before: null,
  after: digest("new"),
  content: Buffer.from("new").toString("base64"),
  mode: 0o100644,
}
const source = [{ path: "record", digest: digest("old"), tracked: false }]
const gate = () => {
  let entered!: () => void
  let release!: () => void
  return {
    entered: new Promise<void>((resolve) => {
      entered = resolve
    }),
    signal: () => entered(),
    wait: new Promise<void>((resolve) => {
      release = resolve
    }),
    release: () => release(),
  }
}
const awaitTemporaryCleanup = async (root: string) => {
  for (let i = 0; i < 100; i++) {
    if (!(await readdir(root)).some((name) => name.startsWith(".holyagent-migration-"))) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("temporary cleanup did not finish")
}
const prototype = async (root: string) => {
  const handle = await open(join(root, "probe"), "w")
  const result = Object.getPrototypeOf(handle) as typeof handle
  await handle.close()
  return result
}

test("revocation while temporary data is syncing prevents exclusive publication", async () =>
  fixture(async (root) => {
    const proto = await prototype(root)
    const original = Object.getOwnPropertyDescriptor(proto, "sync")!.value as typeof proto.sync
    const blocked = gate()
    const spy = spyOn(proto, "sync").mockImplementation(async function (this: typeof proto) {
      blocked.signal()
      await blocked.wait
      return original.call(this)
    })
    let allowed = true
    const authorize = Effect.suspend(() =>
      allowed ? Effect.void : Effect.fail(new Error("revoked")),
    )
    try {
      const result = Effect.runPromise(
        publishMigrationFiles({
          root,
          files: [postimage],
          authorize,
          terminalAuthorize: () => allowed,
        }),
      )
      await blocked.entered
      allowed = false
      blocked.release()
      await expect(result).rejects.toThrow("revoked")
      await awaitTemporaryCleanup(root)
      expect(await readdir(root)).toEqual(["probe"])
    } finally {
      blocked.release()
      spy.mockRestore()
    }
  }))

test("revocation during the final source read preserves the matching file", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "record"), "old")
    const proto = await prototype(root)
    const original = Object.getOwnPropertyDescriptor(proto, "readFile")!
      .value as typeof proto.readFile
    const blocked = gate()
    let reads = 0
    const spy = spyOn(proto, "readFile").mockImplementation(async function (
      this: typeof proto,
      ...args: Parameters<typeof original>
    ) {
      const value = await original.apply(this, args)
      if (++reads === 2) {
        blocked.signal()
        await blocked.wait
      }
      return value
    } as typeof original)
    let allowed = true
    const authorize = Effect.suspend(() =>
      allowed ? Effect.void : Effect.fail(new Error("revoked")),
    )
    try {
      const result = Effect.runPromise(
        cleanupMigrationSources({
          root,
          source,
          authorize,
          terminalAuthorize: () => allowed,
          isTracked: () => Effect.succeed(false),
        }),
      )
      await blocked.entered
      allowed = false
      blocked.release()
      await expect(result).rejects.toThrow("revoked")
      expect(await readFile(join(root, "record"), "utf8")).toBe("old")
    } finally {
      blocked.release()
      spy.mockRestore()
    }
  }))

test("interruption while temporary data is syncing cannot publish on completion", async () =>
  fixture(async (root) => {
    const proto = await prototype(root)
    const original = Object.getOwnPropertyDescriptor(proto, "sync")!.value as typeof proto.sync
    const blocked = gate()
    const spy = spyOn(proto, "sync").mockImplementation(async function (this: typeof proto) {
      blocked.signal()
      await blocked.wait
      return original.call(this)
    })
    try {
      const fiber = Effect.runFork(
        publishMigrationFiles({ root, files: [postimage], authorize: Effect.void }),
      )
      await blocked.entered
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
      blocked.release()
      await interrupted
      await awaitTemporaryCleanup(root)
      expect(await readdir(root)).toEqual(["probe"])
    } finally {
      blocked.release()
      spy.mockRestore()
    }
  }))

test("interruption during the final source read prevents cleanup", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "record"), "old")
    const proto = await prototype(root)
    const original = Object.getOwnPropertyDescriptor(proto, "readFile")!
      .value as typeof proto.readFile
    const blocked = gate()
    let reads = 0
    const spy = spyOn(proto, "readFile").mockImplementation(async function (
      this: typeof proto,
      ...args: Parameters<typeof original>
    ) {
      const value = await original.apply(this, args)
      if (++reads === 2) {
        blocked.signal()
        await blocked.wait
      }
      return value
    } as typeof original)
    try {
      const fiber = Effect.runFork(
        cleanupMigrationSources({
          root,
          source,
          authorize: Effect.void,
          isTracked: () => Effect.succeed(false),
        }),
      )
      await blocked.entered
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
      blocked.release()
      await interrupted
      expect(await readFile(join(root, "record"), "utf8")).toBe("old")
    } finally {
      blocked.release()
      spy.mockRestore()
    }
  }))

test("edits made during asynchronous authority checks are retained", async () =>
  fixture(async (root) => {
    const path = join(root, "record")
    await writeFile(path, "old")
    let calls = 0
    const authorize = Effect.promise(async () => {
      if (++calls === 2) await writeFile(path, "user edit")
    })
    const modified = { ...postimage, before: digest("old") }
    await expect(
      Effect.runPromise(
        publishMigrationFiles({
          root,
          files: [modified],
          authorize,
          terminalAuthorize: () => true,
        }),
      ),
    ).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe("user edit")
    await writeFile(path, "old")
    calls = 0
    const result = await Effect.runPromise(
      cleanupMigrationSources({
        root,
        source,
        authorize,
        terminalAuthorize: () => true,
        isTracked: () => Effect.succeed(false),
      }),
    )
    expect(result.retained.map((item) => item.path)).toEqual(["record"])
    expect(await readFile(path, "utf8")).toBe("user edit")
  }))

test("cancelled preparation releases the caller before blocked sync settles", async () =>
  fixture(async (root) => {
    const proto = await prototype(root)
    const original = Object.getOwnPropertyDescriptor(proto, "sync")!.value as typeof proto.sync
    const blocked = gate()
    const spy = spyOn(proto, "sync").mockImplementation(async function (this: typeof proto) {
      blocked.signal()
      await blocked.wait
      return original.call(this)
    })
    try {
      const fiber = Effect.runFork(
        withStateLock(
          join(root, "locks"),
          publishMigrationFiles({ root, files: [postimage], authorize: Effect.void }),
        ),
      )
      await blocked.entered
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
      const prompt = await Promise.race([
        interrupted.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
      ])
      expect(prompt).toBe(true)
      expect((await readdir(root)).includes("record")).toBe(false)
      const reacquired = Effect.runPromise(withStateLock(join(root, "locks"), Effect.succeed(true)))
      expect(
        await Promise.race([
          reacquired,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
        ]),
      ).toBe(true)
      blocked.release()
      await interrupted
      await awaitTemporaryCleanup(root)
      expect((await readdir(root)).sort()).toEqual(["locks", "probe"])
    } finally {
      blocked.release()
      spy.mockRestore()
    }
  }))

test("custom asynchronous authority without a terminal guard fails closed", async () =>
  fixture(async (root) => {
    const authorize = Effect.sync(() => {})
    await expect(
      Effect.runPromise(publishMigrationFiles({ root, files: [postimage], authorize })),
    ).rejects.toThrow()
    expect((await readdir(root)).includes("record")).toBe(false)
    await writeFile(join(root, "record"), "old")
    await expect(
      Effect.runPromise(
        cleanupMigrationSources({
          root,
          source,
          authorize,
          isTracked: () => Effect.succeed(false),
        }),
      ),
    ).rejects.toThrow()
    expect(await readFile(join(root, "record"), "utf8")).toBe("old")
  }))

test("source edit during asynchronous authorization is retained", async () =>
  fixture(async (root) => {
    const path = join(root, "record")
    await writeFile(path, "old")
    let calls = 0
    const authorize = Effect.promise(async () => {
      if (++calls === 2) await writeFile(path, "user edit")
    })
    const result = await Effect.runPromise(
      cleanupMigrationSources({
        root,
        source,
        authorize,
        terminalAuthorize: () => true,
        isTracked: () => Effect.succeed(false),
      }),
    )
    expect(result.retained.map((item) => item.path)).toEqual(["record"])
    expect(await readFile(path, "utf8")).toBe("user edit")
  }))

test("detached cleanup preserves a replacement at its old temporary pathname", async () =>
  fixture(async (root) => {
    const proto = await prototype(root)
    const original = Object.getOwnPropertyDescriptor(proto, "sync")!.value as typeof proto.sync
    const blocked = gate()
    const finished = gate()
    const spy = spyOn(proto, "sync").mockImplementation(async function (this: typeof proto) {
      blocked.signal()
      await blocked.wait
      try {
        return await original.call(this)
      } finally {
        finished.signal()
      }
    })
    try {
      const fiber = Effect.runFork(
        publishMigrationFiles({ root, files: [postimage], authorize: Effect.void }),
      )
      await blocked.entered
      await Effect.runPromise(Fiber.interrupt(fiber))
      const name = (await readdir(root)).find((value) => value.startsWith(".holyagent-migration-"))
      if (name === undefined) throw new Error("temporary was not created")
      const temporary = join(root, name)
      await rename(temporary, join(root, "saved"))
      await writeFile(temporary, "user replacement")
      blocked.release()
      await finished.entered
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(await readFile(temporary, "utf8")).toBe("user replacement")
      expect(await readFile(join(root, "saved"), "utf8")).toBe("new")
      expect((await readdir(root)).includes("record")).toBe(false)
    } finally {
      blocked.release()
      spy.mockRestore()
    }
  }))
