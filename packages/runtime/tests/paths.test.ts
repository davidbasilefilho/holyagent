import { describe, expect, test } from "bun:test"

import { Schema } from "effect"

import { firstOverlap, pathProblem, pathsOverlap, PortablePath } from "../src/domain/paths.ts"

describe("portable paths", () => {
  test.each(["src/a.ts", "packages/runtime", "a/b.c/d", "README.md"])("accepts %s", (path) => {
    expect(pathProblem(path)).toBeUndefined()
    expect(Schema.decodeUnknownSync(PortablePath)(path)).toBe(path)
  })

  test.each([
    "/etc/passwd",
    "../outside",
    "src/../../outside",
    "./src",
    "src//a",
    "src/",
    "",
    "a\\b",
    "C:/x",
    "src/a.",
    "a?b",
  ])("rejects %p", (path) => {
    expect(pathProblem(path)).toBeDefined()
    expect(() => Schema.decodeUnknownSync(PortablePath)(path)).toThrow()
  })
})

describe("overlap", () => {
  test("equal paths, directory prefixes and case differences overlap", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true)
    expect(pathsOverlap("src", "src/a.ts")).toBe(true)
    expect(pathsOverlap("src/a.ts", "src")).toBe(true)
    expect(pathsOverlap("SRC/A.ts", "src/a.TS")).toBe(true)
  })

  test("a shared name prefix is not a directory prefix", () => {
    expect(pathsOverlap("src", "src2/a.ts")).toBe(false)
    expect(pathsOverlap("src/a.ts", "src/b.ts")).toBe(false)
    expect(firstOverlap(["x/y", "src"], ["src/a.ts"])).toBe("src")
    expect(firstOverlap(["x"], ["y"])).toBeUndefined()
  })
})
