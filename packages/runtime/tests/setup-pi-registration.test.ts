import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { Effect } from "effect"

import release from "../../../package.json" with { type: "json" }
import { piPackages } from "../../core/src/config/packages.ts"
import { installPiPackages } from "../../core/src/setup/pi-install.ts"
import { loadPiConfig } from "../src/setup/pi-check.ts"
import type { Scope } from "../src/setup/scope.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

let directory: string
let remove: () => Promise<void>

const writeJson = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value))
}

const installedManifest = {
  name: "holyagent",
  version: release.version,
  pi: { extensions: ["./extensions"] },
}

const fixture = (respond?: Parameters<typeof fakeShell>[0]["respond"]) => {
  const cwd = join(directory, "project")
  const installedPackageRoot = join(directory, "global install", "node_modules", "holyagent")
  const agent = join(directory, "pi")
  const env = { HOLYAGENT_HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: agent }
  const global = join(agent, "settings.json")
  const project = join(cwd, ".pi", "settings.json")
  const shell = fakeShell({ commands: ["pi"], ...(respond === undefined ? {} : { respond }) })
  const run = (
    scope: Scope,
    dryRun = false,
    packageRoot = installedPackageRoot,
    replacePiRegistration = false,
  ) =>
    Effect.runPromise(
      installPiPackages(env, {
        scope,
        cwd,
        dryRun,
        form: "headless",
        installedPackageRoot: packageRoot,
        replacePiRegistration,
      }).pipe(Effect.provide(shell.layer)),
    )
  const seed = async (file: string, sources: ReadonlyArray<unknown> = []) => {
    const config = await Effect.runPromise(loadPiConfig(env, cwd, "user"))
    await writeJson(file, { packages: [...piPackages(config, undefined, "headless"), ...sources] })
  }
  return { cwd, installedPackageRoot, agent, global, project, shell, run, seed }
}

beforeEach(async () => {
  const temporary = await scratch("holyagent-pi-registration-")
  directory = temporary.directory
  remove = temporary.remove
  const { cwd, installedPackageRoot } = fixture()
  await mkdir(cwd, { recursive: true })
  await writeJson(join(installedPackageRoot, "package.json"), installedManifest)
  await mkdir(join(installedPackageRoot, "extensions"))
  await writeFile(
    join(installedPackageRoot, "extensions", "holyagent.js"),
    "export default () => {}",
  )
})

afterEach(() => remove())

test.each(["user", "project", "local"] as const)(
  "%s scope previews and registers the installed root at most once",
  async (scope) => {
    const { cwd, installedPackageRoot, agent, global, project, shell, run, seed } = fixture()
    const target = scope === "user" ? global : project
    await seed(target, ["npm:unrelated@1.0.0"])
    const before = await readFile(target, "utf8")

    expect(await run(scope, true)).toContain(
      `+ pi ${installedPackageRoot}: would install with pi install ${installedPackageRoot}${scope === "user" ? "" : " -l"}`,
    )
    expect(shell.calls).toEqual([])
    expect(await readFile(target, "utf8")).toBe(before)

    await run(scope)
    expect(shell.calls).toHaveLength(1)
    expect(shell.calls[0]).toMatchObject({
      command: "pi",
      args: ["install", installedPackageRoot, ...(scope === "user" ? [] : ["-l"])],
      cwd: scope === "user" ? directory : cwd,
      env: { PI_CODING_AGENT_DIR: agent },
    })

    // Pi stores a local source relative to its settings file. A source with filters stays intact.
    await seed(target, [
      "npm:unrelated@1.0.0",
      { source: relative(dirname(target), installedPackageRoot), extensions: ["extensions/*"] },
    ])
    const after = await readFile(target, "utf8")
    expect(await run(scope)).toContain(
      `= pi package: installed HolyAgent already listed in ${target}`,
    )
    expect(shell.calls).toHaveLength(1)
    expect(await readFile(target, "utf8")).toBe(after)
  },
)

test("an exact global registration also serves local setup", async () => {
  const { installedPackageRoot, global, shell, run, seed } = fixture()
  await seed(global, [installedPackageRoot])
  expect(await run("local")).toContain(
    `= pi package: installed HolyAgent already listed in ${global}`,
  )
  expect(shell.calls).toEqual([])
})

test("an npm release in Pi settings requires a deliberate migration", async () => {
  const { global, shell, run, seed } = fixture()
  await seed(global, [{ source: "npm:holyagent@0.3.4", prompts: [] }])
  const raw = await readFile(global, "utf8")
  await expect(run("user")).rejects.toThrow(
    'HolyAgent is already configured as "npm:holyagent@0.3.4"',
  )
  await expect(run("local", true)).rejects.toThrow("interactive setup at its scope")
  expect(shell.calls).toEqual([])
  expect(await readFile(global, "utf8")).toBe(raw)
})

test("a custom local HolyAgent source with another folder name is a conflict", async () => {
  const { project, shell, run, seed } = fixture()
  const existing = join(directory, "my-copy")
  await writeJson(join(existing, "package.json"), { ...installedManifest, version: "0.3.4" })
  await seed(project, [relative(dirname(project), existing)])
  await expect(run("project")).rejects.toThrow("HolyAgent is already configured")
  expect(shell.calls).toEqual([])
})

