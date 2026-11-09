import { describe, expect, test } from "bun:test"
import type { rm } from "node:fs/promises"

import { removeTemporary } from "./temp-folder.ts"

/** A remover that fails with each code in turn, then succeeds. */
function flaky(codes: ReadonlyArray<string>) {
  const calls: Array<string> = []
  const remove = ((path: string) => {
    calls.push(path)
    const code = codes[calls.length - 1]
    return code === undefined
      ? Promise.resolve()
      : Promise.reject(Object.assign(new Error(`${code}: rm '${path}'`), { code }))
  }) as unknown as typeof rm
  return { calls, remove }
}

describe("removeTemporary", () => {
  test("retries EBUSY, EPERM and ENOTEMPTY until the folder goes away", async () => {
    const { calls, remove } = flaky(["EBUSY", "EPERM", "ENOTEMPTY"])
    await removeTemporary("folder", remove, 1)
    expect(calls).toEqual(["folder", "folder", "folder", "folder"])
  })

  test("rethrows an error that is not transient without retrying", async () => {
    const { calls, remove } = flaky(["EACCES"])
    await expect(removeTemporary("folder", remove, 1)).rejects.toMatchObject({ code: "EACCES" })
    expect(calls).toHaveLength(1)
  })

  test("gives up with the last error when the folder stays busy", async () => {
    const { calls, remove } = flaky(Array.from({ length: 50 }, () => "EBUSY"))
    await expect(removeTemporary("folder", remove, 1)).rejects.toMatchObject({ code: "EBUSY" })
    expect(calls.length).toBeGreaterThan(1)
    expect(calls.length).toBeLessThan(50)
  })
})
