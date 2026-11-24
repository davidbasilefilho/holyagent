import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect, Option } from "effect"

import { updateInstallation } from "../src/cli/public-maintenance.ts"
import { Shell, type ShellResult } from "../src/setup/shell.ts"

const ok = (stdout = ""): ShellResult => ({ stdout, stderr: "", exitCode: 0 })
const failed = { stdout: "", stderr: "Install failed", exitCode: 1 }
let agentDirectory = ""
beforeEach(async () => {
  agentDirectory = await mkdtemp(join(tmpdir(), "holyagent-update-"))
})
afterEach(async () => {
  await rm(agentDirectory, { recursive: true, force: true })
})

const update = (
  replies: ReadonlyArray<ShellResult>,
  { target, dry = false }: { readonly target?: string; readonly dry?: boolean } = {},
) => {
  const calls: Array<ReadonlyArray<string>> = []
  const pending = [...replies]
  const shell = Shell.of({
    which: (name) => Effect.succeed(Option.some(name)),
    run: (name, args) => {
      calls.push([name, ...args])
      return Effect.succeed(pending.shift() ?? failed)
    },
  })
  return {
    calls,
    result: Effect.runPromise(
      updateInstallation({ PI_CODING_AGENT_DIR: agentDirectory }, target, dry).pipe(
        Effect.provideService(Shell, shell),
      ),
    ),
  }
}

describe("public update", () => {
  test("pins the same verified version for Pi and the public commands", async () => {
    const { result, calls } = update([ok('"0.99.99"'), ok(), ok()])
    expect(await result).toMatchObject({ code: 0, stderr: "" })
    expect(calls[0]?.slice(0, 4)).toEqual(["npm", "view", "holyagent@latest", "version"])
    expect(calls[1]).toEqual(["pi", "install", "npm:holyagent@0.99.99"])
    expect(calls[2]).toContain("--ignore-scripts")
    expect(calls[2]?.at(-1)).toBe("holyagent@0.99.99")
  })

  test("dry run only resolves the requested published version", async () => {
    const { result, calls } = update([ok('"0.99.99"')], { target: "0.99.99", dry: true })
    expect((await result).stdout).toContain("Would install HolyAgent 0.99.99")
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[2]).toBe("holyagent@0.99.99")
  })

  test("refuses to add a duplicate npm package alongside a Git installation", async () => {
    const file = join(agentDirectory, "settings.json")
    const settings = JSON.stringify({
      packages: ["git:github.com/davidbasilefilho/holyagent@main"],
    })
    await Bun.write(file, settings)
    const { result, calls } = update([])
    expect(await result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Git or a local path"),
    })
    expect(calls).toEqual([])
    expect(await Bun.file(file).text()).toBe(settings)
  })

  test("refuses invalid input, mismatched registry data and downgrades before writes", async () => {
    const invalid = update([], { target: "next" })
    await expect(invalid.result).rejects.toThrow("Invalid value for --version")
    expect(invalid.calls).toHaveLength(0)

    const mismatch = update([ok('"0.99.98"')], { target: "0.99.99" })
    expect((await mismatch.result).code).toBe(1)
    expect(mismatch.calls).toHaveLength(1)

    const downgrade = update([ok('"0.1.0"')])
    expect((await downgrade.result).stderr).toContain("is older than the running version")
    expect(downgrade.calls).toHaveLength(1)
  })

  test("stops on a Pi failure and reports a retry if only the global update fails", async () => {
    const pi = update([ok('"0.99.99"'), failed])
    expect((await pi.result).stderr).toContain("The global commands were left in place")
    expect(pi.calls).toHaveLength(2)

    const global = update([ok('"0.99.99"'), ok(), failed])
    expect((await global.result).stderr).toContain("Retry with holyagent update --version 0.99.99")
    expect(global.calls).toHaveLength(3)
  })
})