test("a separately registered HolyAgent extension file is a conflict", async () => {
  const { global, installedPackageRoot, shell, run, seed } = fixture()
  await seed(global, [join(installedPackageRoot, "extensions", "holyagent.js")])
  await expect(run("user")).rejects.toThrow("HolyAgent is already configured")
  expect(shell.calls).toEqual([])
})

test("user scope leaves project package declarations alone", async () => {
  const { global, project, shell, run, seed } = fixture()
  await seed(global)
  await seed(project, ["npm:holyagent@0.3.4"])
  const raw = await readFile(project, "utf8")
  await run("user")
  expect(shell.calls).toHaveLength(1)
  expect(await readFile(project, "utf8")).toBe(raw)
})

test("invalid Pi settings stop registration before a command runs", async () => {
  const { global, project, shell, run, seed } = fixture()
  await seed(project)
  await writeJson(global, { packages: [7] })
  await expect(run("user")).rejects.toThrow("is not valid Pi settings")
  await expect(run("local")).rejects.toThrow("is not valid Pi settings")
  expect(shell.calls).toEqual([])
})

test("relative, development, and private package roots are rejected", async () => {
  const { cwd, installedPackageRoot, shell, run } = fixture()
  await expect(run("user", false, "node_modules/holyagent")).rejects.toThrow(
    "not an installed HolyAgent",
  )
  await expect(run("user", false, cwd)).rejects.toThrow("not an installed HolyAgent")
  await writeJson(join(installedPackageRoot, "package.json"), {
    ...installedManifest,
    private: true,
  })
  await expect(run("user")).rejects.toThrow("not an installed HolyAgent")
  expect(shell.calls).toEqual([])
})

test("the installed package can be a development build of the bundled version", async () => {
  const { global, installedPackageRoot, shell, run, seed } = fixture()
  await seed(global)
  await writeJson(join(installedPackageRoot, "package.json"), {
    ...installedManifest,
    version: `${release.version}-dev.2026-11-24.12-00-00.g1234567`,
  })
  await run("user")
  expect(shell.calls).toHaveLength(1)
})

test("disabled Pi configuration never validates or registers the supplied path", async () => {
  const { run, shell } = fixture()
  await writeJson(join(directory, ".holyagent", "config.json"), { pi: { enable: false } })
  expect(await run("user", false, "invalid")).toEqual([
    "- pi packages: pi.enable is off in the HolyAgent config",
  ])
  expect(shell.calls).toEqual([])
})

test.each([false, true])(
  "the Windows Bunx Git migration keeps the previous entry until a successful install (failure: %s)",
  async (fail) => {
    const version = `${release.version}-dev.2026-11-25.18-15-00.g1e379bf`
    const source = `npm:holyagent@${version}`
    const sink = fixture((line) => {
      if (line !== `pi install ${source}`) return undefined
      const existing = JSON.parse(readFileSync(sink.global, "utf8"))
      expect(existing.packages.some((p: { source?: string }) => p.source === previous.source)).toBe(
        true,
      )
      if (fail) return { exitCode: 1, stderr: "registry unavailable" }
      writeFileSync(
        sink.global,
        JSON.stringify({ ...existing, packages: [...existing.packages, source] }),
      )
      return { exitCode: 0 }
    })
    const previous = {
      source: "git:github.com/davidbasilefilho/holyagent@release/0.3.4/feat/final-guidance-events",
      extensions: ["extensions/holyagent.js"],
    }
    const root = join(
      directory,
      "Temp",
      "bunx-1275120565-holyagent@dev",
      "node_modules",
      "holyagent",
    )
    await writeJson(join(root, "package.json"), { ...installedManifest, version })
    await mkdir(join(root, "extensions"))
    await writeFile(join(root, "extensions", "holyagent.js"), "export default () => {}")
    await sink.seed(sink.global, [previous, "npm:unrelated@1.0.0"])
    const initial = await Bun.file(sink.global).json()
    await writeJson(sink.global, { ...initial, hideThinkingBlock: true })
    const original = await readFile(sink.global, "utf8")
    await expect(sink.run("user", false, root)).rejects.toThrow("interactive setup")
    const plan = await sink.run("user", true, root, true)
    expect(plan.join("\n")).toContain(`replace "${previous.source}" with "${source}"`)
    expect(plan.join("\n")).not.toContain(root)
    expect(sink.shell.calls).toHaveLength(0)
    expect(await readFile(sink.global, "utf8")).toBe(original)
    const applied = await sink.run("user", false, root, true)
    expect(sink.shell.lines()).toEqual([`pi install ${source}`])
    if (fail) {
      expect(applied.some((line) => line.includes("registry unavailable"))).toBe(true)
      expect(await readFile(sink.global, "utf8")).toBe(original)
    } else {
      const saved = await Bun.file(sink.global).json()
      expect(saved).toEqual({
        ...initial,
        hideThinkingBlock: true,
        packages: initial.packages.map((p: { source?: string }) =>
          p.source === previous.source ? { ...p, source } : p,
        ),
      })
      expect((await sink.run("user", false, root, true)).join("\n")).toContain("already listed")
      expect(sink.shell.calls).toHaveLength(1)
    }
  },
)
