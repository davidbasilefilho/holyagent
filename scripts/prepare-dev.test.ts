import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { hasDevToolchain, prepareDev } from "./prepare-dev.ts"
import { isLegacyHook } from "./prepare.ts"

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
  test("is false when node_modules has no Oxc dev dependencies, as after a consumer install", async () => {
    expect(hasDevToolchain(await makeRoot())).toBe(false)
  })

  test("is true with dev dependencies and a native mise command", async () => {
    const root = await makeRoot()
    const bin = join(root, "node_modules", ".bin")
    await mkdir(bin, { recursive: true })
    const shim = join(bin, process.platform === "win32" ? "mise.cmd" : "mise")
    await writeFile(shim, "")
    await chmod(shim, 0o755)
    const hook = join(bin, process.platform === "win32" ? "oxlint.cmd" : "oxlint")
    await writeFile(hook, "")
    await chmod(hook, 0o755)
    expect(hasDevToolchain(root)).toBe(true)
  })
})

describe("the root package", () => {
  test("runs the prepare script as its prepare step", async () => {
    const { scripts } = (await Bun.file(join(import.meta.dir, "../package.json")).json()) as {
      readonly scripts: Record<string, string>
    }
    const [command, file] = (scripts["prepare"] ?? "").split(" ")
    expect(command).toBe("bun")
    expect(await Bun.file(join(import.meta.dir, "..", file ?? "")).exists()).toBe(true)
    expect(file).toBe("scripts/prepare-dev.ts")
  })
})

describe("the prepare script", () => {
  test("succeeds with a note and runs nothing when the dev toolchain is absent", async () => {
    expect(await prepareDev(await makeRoot())).toBe(0)
  })
})

test("recognizes only the corresponding old Lefthook launcher", () => {
  const legacy = [
    "#!/bin/sh",
    'if [ "$LEFTHOOK_VERBOSE" = "1" ]; then',
    "  set -x",
    "fi",
    'call_lefthook run "pre-commit" "$@"',
  ].join("\n")
  expect(isLegacyHook(legacy, "pre-commit")).toBe(true)
  expect(isLegacyHook(legacy, "commit-msg")).toBe(false)
  expect(isLegacyHook('#!/bin/sh\nexec mise x -- hk run pre-commit "$@"', "pre-commit")).toBe(false)
})
