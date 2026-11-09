import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { listTree } from "../src/instructions/requirements.ts"
import { scaffold } from "../src/instructions/scaffold.ts"

let root = ""
const family = (name: string, ...path: Array<string>) => join(root, name, ...path)

/** A requirements tree with a nested file, an empty folder, a guide and a non-Markdown file. */
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-scaffold-"))
  await Bun.write(join(root, "requirements/top.md"), "- R-TOP: top\n")
  await Bun.write(join(root, "requirements/nested/deep/leaf.md"), "- R-LEAF: leaf\n")
  await Bun.write(join(root, "requirements/guide.md"), "not mirrored\n")
  await Bun.write(join(root, "requirements/notes.txt"), "not mirrored\n")
  await mkdir(join(root, "requirements/empty-folder"))
})

afterEach(() => rm(root, { recursive: true, force: true }))

const run = (families: ReadonlyArray<string> = ["one", "two"]) =>
  Effect.runPromise(scaffold(root, families))

describe("scaffold", () => {
  test("copies every folder and mirrored Markdown file into each family as empty files", async () => {
    expect(await run()).toEqual([
      "one/nested/deep/leaf.md",
      "one/top.md",
      "two/nested/deep/leaf.md",
      "two/top.md",
    ])
    for (const name of ["one", "two"]) {
      const { directories, files } = await Effect.runPromise(listTree(family(name)))
      expect(files).toEqual(["nested/deep/leaf.md", "top.md"])
      expect(directories).toEqual(["empty-folder", "nested", "nested/deep"])
      for (const file of files) expect(await Bun.file(family(name, file)).text()).toBe("")
    }
  })

  test("creates nothing when run again", async () => {
    await run()
    expect(await run()).toEqual([])
  })

  test("never overwrites a file with content, and adds only what is missing", async () => {
    await run()
    await Bun.write(family("one", "top.md"), "translated\n")
    await Bun.write(family("two", "nested/deep/leaf.md"), "also translated\n")
    await rm(family("two", "top.md"))
    expect(await run()).toEqual(["two/top.md"])
    expect(await Bun.file(family("one", "top.md")).text()).toBe("translated\n")
    expect(await Bun.file(family("two", "nested/deep/leaf.md")).text()).toBe("also translated\n")
    expect(await Bun.file(family("two", "top.md")).text()).toBe("")
  })

  test("leaves files that the requirements do not name, and the requirements, as they are", async () => {
    await Bun.write(family("one", "guide.md"), "guide\n")
    await Bun.write(family("one", "root-core.ts"), "code\n")
    await run(["one"])
    expect((await readdir(family("one"))).toSorted()).toEqual([
      "empty-folder",
      "guide.md",
      "nested",
      "root-core.ts",
      "top.md",
    ])
    expect(await Bun.file(family("one", "guide.md")).text()).toBe("guide\n")
    expect(await Bun.file(family("one", "root-core.ts")).text()).toBe("code\n")
    expect(await Bun.file(join(root, "requirements/top.md")).text()).toBe("- R-TOP: top\n")
    expect(await Bun.file(family("one", "notes.txt")).exists()).toBe(false)
  })

  test("fails with a tagged error when the requirements folder is missing or a folder is blocked by a file", async () => {
    await rm(join(root, "requirements"), { recursive: true })
    const missing = await Effect.runPromise(Effect.flip(scaffold(root, ["one"])))
    expect(missing._tag).toBe("InstructionsError")

    await Bun.write(join(root, "requirements/nested/leaf.md"), "- R-LEAF: leaf\n")
    await Bun.write(family("one", "nested"), "a file where a folder belongs\n")
    const blocked = await Effect.runPromise(Effect.flip(scaffold(root, ["one"])))
    expect(blocked._tag).toBe("InstructionsError")
  })
})
