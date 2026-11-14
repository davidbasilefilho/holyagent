import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  advanceMigrationJournal,
  beginMigrationJournal,
  finishMigrationJournal,
  type MigrationJournal,
  type MigrationJournalLocation,
  readMigrationJournal,
} from "../src/state/migration-journal.ts"

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "holyagent-journal-"))
  if (spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"]).status === 0)
    throw new Error("fixture is inside a Git repository")
  const sourceRoot = join(root, "source")
  const targetRoot = join(root, "target")
  const parent = join(root, "private")
  await Promise.all([sourceRoot, targetRoot, parent].map((path) => mkdir(path, { mode: 0o700 })))
  const location: MigrationJournalLocation = {
    path: join(parent, "journal.json"),
    sourceRoot,
    targetRoot,
  }
  const record: MigrationJournal = {
    version: 1,
    transaction: "fixture-token",
    sourceRoot,
    targetRoot,
    branch: "holyagent/state",
    parent: "a".repeat(40),
    commit: "b".repeat(40),
    tree: "c".repeat(40),
    indexBefore: "d".repeat(64),
    indexAfter: "e".repeat(64),
    files: [
      {
        path: "intents/a/intent.json",
        before: null,
        after: createHash("sha1").update("blob 6\0secret").digest("hex"),
        content: "c2VjcmV0",
        mode: 0o100644,
      },
    ],
    source: [{ path: "intents/a/intent.json", digest: "1".repeat(64), tracked: true }],
    phase: "prepared",
  }
  return { root, location, record, close: () => rm(root, { recursive: true, force: true }) }
}

const failed = async (effect: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(effect)
  expect(exit._tag).toBe("Failure")
  return exit
}

test("journal phases are atomic and stale tokens or phases cannot change the record", async () => {
  const f = await fixture()
  try {
    expect(await Effect.runPromise(readMigrationJournal(f.location))).toBeUndefined()
    await Effect.runPromise(beginMigrationJournal(f.location, f.record, Effect.void))
    expect(await Effect.runPromise(readMigrationJournal(f.location))).toEqual(f.record)
    const before = await readFile(f.location.path, "utf8")
    await failed(beginMigrationJournal(f.location, f.record, Effect.void))
    await failed(
      advanceMigrationJournal(f.location, "other", "prepared", "ref-published", Effect.void),
    )
    await failed(
      advanceMigrationJournal(
        f.location,
        f.record.transaction,
        "prepared",
        "target-published",
        Effect.void,
      ),
    )
    await failed(finishMigrationJournal(f.location, f.record.transaction, Effect.void))
    await failed(
      advanceMigrationJournal(
        f.location,
        f.record.transaction,
        "prepared",
        "ref-published",
        Effect.fail("revoked"),
      ),
    )
    expect(await readFile(f.location.path, "utf8")).toBe(before)
    await Effect.runPromise(
      advanceMigrationJournal(
        f.location,
        f.record.transaction,
        "prepared",
        "ref-published",
        Effect.void,
      ),
    )
    await failed(
      advanceMigrationJournal(
        f.location,
        f.record.transaction,
        "prepared",
        "ref-published",
        Effect.void,
      ),
    )
    await Effect.runPromise(
      advanceMigrationJournal(
        f.location,
        f.record.transaction,
        "ref-published",
        "target-published",
        Effect.void,
      ),
    )
    await Effect.runPromise(
      advanceMigrationJournal(
        f.location,
        f.record.transaction,
        "target-published",
        "source-cleaned",
        Effect.void,
      ),
    )
    await failed(finishMigrationJournal(f.location, "other", Effect.void))
    await Effect.runPromise(finishMigrationJournal(f.location, f.record.transaction, Effect.void))
    expect(await Effect.runPromise(readMigrationJournal(f.location))).toBeUndefined()
  } finally {
    await f.close()
  }
})

