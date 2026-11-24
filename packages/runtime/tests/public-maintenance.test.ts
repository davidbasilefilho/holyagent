import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"

import { Effect, Option } from "effect"

import { updateInstallation } from "../src/cli/public-maintenance.ts"
import { Shell, type ShellResult } from "../src/setup/shell.ts"

const ok = (stdout = ""): ShellResult => ({ stdout, stderr: "", exitCode: 0 })
const failed = { stdout: "", stderr: "Install failed", exitCode: 1 }
let agentDirectory = ""
let home = ""
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "holyagent-update-"))
  agentDirectory = join(home, "pi")
  await mkdir(agentDirectory)
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const update = (
  replies: ReadonlyArray<ShellResult>,
  {
    target,
    dry = false,
    installedPackageRoot,
    onInstall,
  }: {
    readonly target?: string
    readonly dry?: boolean
    readonly installedPackageRoot?: string
    readonly onInstall?: () => Promise<void>
  } = {},
) => {
  const calls: Array<ReadonlyArray<string>> = []
  const directories: Array<string> = []
  const pending = [...replies]
  const shell = Shell.of({
    which: (name) => Effect.succeed(Option.some(name)),
    run: (name, args, { cwd }) => {
      calls.push([name, ...args])
      directories.push(cwd)
      const response = pending.shift() ?? failed
      return response.exitCode === 0 && name === "npm" && args[0] === "install" && onInstall
        ? Effect.promise(() => onInstall().then(() => response))
        : Effect.succeed(response)
    },
  })
  return {
    calls,
    directories,
    result: Effect.runPromise(
      updateInstallation(
        { USERPROFILE: home, PI_CODING_AGENT_DIR: agentDirectory },
        target,
        dry,
        installedPackageRoot,
      ).pipe(Effect.provideService(Shell, shell)),
    ),
  }
}

const writePackage = (root: string, version: string) =>
  Bun.write(join(root, "package.json"), JSON.stringify({ name: "holyagent", version }))

const managedRegistration = async (path: "absolute" | "relative") => {
  const npmRoot = join(home, "npm global", "node_modules")
  const installedPackageRoot = join(npmRoot, "holyagent")
  const file = join(agentDirectory, "settings.json")
  const source =
    path === "absolute" ? installedPackageRoot : relative(agentDirectory, installedPackageRoot)
  const settings = JSON.stringify({ packages: [{ source, prompts: [] }, "npm:another@1.0.0"] })
  await Bun.write(file, settings)
  await writePackage(installedPackageRoot, "0.4.0")
  return { npmRoot, installedPackageRoot, file, source, settings }
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

  test.each(["relative", "absolute"] as const)(
    "updates the exact installed package through its %s registration without calling pi",
    async (path) => {
      const { npmRoot, installedPackageRoot, file, settings } = await managedRegistration(path)
      const { result, calls, directories } = update([ok(`${npmRoot}\n`), ok('"0.99.99"'), ok()], {
        installedPackageRoot,
        onInstall: async () => {
          await writePackage(installedPackageRoot, "0.99.99")
        },
      })
      expect(await result).toMatchObject({ code: 0, stderr: "" })
      expect(calls.map((call) => call.slice(0, 2))).toEqual([
        ["npm", "root"],
        ["npm", "view"],
        ["npm", "install"],
      ])
      expect(calls[2]?.at(-1)).toBe("holyagent@0.99.99")
      expect(calls[2]).not.toContain("--legacy-peer-deps")
      expect(directories).toEqual([home, home, home])
      expect(await Bun.file(file).text()).toBe(settings)
    },
  )

  test("previews an update at the registered path without installing", async () => {
    const { npmRoot, installedPackageRoot, file, settings } = await managedRegistration("relative")
    const { result, calls } = update([ok(npmRoot), ok('"0.99.99"')], {
      installedPackageRoot,
      dry: true,
    })
    expect(await result).toMatchObject({
      code: 0,
      stdout: "Would install HolyAgent 0.99.99 in Pi and on the npm global PATH.\n",
    })
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["npm", "root"],
      ["npm", "view"],
    ])
    expect(await Bun.file(file).text()).toBe(settings)
  })

  test("refuses to update a registration outside npm's current global prefix", async () => {
    const { installedPackageRoot, file, settings } = await managedRegistration("relative")
    const { result, calls } = update([ok(join(home, "different", "node_modules"))], {
      installedPackageRoot,
    })
    expect(await result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("with the package manager that installed it"),
    })
    expect(calls).toEqual([["npm", "root", "--global"]])
    expect(await Bun.file(file).text()).toBe(settings)
  })

  test("refuses another local HolyAgent package even in an unrelated folder name", async () => {
    const { installedPackageRoot, file } = await managedRegistration("relative")
    const custom = join(home, "working-copy")
    await writePackage(custom, "0.3.4")
    const settings = JSON.stringify({ packages: [relative(agentDirectory, custom)] })
    await Bun.write(file, settings)
    const { result, calls } = update([], { installedPackageRoot })
    expect(await result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Git or a local path"),
    })
    expect(calls).toEqual([])
    expect(await Bun.file(file).text()).toBe(settings)
  })

  test("refuses a managed registration alongside another HolyAgent source", async () => {
    const { installedPackageRoot, file, source } = await managedRegistration("relative")
    await Bun.write(file, JSON.stringify({ packages: [source, "npm:holyagent@0.3.4"] }))
    const { result, calls } = update([], { installedPackageRoot })
    expect(await result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("multiple HolyAgent registrations"),
    })
    expect(calls).toEqual([])
  })

  test("fails closed when the npm update leaves the registered release unchanged", async () => {
    const { npmRoot, installedPackageRoot, file, settings } = await managedRegistration("relative")
    const { result, calls } = update([ok(npmRoot), ok('"0.99.99"'), ok()], {
      installedPackageRoot,
    })
    expect(await result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Reinstall that release in the same npm global prefix"),
    })
    expect(calls).toHaveLength(3)
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
