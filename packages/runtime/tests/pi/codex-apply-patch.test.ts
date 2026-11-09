import { describe, expect, test } from "bun:test"
import { resolve, sep } from "node:path"

import { Effect } from "effect"

import {
  applyPatch,
  parsePatch,
  type PatchError,
  PatchFileError,
  type PatchFs,
  seekSequence,
  type Snapshot,
} from "../../src/pi/codex/apply-patch.ts"

const CWD = resolve("/work/project")
const at = (path: string) => resolve(CWD, path)

/**
 * An in-memory file system that records the order of its writes and removals. `links` maps a path
 * of the project to where it really leads, as a symbolic link does; `fileLinks` names those that
 * are links themselves (they hold no file, and removing one leaves its target); the first write to
 * a path of `failing` fails and leaves the file as it was.
 */
const memory = (
  files: Readonly<Record<string, string>> = {},
  options: {
    readonly links?: Readonly<Record<string, string>>
    readonly fileLinks?: ReadonlyArray<string>
    readonly failing?: ReadonlyArray<string>
  } = {},
) => {
  const store = new Map(Object.entries(files).map(([path, text]) => [at(path), text]))
  const log: Array<string> = []
  const links = Object.entries(options.links ?? {}).map(([from, to]) => [at(from), to] as const)
  // The links that are present, by the path of the link, with the target each holds.
  const present = new Map(
    (options.fileLinks ?? []).map((name) => [at(name), options.links?.[name] ?? ""] as const),
  )
  // Each path fails once, on its first write.
  const failing = (options.failing ?? []).map(at)
  const fs: PatchFs = {
    real: (path) =>
      Effect.succeed(
        links.reduce(
          (current, [from, to]) =>
            current === from || current.startsWith(`${from}${sep}`)
              ? `${to}${current.slice(from.length)}`
              : current,
          path,
        ),
      ),
    read: (path) => Effect.succeed(store.get(path)),
    write: (path, text) =>
      failing.includes(path)
        ? Effect.suspend(() => {
            failing.splice(failing.indexOf(path), 1)
            return Effect.fail(new PatchFileError({ path, reason: "disk full" }))
          })
        : Effect.sync(() => {
            store.set(path, text)
            log.push(`write ${path}`)
          }),
    remove: (path) =>
      store.has(path) || present.has(path)
        ? Effect.sync(() => {
            store.delete(path)
            present.delete(path)
            log.push(`remove ${path}`)
          })
        : Effect.fail(new PatchFileError({ path, reason: "no such file" })),
    snapshot: (path) => {
      const target = present.get(path)
      const text = store.get(path)
      return Effect.succeed<Snapshot | undefined>(
        target !== undefined
          ? { kind: "link", target }
          : text === undefined
            ? undefined
            : { kind: "file", bytes: new TextEncoder().encode(text), mode: 0o644 },
      )
    },
    kind: (path) =>
      Effect.succeed(present.has(path) ? "link" : store.has(path) ? "file" : undefined),
    restore: (path, saved) =>
      Effect.sync(() => {
        if (saved.kind === "link") {
          store.delete(path)
          present.set(path, saved.target)
        } else store.set(path, new TextDecoder().decode(saved.bytes))
        log.push(`write ${path}`)
      }),
  }
  return { fs, store, log, present, text: (path: string) => store.get(at(path)) }
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
    const missingDelete = await fails(patch("*** Delete File: missing.txt"), fs)
    expect(missingDelete).toMatchObject({ _tag: "PatchFileError", path: "missing.txt" })
    expect(missingDelete.message).toContain("delete")
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

  test("a move to the file's own path is a plain update: the file stays and has the new text", async () => {
    for (const moveTo of ["a.txt", "./a.txt", "src/../a.txt"]) {
      const { fs, text, store } = memory({ "a.txt": "one\ntwo\n" })
      const result = await run(
        patch("*** Update File: a.txt", `*** Move to: ${moveTo}`, "@@", "-one", "+1"),
        fs,
      )
      expect(text("a.txt")).toBe("1\ntwo\n")
      expect(store.has(at("a.txt"))).toBe(true)
      expect(result.changes).toEqual([{ status: "M", path: moveTo }])
    }
  })

  test("a path that leads out of the project through a symbolic link is refused before any write", async () => {
    const outside = resolve("/elsewhere")
    const { fs, log, store } = memory({ "ok.txt": "x\n" }, { links: { linked: outside } })
    for (const operation of [
      ["*** Add File: linked/new.txt", "+x"],
      ["*** Add File: linked/deeper/new.txt", "+x"],
      ["*** Delete File: linked"],
    ]) {
      const error = await fails(patch("*** Add File: first.txt", "+1", ...operation), fs)
      expect(error._tag).toBe("PatchPathError")
    }
    const moved = await fails(
      patch("*** Update File: ok.txt", "*** Move to: linked/ok.txt", "@@", "-x", "+y"),
      fs,
    )
    expect(moved._tag).toBe("PatchPathError")
    expect(log).toEqual([])
    expect(store.has(at("first.txt"))).toBe(false)
  })

  test("a link that stays inside the project is followed without complaint", async () => {
    const { fs, text } = memory({}, { links: { alias: at("real") } })
    await run(patch("*** Add File: alias/file.txt", "+x"), fs)
    expect(text("real/file.txt")).toBe("x\n")
  })

  test("two names of one file through a link are one file in the plan", async () => {
    const links = { alias: at("real") }
    const first = memory({ "real/a.txt": "one\ntwo\n" }, { links })
    await run(
      patch(
        "*** Update File: real/a.txt",
        "@@",
        "-one",
        "+1",
        "*** Update File: alias/a.txt",
        "@@",
        "-two",
        "+2",
      ),
      first.fs,
    )
    expect(first.text("real/a.txt")).toBe("1\n2\n")

    // A move to the other name of the same file is a plain update, not a delete of the file.
    const moved = memory({ "real/a.txt": "one\n" }, { links })
    await run(
      patch("*** Update File: real/a.txt", "*** Move to: alias/a.txt", "@@", "-one", "+1"),
      moved.fs,
    )
    expect(moved.text("real/a.txt")).toBe("1\n")

    const deleted = memory({ "real/a.txt": "one\n" }, { links })
    await run(
      patch("*** Update File: real/a.txt", "@@", "-one", "+1", "*** Delete File: alias/a.txt"),
      deleted.fs,
    )
    expect(deleted.store.has(at("real/a.txt"))).toBe(false)
    expect(deleted.log).toEqual([`remove ${at("real/a.txt")}`])
  })

  test("deletes a link that leads out of the project by unlinking it, and puts it back as a link", async () => {
    const outside = resolve("/elsewhere/victim.txt")
    const unlinked = memory({}, { links: { "out.txt": outside }, fileLinks: ["out.txt"] })
    await run(patch("*** Delete File: out.txt"), unlinked.fs)
    expect(unlinked.log).toEqual([`remove ${at("out.txt")}`])
    expect(unlinked.present.has(at("out.txt"))).toBe(false)

    const { fs, present, log } = memory(
      { "c.txt": "keep\n" },
      { links: { "out.txt": outside }, fileLinks: ["out.txt"], failing: ["c.txt"] },
    )
    const error = await fails(
      patch("*** Delete File: out.txt", "*** Update File: c.txt", "@@", "-keep", "+changed"),
      fs,
    )
    expect(error).toMatchObject({ _tag: "PatchFileError", reason: "disk full" })
    expect(present.get(at("out.txt"))).toBe(outside)
    expect(log).toEqual([
      `remove ${at("out.txt")}`,
      `write ${at("c.txt")}`,
      `write ${at("out.txt")}`,
    ])

    // Updating or adding through the same link still writes outside, so it is refused.
    const through = memory({}, { links: { "out.txt": outside }, fileLinks: ["out.txt"] })
    expect((await fails(patch("*** Add File: out.txt", "+x"), through.fs))._tag).toBe(
      "PatchPathError",
    )
  })

  test("deleting a link and adding its path in one patch makes a regular file there and leaves the target", async () => {
    const outside = resolve("/elsewhere/victim.txt")
    const { fs, store, present, log } = memory(
      {},
      { links: { "out.txt": outside }, fileLinks: ["out.txt"] },
    )
    await run(patch("*** Delete File: out.txt", "*** Add File: out.txt", "+new"), fs)
    expect(present.has(at("out.txt"))).toBe(false)
    expect(store.get(at("out.txt"))).toBe("new\n")
    expect(store.has(outside)).toBe(false)
    expect(log).toEqual([`remove ${at("out.txt")}`, `write ${at("out.txt")}`])

    // A failure later in the patch puts the link back where the file now is.
    const undone = memory(
      { "c.txt": "keep\n" },
      { links: { "out.txt": outside }, fileLinks: ["out.txt"], failing: ["c.txt"] },
    )
    const error = await fails(
      patch(
        "*** Delete File: out.txt",
        "*** Add File: out.txt",
        "+new",
        "*** Update File: c.txt",
        "@@",
        "-keep",
        "+changed",
      ),
      undone.fs,
    )
    expect(error).toMatchObject({ _tag: "PatchFileError", reason: "disk full" })
    expect(undone.present.get(at("out.txt"))).toBe(outside)
    expect(undone.store.has(at("out.txt"))).toBe(false)
  })

  test("a write that fails puts back the files already written, so the patch is whole or not at all", async () => {
    const { fs, text, store, log } = memory(
      { "a.txt": "one\n", "gone.txt": "bye\n", "c.txt": "keep\n" },
      { failing: ["c.txt"] },
    )
    const error = await fails(
      patch(
        "*** Update File: a.txt",
        "@@",
        "-one",
        "+1",
        "*** Add File: new.txt",
        "+n",
        "*** Delete File: gone.txt",
        "*** Update File: c.txt",
        "@@",
        "-keep",
        "+changed",
      ),
      fs,
    )
    expect(error).toMatchObject({ _tag: "PatchFileError", reason: "disk full" })
    expect(text("a.txt")).toBe("one\n")
    expect(text("gone.txt")).toBe("bye\n")
    expect(text("c.txt")).toBe("keep\n")
    expect(store.has(at("new.txt"))).toBe(false)
    // Undone newest first: the failed file is written back as it was, the deleted file comes back,
    // the new one goes, the first update is reverted.
    expect(log.slice(3)).toEqual([
      `write ${at("c.txt")}`,
      `write ${at("gone.txt")}`,
      `remove ${at("new.txt")}`,
      `write ${at("a.txt")}`,
    ])
  })

  test("says which files could not be put back when the undo fails too", async () => {
    const { fs } = memory({ "a.txt": "one\n", "b.txt": "two\n" })
    const failingFs: PatchFs = {
      ...fs,
      write: (path, text) =>
        path === at("b.txt")
          ? Effect.fail(new PatchFileError({ path, reason: "read-only" }))
          : fs.write(path, text),
      restore: (path) => Effect.fail(new PatchFileError({ path, reason: "read-only" })),
    }
    const error = await fails(
      patch(
        "*** Update File: a.txt",
        "@@",
        "-one",
        "+1",
        "*** Update File: b.txt",
        "@@",
        "-two",
        "+2",
      ),
      failingFs,
    )
    expect(error.message).toContain("read-only")
    expect(error.message).toContain(`could not restore ${at("b.txt")}, ${at("a.txt")}`)
  })
})
