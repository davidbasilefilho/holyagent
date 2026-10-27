import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { removeUnpinned, unpinnedFiles } from "./vendor.ts"

const expected = new Set(["linux-x64/rg", "linux-x64/licenses/ripgrep/COPYING"])

describe("unpinnedFiles", () => {
  test("keeps pinned files that a Windows scan reports with backslashes", () => {
    const scanned = ["linux-x64\\rg", "linux-x64\\licenses\\ripgrep\\COPYING", "stray.txt"]
    expect(unpinnedFiles(scanned, expected, "\\")).toEqual(["stray.txt"])
  })

  test("names an unpinned file in a nested folder", () => {
    expect(unpinnedFiles(["linux-x64\\licenses\\other\\NOTICE"], expected, "\\")).toEqual([
      "linux-x64\\licenses\\other\\NOTICE",
    ])
  })
})

describe("removeUnpinned", () => {
  test("removes a stray file and leaves the pinned ones, whatever the platform separator", async () => {
    const folder = await mkdtemp(join(tmpdir(), "vendor-"))
    try {
      await mkdir(join(folder, "linux-x64", "licenses", "ripgrep"), { recursive: true })
      for (const file of [...expected, "linux-x64/stray.txt"])
        await Bun.write(join(folder, file), "x")
      expect(await removeUnpinned(folder, expected)).toEqual([join("linux-x64", "stray.txt")])
      for (const file of expected) expect(await Bun.file(join(folder, file)).exists()).toBe(true)
      expect(await Bun.file(join(folder, "linux-x64", "stray.txt")).exists()).toBe(false)
    } finally {
      await rm(folder, { recursive: true, force: true })
    }
  })
})
