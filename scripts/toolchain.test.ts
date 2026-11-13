import { describe, expect, test } from "bun:test"

import { $ } from "bun"

import { isCanary, upgradeEnvironment } from "./toolchain.ts"

describe("isCanary", () => {
  test("names a canary build by its revision text", () => {
    expect(isCanary("1.4.5-canary.20260901.1+0a1b2c3d")).toBe(true)
    expect(isCanary("1.4.4+38afee6c8")).toBe(false)
    expect(isCanary("")).toBe(false)
  })
})

describe("the toolchain script", () => {
  test("refuses an unknown mode with exit code 2 and no shell", async () => {
    const result = await $`${process.execPath} ${import.meta.dir}/toolchain.ts nonsense`
      .quiet()
      .nothrow()
    expect(result.exitCode).toBe(2)
    expect(result.stderr.toString()).toContain("usage:")
  })
})

describe("the upgrade environment", () => {
  test("drops inherited flags and PowerShell 7 modules only for the Windows child", () => {
    const env = { BUN_OPTIONS: "--smol", PSModulePath: "PowerShell7/Modules", PATH: "keep" }
    expect(upgradeEnvironment(env, "win32")).toEqual({
      BUN_OPTIONS: undefined,
      PSModulePath: undefined,
      PATH: "keep",
    })
    expect(upgradeEnvironment(env, "linux").PSModulePath).toBe(env.PSModulePath)
    expect(env.BUN_OPTIONS).toBe("--smol")
  })
})
