import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as filesystem from "node:fs/promises"
import { readdir, readFile, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect, Option } from "effect"

import {
  applyDefaults,
  readJsonObject,
  writeJsonObject,
  writeJsonObjectIfUnchanged,
} from "../src/setup/json-file.ts"
import { findCommand, pathKey, pathWithBunBin } from "../src/setup/shell.ts"
import { installPrograms, programName, scratch } from "./setup-fixture.ts"

let directory: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-setup-files-")
  directory = made.directory
  remove = made.remove
})
afterEach(() => remove())

describe("the JSON files setup edits", () => {
  test("a missing file is an empty object", async () => {
    expect(await Effect.runPromise(readJsonObject(join(directory, "none.json")))).toEqual({})
  })

  test("an empty or whitespace-only file is an empty object, as a missing file is", async () => {
    for (const text of ["", "  \n\t\n"]) {
      const file = join(directory, "blank.json")
      await writeFile(file, text)
      expect(await Effect.runPromise(readJsonObject(file))).toEqual({})
    }
  })

  test("a file that is not a JSON object fails naming the file, and is not touched", async () => {
    for (const text of ["[1]", "null", '"x"', "{"]) {
      const file = join(directory, "bad.json")
      await writeFile(file, text)
      const error = await Effect.runPromise(Effect.flip(readJsonObject(file)))
      expect(error._tag).toBe("SetupFailure")
      expect(error.message).toContain(file)
      expect(await readFile(file, "utf8")).toBe(text)
    }
  })

  test("applyDefaults adds only what is missing and reports the rest as present or kept", () => {
    const { merged, entries } = applyDefaults(
      { a: { b: 1 }, flag: true, list: ["x"], scalar: 3, other: "stay" },
      [
        { path: ["a", "b"], value: 1 },
        { path: ["a", "c"], value: 2 },
        { path: ["flag"], value: false },
        { path: ["list"], value: ["x"] },
        { path: ["scalar", "deep"], value: 1 },
        { path: ["fresh", "key"], value: "v" },
      ],
    )
    expect(entries.map((entry) => [entry.path, entry.status])).toEqual([
      ["a.b", "present"],
      ["a.c", "added"],
      ["flag", "kept"],
      ["list", "present"],
      ["scalar", "kept"],
      ["fresh.key", "added"],
    ])
    expect(merged).toEqual({
      a: { b: 1, c: 2 },
      flag: true,
      list: ["x"],
      scalar: 3,
      other: "stay",
      fresh: { key: "v" },
    })
  })

  test("a write makes the folder, ends the file with a newline and leaves no temporary file", async () => {
    const file = join(directory, "deep", "settings.json")
    await Effect.runPromise(writeJsonObject(file, { a: 1 }, { mode: 0o600 }))
    expect(await readFile(file, "utf8")).toBe('{\n  "a": 1\n}\n')
    expect(await readdir(dirname(file))).toEqual(["settings.json"])
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600)
  })

  test("a stale temporary file is never overwritten and the target is left as it was", async () => {
    const file = join(directory, "settings.json")
    const temporary = join(directory, `.settings.json.${process.pid}.tmp`)
    await writeFile(file, '{"old":true}\n')
    await writeFile(temporary, "stale")
    const failure = await Effect.runPromise(Effect.flip(writeJsonObject(file, { a: 1 })))
    expect(failure._tag).toBe("SetupFailure")
    expect(failure.message).toContain(temporary)
    expect(await readFile(temporary, "utf8")).toBe("stale")
    expect(await readFile(file, "utf8")).toBe('{"old":true}\n')
    const guarded = await Effect.runPromise(
      Effect.flip(writeJsonObjectIfUnchanged(file, { a: 1 }, '{"old":true}\n')),
    )
    expect(guarded._tag).toBe("SetupFailure")
    expect(await readFile(temporary, "utf8")).toBe("stale")
  })

  test("a write that fails after creating the temporary file removes it, so a rerun is not blocked", async () => {
    const file = join(directory, "settings.json")
    await writeFile(file, '{"old":true}\n')
    const original = filesystem.writeFile
    const spy = spyOn(filesystem, "writeFile").mockImplementation((async (
      ...args: Parameters<typeof filesystem.writeFile>
    ) => {
      // The file exists with part of the text when the disk fills up.
      await original(args[0], "{", { flag: "wx" })
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
    }) as typeof filesystem.writeFile)
    try {
      const failure = await Effect.runPromise(Effect.flip(writeJsonObject(file, { a: 1 })))
      expect(failure._tag).toBe("SetupFailure")
      expect(failure.message).toContain("ENOSPC")
    } finally {
      spy.mockRestore()
    }
    expect(await readdir(directory)).toEqual(["settings.json"])
    expect(await readFile(file, "utf8")).toBe('{"old":true}\n')
    await Effect.runPromise(writeJsonObject(file, { a: 1 }))
    expect(await readFile(file, "utf8")).toBe('{\n  "a": 1\n}\n')
  })

  test("a folder that cannot be made is reported by its own path", async () => {
    const blocker = join(directory, "blocker")
    await writeFile(blocker, "a file")
    const failure = await Effect.runPromise(
      Effect.flip(writeJsonObject(join(blocker, "sub", "settings.json"), { a: 1 })),
    )
    expect(failure.message).toContain(`cannot write ${join(blocker, "sub")}`)
    expect(failure.message).not.toContain(".tmp")
  })

  test.skipIf(process.platform === "win32")(
    "a symlink in the place of the temporary file is not followed",
    async () => {
      const file = join(directory, "settings.json")
      const victim = join(directory, "victim.txt")
      await writeFile(victim, "keep")
      await symlink(victim, join(directory, `.settings.json.${process.pid}.tmp`))
      const failure = await Effect.runPromise(Effect.flip(writeJsonObject(file, { a: 1 })))
      expect(failure._tag).toBe("SetupFailure")
      expect(await readFile(victim, "utf8")).toBe("keep")
      expect(await Bun.file(file).exists()).toBe(false)
    },
  )
})

