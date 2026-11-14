import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  cleanupMigrationSources,
  publishMigrationFiles,
  verifyMigrationFilePreimages,
  verifyMigrationFiles,
} from "../src/state/migration-files.ts"

const fixture = async (run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "holyagent-files-test-"))
  try {
    expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: root }).status).not.toBe(0)
    await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const digest = (text: string) =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(text)}\0`)
    .update(text)
    .digest("hex")
const file = (
  path: string,
  text = "data\n",
): { path: string; content: string; before: string | null; after: string; mode: number } => ({
  path,
  content: Buffer.from(text).toString("base64"),
  before: null,
  after: digest(text),
  mode: 0o100644,
})
const publish = (root: string, files: ReturnType<typeof file>[], authorize = Effect.void) =>
  Effect.runPromise(publishMigrationFiles({ root, files, authorize }))
const verify = (root: string, files: ReturnType<typeof file>[]) =>
  Effect.runPromise(verifyMigrationFiles({ root, files }))

test("publishes and retries exact postimages, but refuses changed, deleted and escaped paths", async () =>
  fixture(async (root) => {
    const f = file(".holyagent/one")
    await publish(root, [f])
    await publish(root, [f])
    await verify(root, [f])
    expect(await readFile(join(root, f.path), "utf8")).toBe("data\n")
    await writeFile(join(root, f.path), "user")
    await expect(publish(root, [f])).rejects.toThrow()
    expect(await readFile(join(root, f.path), "utf8")).toBe("user")
    await rm(join(root, f.path))
    await expect(publish(root, [{ ...f, before: f.after }])).rejects.toThrow()
    await expect(publish(root, [file("../escape")])).rejects.toThrow()
  }))

test("preserves a destination created during authorization and rejects links", async () =>
  fixture(async (root) => {
    const f = file("dest")
    const authorize = Effect.promise(() => writeFile(join(root, "dest"), "user"))
    await expect(publish(root, [f], authorize)).rejects.toThrow()
    expect(await readFile(join(root, "dest"), "utf8")).toBe("user")
    if (process.platform !== "win32") {
      await symlink(join(root, "dest"), join(root, "link"))
      await expect(publish(root, [file("link")])).rejects.toThrow()
      await symlink(root, join(root, "parent"))
      await expect(publish(root, [file("parent/nested")])).rejects.toThrow()
    }
  }))

test("retry resumes partial publication after authorization fails", async () =>
  fixture(async (root) => {
    const files = [file("first"), file("second")]
    let calls = 0
    const authorize = Effect.suspend(() =>
      ++calls === 2 ? Effect.fail(new Error("interrupted")) : Effect.void,
    )
    await expect(
      Effect.runPromise(publishMigrationFiles({ root, files, authorize })),
    ).rejects.toThrow()
    expect(await readFile(join(root, "first"), "utf8")).toBe("data\n")
    await publish(root, files)
    await verify(root, files)
  }))

test("cleanup retains tracked, modified and unknown files and removes matching untracked files", async () =>
  fixture(async (root) => {
    await mkdir(join(root, ".holyagent"))
    for (const name of ["tracked", "modified", "safe", "unknown"])
      await writeFile(join(root, ".holyagent", name), name === "modified" ? "new" : "old")
    const source = ["tracked", "modified", "safe"].map((name) => ({
      path: `.holyagent/${name}`,
      digest: digest("old"),
      tracked: name === "tracked",
    }))
    const result = await Effect.runPromise(
      cleanupMigrationSources({
        root,
        source,
        authorize: Effect.void,
        isTracked: () => Effect.succeed(false),
      }),
    )
    expect(result.removed).toEqual([".holyagent/safe"])
    expect(result.retained.map((x) => x.path)).toEqual([
      ".holyagent/tracked",
      ".holyagent/modified",
    ])
    expect(await readFile(join(root, ".holyagent/modified"), "utf8")).toBe("new")
    const unknown = await Effect.runPromise(
      cleanupMigrationSources({
        root,
        source: [{ path: ".holyagent/unknown", digest: digest("old"), tracked: false }],
        authorize: Effect.void,
      }),
    )
    expect(unknown.retained).toHaveLength(1)
    await Effect.runPromise(
      cleanupMigrationSources({
        root,
        source,
        authorize: Effect.void,
        isTracked: () => Effect.succeed(false),
      }),
    )
  }))

test("a committed preimage is replaced only while unchanged, and retry is idempotent", async () =>
  fixture(async (root) => {
    const path = join(root, "record")
    const f = { ...file("record", "new"), before: digest("old") }
    await writeFile(path, "old")
    await Effect.runPromise(verifyMigrationFilePreimages({ root, files: [f] }))
    const change = Effect.promise(() => writeFile(path, "user edit"))
    await expect(publish(root, [f], change)).rejects.toThrow()
    expect(await readFile(path, "utf8")).toBe("user edit")
    await expect(
      Effect.runPromise(verifyMigrationFilePreimages({ root, files: [f] })),
    ).rejects.toThrow()
    await writeFile(path, "old")
    await publish(root, [f])
    await publish(root, [f])
    await verify(root, [f])
    expect(await readFile(path, "utf8")).toBe("new")
  }))

test("cleanup rechecks authorization after an asynchronous tracking check", async () =>
  fixture(async (root) => {
    await writeFile(join(root, "record"), "old")
    let allowed = true
    let checks = 0
    const authorize = Effect.suspend(() =>
      allowed ? Effect.void : Effect.fail(new Error("revoked")),
    )
    const isTracked = () =>
      Effect.sync(() => {
        if (++checks === 2) allowed = false
        return false
      })
    const source = [{ path: "record", digest: digest("old"), tracked: false }]
    await expect(
      Effect.runPromise(cleanupMigrationSources({ root, source, authorize, isTracked })),
    ).rejects.toThrow()
    expect(await readFile(join(root, "record"), "utf8")).toBe("old")
  }))
