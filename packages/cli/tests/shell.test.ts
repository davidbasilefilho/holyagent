import { describe, expect, test } from "bun:test"

import { pathKey, pathWithBunBin } from "../src/shell.ts"

describe("pathKey", () => {
  test("finds a Windows Path however it is spelled, and prefers an exact PATH", () => {
    expect(pathKey({ Path: "C:\\bin" }, true)).toBe("Path")
    expect(pathKey({ pAtH: "x" }, true)).toBe("pAtH")
    expect(pathKey({ Path: "a", PATH: "b" }, true)).toBe("PATH")
    expect(pathKey({}, true)).toBe("PATH")
  })

  test("names are exact where the platform is case-sensitive", () => {
    expect(pathKey({ Path: "x" }, false)).toBe("PATH")
  })
})

describe("pathWithBunBin", () => {
  test("extends a Windows Path in place with a semicolon and BUN_INSTALL's bin", () => {
    const found = pathWithBunBin(
      { Path: "C:\\Windows;C:\\Tools" },
      { home: "C:\\Users\\me", bunInstall: "D:\\bun", delimiter: ";", insensitive: true },
    )
    expect(found.key).toBe("Path")
    expect(found.value.startsWith("C:\\Windows;C:\\Tools;")).toBe(true)
    expect(found.value.endsWith("bin")).toBe(true)
    expect(found.bunBin).toBe(found.value.slice("C:\\Windows;C:\\Tools;".length))
    expect(found.bunBin).toContain("bun")
  })

  test("without BUN_INSTALL the directory is .bun/bin under the home directory", () => {
    const found = pathWithBunBin({ PATH: "/usr/bin" }, { home: "/home/me", delimiter: ":" })
    expect(found).toEqual({
      key: "PATH",
      value: "/usr/bin:/home/me/.bun/bin",
      bunBin: "/home/me/.bun/bin",
    })
  })

  test("an empty BUN_INSTALL counts as unset, and a missing PATH gives just the directory", () => {
    const found = pathWithBunBin({}, { home: "/home/me", bunInstall: "", delimiter: ":" })
    expect(found.value).toBe(":/home/me/.bun/bin")
  })

  test("the platform's delimiter is the default", () => {
    const found = pathWithBunBin({ PATH: "a" }, { home: "/h" })
    expect(found.value.startsWith(`a${process.platform === "win32" ? ";" : ":"}`)).toBe(true)
  })
})
