import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import { Effect } from "effect"

import {
  applyPatch,
  parsePatch,
  type PatchError,
  PatchFileError,
  type PatchFs,
  seekSequence,
} from "../../src/pi/codex/apply-patch.ts"

const CWD = resolve("/work/project")
const at = (path: string) => resolve(CWD, path)

/** An in-memory file system that records the order of its writes and removals. */
const memory = (files: Readonly<Record<string, string>> = {}) => {
  const store = new Map(Object.entries(files).map(([path, text]) => [at(path), text]))
  const log: Array<string> = []
  const fs: PatchFs = {
    read: (path) => Effect.succeed(store.get(path)),
    write: (path, text) =>
      Effect.sync(() => {
        store.set(path, text)
        log.push(`write ${path}`)
      }),
    remove: (path) =>
      store.has(path)
        ? Effect.sync(() => {
            store.delete(path)
            log.push(`remove ${path}`)
          })
        : Effect.fail(new PatchFileError({ path, reason: "no such file" })),
  }
  return { fs, store, log, text: (path: string) => store.get(at(path)) }
}

const patch = (...lines: ReadonlyArray<string>) =>
  ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")

const run = (text: string, fs: PatchFs) => Effect.runPromise(applyPatch(text, CWD, fs))
const fails = (text: string, fs: PatchFs): Promise<PatchError> =>
  Effect.runPromise(Effect.flip(applyPatch(text, CWD, fs)))

describe("parsePatch", () => {
  test("reads add, delete and update operations with hunks, a move and an end-of-file marker", async () => {
    const operations = await Effect.runPromise(
      parsePatch(
        patch(
          "*** Add File: a.txt",
          "+one",
          "+two",
          "*** Delete File: b.txt",
          "*** Update File: c.txt",
          "*** Move to: d.txt",
          "@@ def f():",
          " keep",
          "-old",
          "+new",
          "@@",
          "-tail",
          "+tail!",
          "*** End of File",
        ),
      ),
    )
    expect(operations).toEqual([
      { kind: "add", path: "a.txt", text: "one\ntwo\n" },
      { kind: "delete", path: "b.txt" },
      {
        kind: "update",
        path: "c.txt",
        moveTo: "d.txt",
        hunks: [
          {
            context: "def f():",
            oldLines: ["keep", "old"],
            newLines: ["keep", "new"],
            endOfFile: false,
          },
          { context: undefined, oldLines: ["tail"], newLines: ["tail!"], endOfFile: true },
        ],
      },
    ])
  })

  test("accepts a first hunk without @@ and a heredoc around the patch", async () => {
    const operations = await Effect.runPromise(
      parsePatch(`<<'EOF'\n${patch("*** Update File: x", " a", "-b", "+c")}\nEOF`),
    )
    expect(operations).toEqual([
      {
        kind: "update",
        path: "x",
        moveTo: undefined,
        hunks: [
          { context: undefined, oldLines: ["a", "b"], newLines: ["a", "c"], endOfFile: false },
        ],
      },
    ])
  })

  test("refuses a patch without its markers, with an unknown operation, or with an empty update", async () => {
    const reason = async (text: string) =>
      (await Effect.runPromise(Effect.flip(parsePatch(text)))).message
    expect(await reason("*** Update File: a\n@@\n-x\n+y")).toContain("*** Begin Patch")
    expect(await reason("*** Begin Patch\n*** Update File: a\n@@\n-x\n+y")).toContain(
      "*** End Patch",
    )
    expect(await reason(patch("*** Rename File: a"))).toContain("not a valid file operation")
    expect(await reason(patch("*** Update File: a"))).toContain("has no hunks")
    expect(await reason(patch("*** Update File: a", "@@", "oops"))).toContain(
      "Every line should start with ' '",
    )
    expect(await reason(patch())).toContain("no file operations")
  })
})