describe("finding commands", () => {
  test("pathKey finds a Windows Path however it is spelled, and prefers an exact PATH", () => {
    expect(pathKey({ Path: "C:\\bin" }, true)).toBe("Path")
    expect(pathKey({ pAtH: "x" }, true)).toBe("pAtH")
    expect(pathKey({ Path: "a", PATH: "b" }, true)).toBe("PATH")
    expect(pathKey({}, true)).toBe("PATH")
    expect(pathKey({ Path: "x" }, false)).toBe("PATH")
  })

  test("pathWithBunBin extends a Windows Path in place with BUN_INSTALL's bin", () => {
    const found = pathWithBunBin(
      { Path: "C:\\Windows;C:\\Tools" },
      { home: "C:\\Users\\me", bunInstall: "D:\\bun", delimiter: ";", insensitive: true },
    )
    expect(found.key).toBe("Path")
    expect(found.value.startsWith("C:\\Windows;C:\\Tools;")).toBe(true)
    expect(found.bunBin).toContain("bun")
  })

  test("without BUN_INSTALL the directory is .bun/bin under the home directory", () => {
    // join writes the platform's separator, so the expectation is built the same way.
    const bunBin = join("/home/me", ".bun", "bin")
    expect(pathWithBunBin({ PATH: "/usr/bin" }, { home: "/home/me", delimiter: ":" })).toEqual({
      key: "PATH",
      value: `/usr/bin:${bunBin}`,
      bunBin,
    })
    expect(pathWithBunBin({}, { home: "/home/me", bunInstall: "", delimiter: ":" }).value).toBe(
      `:${bunBin}`,
    )
  })

  test("findCommand looks on PATH, and in Bun's global bin directory only when asked", async () => {
    const onPath = join(directory, "onpath")
    await installPrograms(directory)
    const env = { HOME: directory, PATH: onPath }
    expect(Option.isNone(findCommand(env, "ctx7"))).toBe(true)
    const found = findCommand(env, "ctx7", { includeBunBin: true })
    expect(Option.getOrUndefined(found)).toBe(join(directory, ".bun", "bin", programName("ctx7")))
    expect(Option.isNone(findCommand(env, "missing-program", { includeBunBin: true }))).toBe(true)
  })
})