test("strict schema, path validation and root binding refuse without overwriting", async () => {
  const f = await fixture()
  try {
    const invalid = [
      { ...f.record, unknown: true },
      { ...f.record, sourceRoot: f.location.targetRoot },
      { ...f.record, files: [{ ...f.record.files[0]!, path: "../outside" }] },
      { ...f.record, files: [{ ...f.record.files[0]!, path: "/absolute" }] },
      { ...f.record, files: [{ ...f.record.files[0]!, content: "not base64" }] },
      { ...f.record, files: [{ ...f.record.files[0]!, after: "f".repeat(40) }] },
      { ...f.record, files: [{ ...f.record.files[0]!, mode: 0o120000 }] },
      { ...f.record, files: [f.record.files[0]!, f.record.files[0]!] },
      { ...f.record, source: [{ ...f.record.source[0]!, path: "a/../../escape" }] },
    ]
    for (const record of invalid)
      await failed(beginMigrationJournal(f.location, record, Effect.void))
    expect(await Effect.runPromise(readMigrationJournal(f.location))).toBeUndefined()
    const foreign = JSON.stringify({ ...f.record, unknown: "secret-value" })
    await writeFile(f.location.path, foreign, { mode: 0o600 })
    const exit = await failed(readMigrationJournal(f.location))
    expect(String(exit)).not.toContain("secret-value")
    await failed(beginMigrationJournal(f.location, f.record, Effect.void))
    expect(await readFile(f.location.path, "utf8")).toBe(foreign)
    await rm(f.location.path)
    await Effect.runPromise(beginMigrationJournal(f.location, f.record, Effect.void))
    await failed(readMigrationJournal({ ...f.location, sourceRoot: f.location.targetRoot }))
  } finally {
    await f.close()
  }
})

test("a journal changed during an authorization wait is not overwritten", async () => {
  const f = await fixture()
  try {
    await Effect.runPromise(beginMigrationJournal(f.location, f.record, Effect.void))
    const newer = `${JSON.stringify({ ...f.record, phase: "ref-published" })}\n`
    const authorize = Effect.promise(() => writeFile(f.location.path, newer))
    await failed(
      advanceMigrationJournal(
        f.location,
        f.record.transaction,
        "prepared",
        "ref-published",
        authorize,
      ),
    )
    expect(await readFile(f.location.path, "utf8")).toBe(newer)
  } finally {
    await f.close()
  }
})

test.skipIf(process.platform === "win32")(
  "symlinks, hardlinks and nonprivate journal files are rejected",
  async () => {
    const f = await fixture()
    try {
      const foreign = join(f.root, "foreign")
      await writeFile(foreign, "foreign bytes", { mode: 0o600 })
      await symlink(foreign, f.location.path)
      await failed(readMigrationJournal(f.location))
      await failed(beginMigrationJournal(f.location, f.record, Effect.void))
      expect(await readFile(foreign, "utf8")).toBe("foreign bytes")
      await rm(f.location.path)
      await Effect.runPromise(beginMigrationJournal(f.location, f.record, Effect.void))
      const alias = join(f.root, "alias")
      await link(f.location.path, alias)
      await failed(readMigrationJournal(f.location))
      await rm(alias)
      // A crash between the exclusive link and temporary-name removal is recoverable.
      const temporary = `${f.location.path}.${crypto.randomUUID()}.tmp`
      await link(f.location.path, temporary)
      expect(await Effect.runPromise(readMigrationJournal(f.location))).toEqual(f.record)
      await Effect.runPromise(
        advanceMigrationJournal(
          f.location,
          f.record.transaction,
          "prepared",
          "ref-published",
          Effect.void,
        ),
      )
      expect(await Bun.file(temporary).exists()).toBe(false)
      await chmod(f.location.path, 0o644)
      await failed(readMigrationJournal(f.location))
      await chmod(f.location.path, 0o600)
      const symlinked = join(f.root, "link")
      await symlink(join(f.root, "private"), symlinked)
      await failed(readMigrationJournal({ ...f.location, path: join(symlinked, "journal.json") }))
      expect(await Effect.runPromise(readMigrationJournal(f.location))).toEqual({
        ...f.record,
        phase: "ref-published",
      })
    } finally {
      await f.close()
    }
  },
)