describe("seekSequence", () => {
  test("matches exactly, then by trailing and surrounding whitespace, then by ASCII-folded punctuation", () => {
    const lines = ["a", "b  ", "  c", "d — e", "f"]
    expect(seekSequence(lines, ["b"], 0, false)).toBe(1)
    expect(seekSequence(lines, ["c"], 0, false)).toBe(2)
    expect(seekSequence(lines, ["d - e"], 0, false)).toBe(3)
    expect(seekSequence(lines, ["zzz"], 0, false)).toBeUndefined()
  })

  test("starts at the given line and looks at the end first for an end-of-file pattern", () => {
    const lines = ["x", "y", "x", "y"]
    expect(seekSequence(lines, ["x", "y"], 1, false)).toBe(2)
    expect(seekSequence(lines, ["x", "y"], 0, true)).toBe(2)
    expect(seekSequence(lines, [], 3, false)).toBe(3)
  })
})

describe("applyPatch", () => {
  test("adds, updates, moves and deletes files and reports each as Codex does", async () => {
    const { fs, text, store } = memory({
      "src/old.ts": "export const a = 1\nexport const b = 2\n",
      "src/move.ts": "keep\nchange me\n",
      "gone.txt": "bye\n",
    })
    const result = await run(
      patch(
        "*** Add File: src/new/file.ts",
        "+export const c = 3",
        "*** Update File: src/old.ts",
        "@@",
        " export const a = 1",
        "-export const b = 2",
        "+export const b = 20",
        "*** Update File: src/move.ts",
        "*** Move to: src/moved.ts",
        "@@",
        " keep",
        "-change me",
        "+changed",
        "*** Delete File: gone.txt",
      ),
      fs,
    )
    expect(result.summary).toBe(
      "Success. Updated the following files:\nA src/new/file.ts\nM src/old.ts\nM src/moved.ts\nD gone.txt",
    )
    expect(text("src/new/file.ts")).toBe("export const c = 3\n")
    expect(text("src/old.ts")).toBe("export const a = 1\nexport const b = 20\n")
    expect(text("src/moved.ts")).toBe("keep\nchanged\n")
    expect(store.has(at("src/move.ts"))).toBe(false)
    expect(store.has(at("gone.txt"))).toBe(false)
  })

  test("places a hunk by its @@ context line and applies several hunks in file order", async () => {
    const { fs, text } = memory({
      "m.py": ["def one():", "    return 1", "", "def two():", "    return 1", ""].join("\n"),
    })
    // The second hunk's context lies before the first: Codex's matcher moves forward only, so the
    // patch fails whole and nothing changes.
    const error = await fails(
      patch(
        "*** Update File: m.py",
        "@@ def two():",
        "-    return 1",
        "+    return 2",
        "@@ def one():",
        "-    return 1",
        "+    return 0",
      ),
      fs,
    )
    expect(error.message).toContain("Failed to find context 'def one():'")
    expect(text("m.py")).toContain("def one():\n    return 1")
    await run(
      patch(
        "*** Update File: m.py",
        "@@ def one():",
        "-    return 1",
        "+    return 0",
        "@@ def two():",
        "-    return 1",
        "+    return 2",
      ),
      fs,
    )
    expect(text("m.py")).toBe(
      ["def one():", "    return 0", "", "def two():", "    return 2", ""].join("\n"),
    )
  })

  test("appends the lines of a hunk with nothing to match, and handles an end-of-file hunk", async () => {
    const { fs, text } = memory({ "log.txt": "a\nb\nb\n" })
    await run(patch("*** Update File: log.txt", "@@", "+c"), fs)
    expect(text("log.txt")).toBe("a\nb\nb\nc\n")
    const eof = memory({ "log.txt": "a\nb\nb\n" })
    await run(patch("*** Update File: log.txt", "@@", " b", "-b", "+B", "*** End of File"), eof.fs)
    expect(eof.text("log.txt")).toBe("a\nb\nB\n")
  })

  test("matches through whitespace and typographic punctuation, and keeps a file's CRLF endings", async () => {
    const { fs, text } = memory({ "w.txt": "name — value  \r\nnext\r\n" })
    await run(patch("*** Update File: w.txt", "@@", "-name - value", "+name = value"), fs)
    expect(text("w.txt")).toBe("name = value\r\nnext\r\n")
  })

  test("adds a missing final newline and overwrites a file that Add File names", async () => {
    const { fs, text } = memory({ "n.txt": "no newline", "o.txt": "old\n" })
    await run(patch("*** Update File: n.txt", "@@", "-no newline", "+now newline"), fs)
    await run(patch("*** Add File: o.txt", "+fresh"), fs)
    expect(text("n.txt")).toBe("now newline\n")
    expect(text("o.txt")).toBe("fresh\n")
  })

  test("a hunk that does not match fails the whole patch and writes nothing", async () => {
    const { fs, text, log } = memory({ "a.txt": "one\ntwo\n", "b.txt": "three\n" })
    const error = await fails(
      patch(
        "*** Update File: a.txt",
        "@@",
        "-one",
        "+1",
        "*** Update File: b.txt",
        "@@",
        "-not there",
        "+x",
        "*** Add File: c.txt",
        "+c",
      ),
      fs,
    )
    expect(error._tag).toBe("PatchContextError")
    expect(error.message).toContain("Failed to find expected lines")
    expect(error.message).toContain("not there")
    expect(error.message).toContain("b.txt")
    expect(log).toEqual([])
    expect(text("a.txt")).toBe("one\ntwo\n")
    expect(text("c.txt")).toBeUndefined()
  })

  test("a missing context line, a missing file to update or delete, and a bad patch are refused by kind", async () => {
    const { fs } = memory({ "a.txt": "one\n" })
    expect(
      (await fails(patch("*** Update File: a.txt", "@@ nowhere", "-one", "+two"), fs))._tag,
    ).toBe("PatchContextError")
    expect((await fails(patch("*** Update File: missing.txt", "@@", "-a", "+b"), fs))._tag).toBe(
      "PatchFileError",
    )
    expect((await fails(patch("*** Delete File: missing.txt"), fs))._tag).toBe("PatchFileError")
    expect((await fails("not a patch", fs))._tag).toBe("PatchSyntaxError")
  })

  test("a later operation sees the effect of an earlier one in the same patch", async () => {
    const { fs, text } = memory()
    await run(
      patch(
        "*** Add File: t.txt",
        "+a",
        "+b",
        "*** Update File: t.txt",
        "@@",
        "-b",
        "+c",
        "*** Update File: t.txt",
        "*** Move to: u.txt",
        "@@",
        " a",
        "+between",
      ),
      fs,
    )
    expect(text("t.txt")).toBeUndefined()
    expect(text("u.txt")).toBe("a\nbetween\nc\n")
  })

  test("refuses an absolute path and a path that leaves the working directory", async () => {
    for (const path of [resolve("/etc/passwd"), "../outside.txt", "src/../../outside.txt"]) {
      const { fs, log } = memory()
      const error = await fails(patch(`*** Add File: ${path}`, "+x"), fs)
      expect(error._tag).toBe("PatchPathError")
      expect(log).toEqual([])
    }
    const moved = memory({ "a.txt": "x\n" })
    expect(
      (
        await fails(
          patch("*** Update File: a.txt", "*** Move to: ../b.txt", "@@", "-x", "+y"),
          moved.fs,
        )
      )._tag,
    ).toBe("PatchPathError")
    expect(moved.log).toEqual([])
  })

  test("accepts a folder whose name only starts with two dots", async () => {
    const { fs, text } = memory()
    await run(patch("*** Add File: ..hidden/file.txt", "+x"), fs)
    expect(text("..hidden/file.txt")).toBe("x\n")
  })
})
