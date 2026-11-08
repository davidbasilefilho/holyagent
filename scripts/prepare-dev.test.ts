import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { hasDevToolchain, prepareDev } from "./prepare-dev.ts"

const roots: string[] = []

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "prepare-dev-"))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("the dev toolchain check", () => {
  test("is false when node_modules has no mise, as after a consumer install", async () => {
    expect(hasDevToolchain(await makeRoot())).toBe(false)
  })

  test("is true when node_modules/.bin has the mise shim", async () => {
    const root = await makeRoot()
    const bin = join(root, "node_modules", ".bin")
    await mkdir(bin, { recursive: true })
    const shim = join(bin, process.platform === "win32" ? "mise.cmd" : "mise")
    await writeFile(shim, "")
    await chmod(shim, 0o755)
    expect(hasDevToolchain(root)).toBe(true)
  })
})

describe("the prepare script", () => {
  test("succeeds with a note and runs nothing when the dev toolchain is absent", async () => {
    expect(await prepareDev(await makeRoot())).toBe(0)
  })
})
