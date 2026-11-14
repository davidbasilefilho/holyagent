import { expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import {
  prepareMigrationCommit,
  publishMigrationIndex,
  verifyMigrationCommit,
  verifyMigrationIndex,
} from "../src/state/migration-index.ts"

const fixture = async (run: (cwd: string, git: (...args: string[]) => string) => Promise<void>) => {
  const cwd = await mkdtemp(join(tmpdir(), "holyagent-index-test-"))
  const env = { ...process.env, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1" }
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" })
  try {
    expect(spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, env }).status).not.toBe(0)
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.test")
    await writeFile(join(cwd, "foreign"), "original\n")
    git("add", "foreign")
    git("commit", "-q", "-m", "base")
    await run(cwd, git)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

const input = {
  path: ".holyagent/intents/one.json",
  content: Buffer.from("record\n").toString("base64"),
  mode: 0o100644,
}
const authorize = Effect.void
const prepare = (cwd: string) =>
  Effect.runPromise(
    prepareMigrationCommit({
      cwd,
      env: { HOME: cwd },
      files: [input],
      message: "migrate",
      authorize,
    }),
  )
const publish = (cwd: string, files: Awaited<ReturnType<typeof prepare>>["files"]) =>
  Effect.runPromise(publishMigrationIndex({ cwd, env: { HOME: cwd }, files, authorize }))

test("private commit and publication preserve foreign staged and unstaged changes", async () => {
  await fixture(async (cwd, git) => {
    await writeFile(join(cwd, "foreign"), "staged\n")
    git("add", "foreign")
    await writeFile(join(cwd, "foreign"), "unstaged\n")
    const indexBefore = git("ls-files", "--stage")
    const head = git("rev-parse", "HEAD").trim()
    const result = await prepare(cwd)
    expect(git("rev-parse", "HEAD").trim()).toBe(head)
    expect(git("ls-files", "--stage")).toBe(indexBefore)
    expect(git("show", `${result.commit}:foreign`)).toBe("original\n")
    expect(git("show", `${result.commit}:${input.path}`)).toBe("record\n")
    expect(await readFile(join(cwd, "foreign"), "utf8")).toBe("unstaged\n")
    await publish(cwd, result.files)
    expect(git("show", ":foreign")).toBe("staged\n")
    expect(git("show", `:${input.path}`)).toBe("record\n")
    expect(await readFile(join(cwd, "foreign"), "utf8")).toBe("unstaged\n")
    const after = git("ls-files", "--stage")
    await publish(cwd, result.files)
    expect(git("ls-files", "--stage")).toBe(after)
  })
})

test("changed owned entry and lock contention refuse without overwriting the index", async () => {
  await fixture(async (cwd, git) => {
    const result = await prepare(cwd)
    const oid = git("hash-object", "-w", "--stdin").trim()
    git("update-index", "--add", "--cacheinfo", `100644,${oid},${input.path}`)
    const changed = git("ls-files", "--stage")
    await expect(publish(cwd, result.files)).rejects.toThrow()
    expect(git("ls-files", "--stage")).toBe(changed)
    git("update-index", "--force-remove", "--", input.path)
    const before = git("ls-files", "--stage")
    const lock = git("rev-parse", "--path-format=absolute", "--git-path", "index").trim() + ".lock"
    await writeFile(lock, "other owner")
    await expect(publish(cwd, result.files)).rejects.toThrow()
    expect(await readFile(lock, "utf8")).toBe("other owner")
    expect(git("ls-files", "--stage")).toBe(before)
  })
})

test("publication incorporates unrelated staging done after preparation", async () => {
  await fixture(async (cwd, git) => {
    const result = await prepare(cwd)
    await writeFile(join(cwd, "foreign"), "later staged\n")
    git("add", "foreign")
    await publish(cwd, result.files)
    expect(git("show", ":foreign")).toBe("later staged\n")
    expect(git("show", `:${input.path}`)).toBe("record\n")
  })
})

test("refuses owned staged edits and path-prefix conflicts", async () => {
  await fixture(async (cwd, git) => {
    const files = [
      { path: "foreign", content: Buffer.from("original\n").toString("base64"), mode: 0o100644 },
    ]
    await writeFile(join(cwd, "foreign"), "different\n")
    git("add", "foreign")
    const before = git("ls-files", "--stage")
    await expect(
      Effect.runPromise(
        prepareMigrationCommit({ cwd, env: { HOME: cwd }, files, message: "migrate", authorize }),
      ),
    ).rejects.toThrow()
    expect(git("ls-files", "--stage")).toBe(before)
    const overlap = [{ ...input, path: "foreign/child" }]
    await expect(
      Effect.runPromise(
        prepareMigrationCommit({
          cwd,
          env: { HOME: cwd },
          files: overlap,
          message: "migrate",
          authorize,
        }),
      ),
    ).rejects.toThrow()
    expect(git("ls-files", "--stage")).toBe(before)
  })
})

test("read-only verification checks commit and owned index while preserving foreign changes", async () => {
  await fixture(async (cwd, git) => {
    await writeFile(join(cwd, "foreign"), "staged foreign\n")
    git("add", "foreign")
    await writeFile(join(cwd, "foreign"), "unstaged foreign\n")
    const result = await prepare(cwd)
    const opts = { cwd, env: { HOME: cwd }, ...result }
    const originalIndex = git("ls-files", "--stage")
    await Effect.runPromise(verifyMigrationCommit(opts))
    await expect(Effect.runPromise(verifyMigrationIndex(opts))).rejects.toThrow()
    expect(git("ls-files", "--stage")).toBe(originalIndex)
    await publish(cwd, result.files)
    const publishedIndex = git("ls-files", "--stage")
    await Effect.runPromise(verifyMigrationIndex(opts))
    await Effect.runPromise(verifyMigrationCommit(opts))
    expect(git("ls-files", "--stage")).toBe(publishedIndex)
    expect(git("show", ":foreign")).toBe("staged foreign\n")
    expect(await readFile(join(cwd, "foreign"), "utf8")).toBe("unstaged foreign\n")
    git("update-index", "--add", "--cacheinfo", `100755,${result.files[0]!.after},${input.path}`)
    const wrongModeIndex = git("ls-files", "--stage")
    await expect(Effect.runPromise(verifyMigrationIndex(opts))).rejects.toThrow()
    expect(git("ls-files", "--stage")).toBe(wrongModeIndex)
    const oid = git("hash-object", "-w", "--stdin").trim()
    git("update-index", "--add", "--cacheinfo", `100644,${oid},${input.path}`)
    const changedIndex = git("ls-files", "--stage")
    await expect(Effect.runPromise(verifyMigrationIndex(opts))).rejects.toThrow()
    expect(git("ls-files", "--stage")).toBe(changedIndex)
    expect(await readFile(join(cwd, "foreign"), "utf8")).toBe("unstaged foreign\n")
  })
})

test("commit verification rejects wrong parent or tree and extra tree changes", async () => {
  await fixture(async (cwd, git) => {
    const result = await prepare(cwd)
    const opts = { cwd, env: { HOME: cwd }, ...result }
    await expect(
      Effect.runPromise(verifyMigrationCommit({ ...opts, parent: result.commit })),
    ).rejects.toThrow()
    await expect(
      Effect.runPromise(verifyMigrationCommit({ ...opts, tree: result.parent })),
    ).rejects.toThrow()
    await publish(cwd, result.files)
    await writeFile(join(cwd, "foreign"), "unexpected\n")
    git("add", "foreign")
    const extraTree = git("write-tree").trim()
    const extraCommit = git("commit-tree", extraTree, "-p", result.parent, "-m", "extra").trim()
    const indexBefore = git("ls-files", "--stage")
    await expect(
      Effect.runPromise(verifyMigrationCommit({ ...opts, tree: extraTree, commit: extraCommit })),
    ).rejects.toThrow()
    expect(git("ls-files", "--stage")).toBe(indexBefore)
    expect(await readFile(join(cwd, "foreign"), "utf8")).toBe("unexpected\n")
  })
})

test("private commit and verification ignore replacement refs", async () => {
  await fixture(async (cwd, git) => {
    const parent = git("rev-parse", "HEAD").trim()
    const original = git("rev-parse", "HEAD:foreign").trim()
    const other = git("hash-object", "-w", "--stdin").trim()
    git("update-index", "--cacheinfo", `100644,${other},foreign`)
    const replacementTree = git("write-tree").trim()
    const replacement = git("commit-tree", replacementTree, "-m", "replacement").trim()
    git("update-index", "--cacheinfo", `100644,${original},foreign`)
    git("replace", parent, replacement)
    const result = await prepare(cwd)
    expect(git("show", `${result.commit}:foreign`)).toBe("original\n")
    await Effect.runPromise(verifyMigrationCommit({ cwd, env: { HOME: cwd }, ...result }))
  })
})
