import { describe, expect, test } from "bun:test"

import { $ } from "bun"

import { isCanary } from "./toolchain.ts"

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
