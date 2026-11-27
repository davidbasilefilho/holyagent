import { afterEach, beforeEach, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

import { Effect } from "effect"

import release from "../../../package.json" with { type: "json" }
import { piPackages } from "../../core/src/config/packages.ts"
import { FileSystem, nodeFileSystem } from "../../core/src/ports/filesystem.ts"
import { installPiPackages, PiRegistrationReview } from "../../core/src/setup/pi-install.ts"
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
  const cwd = join(directory, "projects", "checkout")
  const installedPackageRoot = join(
    directory,
    "AppData",
    "Local",
    "mise",
    "installs",
    "npm-holyagent",
    "dev",
    "node_modules",
    "holyagent",
  )
  const agent = join(directory, ".pi", "agent")
  const env = { HOLYAGENT_HOME: directory, USERPROFILE: directory, PI_CODING_AGENT_DIR: agent }
  const global = join(agent, "settings.json")
  const project = join(cwd, ".pi", "settings.json")
  const shell = fakeShell({ commands: ["pi"], ...(respond === undefined ? {} : { respond }) })
  const run = (
    scope: Scope,
    dryRun = false,
    packageRoot = installedPackageRoot,
    replacePiRegistration = false,
    review?: typeof PiRegistrationReview.Service,
    fs = nodeFileSystem,
  ) =>
    Effect.runPromise(
      installPiPackages(env, {
        scope,
        cwd,
        dryRun,
        form: "headless",
        installedPackageRoot: packageRoot,
        replacePiRegistration,
      }).pipe(
        Effect.provide(shell.layer),
        Effect.provideService(PiRegistrationReview, review),
        Effect.provideService(FileSystem, fs),
      ),
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

test.each(["success", "unavailable", "partial failure", "ambiguous failure"])(
  "the Windows Bunx Git migration keeps or backs up the previous entry (%s)",
  async (outcome) => {
    const version = `${release.version}-dev.2026-11-25.18-15-00.g1e379bf`
    const source = `npm:holyagent@${version}`
    const sink = fixture((line) => {
      if (line !== `pi install ${source}`) return undefined
      const existing = JSON.parse(readFileSync(sink.global, "utf8"))
      expect(existing.packages.some((p: { source?: string }) => p.source === previous.source)).toBe(
        true,
      )
      if (outcome === "unavailable") return { exitCode: 1, stderr: "registry unavailable" }
      if (outcome === "partial failure" || outcome === "ambiguous failure") {
        writeFileSync(
          sink.global,
          JSON.stringify({
            ...existing,
            hideThinkingBlock: false,
            packages: [
              ...existing.packages.filter(
                (entry: { source?: string }) => entry.source !== previous.source,
              ),
              ...(outcome === "ambiguous failure" ? ["npm:added@2.0.0"] : []),
            ],
          }),
        )
        return { exitCode: 1, stderr: "registry unavailable" }
      }
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
    let fingerprint = ""
    const plan = await sink.run("user", true, root, true, {
      preview: (conflict) => {
        fingerprint = conflict.fingerprint
      },
    })
    expect(plan.join("\n")).toContain(`replace "${previous.source}" with "${source}"`)
    expect(plan.join("\n")).not.toContain(root)
    expect(sink.shell.calls).toHaveLength(0)
    expect(await readFile(sink.global, "utf8")).toBe(original)
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/)
    await writeJson(sink.global, {
      ...initial,
      packages: initial.packages.map((p: { source?: string }) =>
        p.source === previous.source ? { ...p, extensions: ["my-own-filter"] } : p,
      ),
    })
    const changed = await readFile(sink.global, "utf8")
    await expect(sink.run("user", false, root, true, { expected: fingerprint })).rejects.toThrow(
      "changed after review",
    )
    expect(sink.shell.calls).toEqual([])
    expect(await readFile(sink.global, "utf8")).toBe(changed)
    await writeFile(sink.global, original)
    const applied = await sink.run("user", false, root, true, { expected: fingerprint })
    expect(sink.shell.lines()).toEqual([`pi install ${source}`])
    const backups = (await readdir(dirname(sink.global))).filter((name) => name.endsWith(".bak"))
    if (outcome === "unavailable") {
      expect(applied.some((line) => line.includes("registry unavailable"))).toBe(true)
      expect(await readFile(sink.global, "utf8")).toBe(original)
      expect(backups).toEqual([])
    } else {
      expect(backups).toHaveLength(1)
      expect(await Bun.file(join(dirname(sink.global), backups[0] ?? "")).json()).toEqual({
        source,
        entry: previous,
      })
      if (outcome === "partial failure" || outcome === "ambiguous failure") {
        expect(applied.join("\n")).toContain(backups[0] ?? "missing backup")
        expect(applied.join("\n")).toContain("registry unavailable")
        expect(applied.join("\n").includes("the package files were not verified")).toBe(
          outcome === "partial failure",
        )
        expect(await Bun.file(sink.global).json()).toEqual({
          ...initial,
          hideThinkingBlock: false,
          packages:
            outcome === "partial failure"
              ? initial.packages
              : [
                  ...initial.packages.filter(
                    (entry: { source?: string }) => entry.source !== previous.source,
                  ),
                  "npm:added@2.0.0",
                ],
        })
        return
      }
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

test.each(["user", "project", "local"] as const)(
  "%s replacement accepts Pi's native relative path, keeps filters and reopens without installing",
  async (scope) => {
    const originalEntry = {
      source: "npm:holyagent@0.4.0-dev.2026-11-25.22-30-28.g3eda316",
      extensions: ["extensions/holyagent.js"],
      prompts: [],
    }
    const p = fixture((line) => {
      const command = "pi install " + p.installedPackageRoot + (scope === "user" ? "" : " -l")
      if (line !== command) return undefined
      const current = JSON.parse(readFileSync(target, "utf8"))
      writeFileSync(
        target,
        JSON.stringify({
          ...current,
          hideThinkingBlock: false,
          packages: [...current.packages, persisted],
        }),
      )
      return { exitCode: 0 }
    })
    const target = scope === "user" ? p.global : p.project
    const other = scope === "user" ? p.project : p.global
    const persisted = relative(dirname(target), p.installedPackageRoot)
    if (process.platform === "win32" && scope === "user")
      expect(persisted).toBe(
        "..\\..\\AppData\\Local\\mise\\installs\\npm-holyagent\\dev\\node_modules\\holyagent",
      )
    await p.seed(target, [originalEntry, "npm:unrelated@1.0.0"])
    await p.seed(other, ["npm:leave-alone@1.0.0"])
    const original = await Bun.file(target).json()
    const untouched = await Bun.file(other).text()
    await expect(p.run(scope)).rejects.toThrow("interactive setup")
    let expected = ""
    await p.run(scope, true, p.installedPackageRoot, true, {
      preview: ({ fingerprint }) => {
        expected = fingerprint
      },
    })
    expect(expected).toMatch(/^[a-f0-9]{64}$/)
    expect(p.shell.calls).toEqual([])
    const result = await p.run(scope, false, p.installedPackageRoot, true, { expected })
    expect(result.filter((line) => line.startsWith("!"))).toEqual([])
    const saved = await Bun.file(target).json()
    expect(saved).toEqual({
      ...original,
      hideThinkingBlock: false,
      packages: original.packages.map((entry: unknown) =>
        JSON.stringify(entry) === JSON.stringify(originalEntry)
          ? { ...originalEntry, source: persisted }
          : entry,
      ),
    })
    expect(await Bun.file(other).text()).toBe(untouched)
    expect((await p.run(scope)).join("\n")).toContain("already listed")
    expect(p.shell.calls).toHaveLength(1)
  },
)

test.each([
  "different local directory",
  "resolved from the other scope",
  "npm pin instead of a local path",
  "duplicate path aliases",
  "concurrent package addition",
  "concurrently edited filters",
  "native failure after append",
])("a reviewed local replacement keeps the prior source on %s", async (scenario) => {
  const previous = { source: "npm:holyagent@0.3.4", prompts: [] }
  const unrelated = "npm:keep-this@1.0.0"
  let written = ""
  const p = fixture((line) => {
    if (line !== "pi install " + p.installedPackageRoot) return undefined
    const current = JSON.parse(readFileSync(p.global, "utf8"))
    const packages = current.packages as unknown[]
    let persisted = relative(dirname(p.global), p.installedPackageRoot)
    if (scenario === "different local directory")
      persisted = relative(dirname(p.global), join(directory, "other", "node_modules", "holyagent"))
    if (scenario === "resolved from the other scope")
      persisted = relative(dirname(p.project), p.installedPackageRoot)
    if (scenario === "npm pin instead of a local path")
      persisted = "npm:holyagent@" + release.version
    if (scenario === "concurrently edited filters")
      packages.splice(
        packages.findIndex((entry) => JSON.stringify(entry) === JSON.stringify(previous)),
        1,
        { ...previous, prompts: ["locally edited"] },
      )
    packages.push(persisted)
    if (scenario === "duplicate path aliases") packages.push(p.installedPackageRoot)
    if (scenario === "concurrent package addition") packages.push("npm:added-during-install@2.0.0")
    written = JSON.stringify({ ...current, packages })
    writeFileSync(p.global, written)
    return scenario === "native failure after append"
      ? { exitCode: 3, stderr: "native install failed" }
      : { exitCode: 0 }
  })
  await writeJson(
    join(directory, "other", "node_modules", "holyagent", "package.json"),
    installedManifest,
  )
  await p.seed(p.global, [previous, unrelated])
  // The absolute package is valid even if the scope Pi reports is not the approved one.
  await p.seed(p.project, ["npm:project-only@1.0.0"])
  const other = await Bun.file(p.project).text()
  let expected = ""
  await p.run("user", true, p.installedPackageRoot, true, {
    preview: ({ fingerprint }) => {
      expected = fingerprint
    },
  })
  const result = await p.run("user", false, p.installedPackageRoot, true, { expected })
  expect(result.find((line) => line.startsWith("!"))).toContain(
    scenario === "native failure after append"
      ? "native install failed"
      : "registration changed during install",
  )
  expect(await Bun.file(p.global).text()).toBe(written)
  const saved = (await Bun.file(p.global).json()) as { packages: unknown[] }
  expect(saved.packages).toContainEqual(
    scenario === "concurrently edited filters"
      ? { ...previous, prompts: ["locally edited"] }
      : previous,
  )
  expect(saved.packages).toContain(unrelated)
  expect(await Bun.file(p.project).text()).toBe(other)
})

test("native same-package npm update keeps the reviewed filters and only the approved exact pin", async () => {
  const version = release.version + "-dev.2026-11-25.22-30-28.g3eda316"
  const previous = { source: "npm:holyagent@0.3.4", prompts: [], extensions: ["extensions/*"] }
  const source = "npm:holyagent@" + version
  const p = fixture((line) => {
    if (line !== "pi install " + source) return undefined
    const current = JSON.parse(readFileSync(p.global, "utf8"))
    writeFileSync(
      p.global,
      JSON.stringify({
        ...current,
        packages: (current.packages as unknown[]).map((item) =>
          JSON.stringify(item) === JSON.stringify(previous) ? { ...previous, source } : item,
        ),
      }),
    )
    return { exitCode: 0 }
  })
  const root = join(directory, "Temp", "bunx-1275120565-holyagent@dev", "node_modules", "holyagent")
  await writeJson(join(root, "package.json"), { ...installedManifest, version })
  await mkdir(join(root, "extensions"))
  await writeFile(join(root, "extensions", "holyagent.js"), "export default () => {}")
  await p.seed(p.global, [previous])
  const original = (await Bun.file(p.global).json()) as { packages: unknown[] }
  let expected = ""
  await p.run("user", true, root, true, {
    preview: ({ fingerprint }) => {
      expected = fingerprint
    },
  })
  const result = await p.run("user", false, root, true, { expected })
  expect(result.filter((line) => line.startsWith("!"))).toEqual([])
  expect(await Bun.file(p.global).json()).toEqual({
    ...original,
    packages: original.packages.map((item) =>
      JSON.stringify(item) === JSON.stringify(previous) ? { ...previous, source } : item,
    ),
  })
  expect((await p.run("user", false, root)).join("\n")).toContain("already listed")
  expect(p.shell.lines()).toEqual(["pi install " + source])
})

test("review repairs the already duplicated registration without reinstalling the local package", async () => {
  const p = fixture()
  const previous = {
    source: "npm:holyagent@0.4.0-dev.2026-11-25.22-30-28.g3eda316",
    prompts: [],
  }
  const persisted = relative(dirname(p.global), p.installedPackageRoot)
  const verified = { source: persisted, extensions: ["extensions/holyagent.js"] }
  const unrelated = "npm:unrelated@1.0.0"
  await p.seed(p.global, [previous, unrelated, verified])
  const original = (await Bun.file(p.global).json()) as { packages: unknown[] }
  await writeJson(p.global, { ...original, hideThinkingBlock: false })
  const before = await Bun.file(p.global).text()
  const originallyInDirectory = await readdir(dirname(p.global))
  await expect(p.run("user")).rejects.toThrow("interactive setup")
  let expected = ""
  const preview = await p.run("user", true, p.installedPackageRoot, true, {
    preview: (plan) => {
      expect(plan).toMatchObject({ file: p.global, prior: previous.source, source: persisted })
      expected = plan.fingerprint
    },
  })
  expect(expected).toMatch(/^[a-f0-9]{64}$/)
  expect(preview.join("\n")).toContain("remove " + JSON.stringify(previous.source))
  expect(await Bun.file(p.global).text()).toBe(before)
  expect(await readdir(dirname(p.global))).toEqual(originallyInDirectory)
  await expect(p.run("user", false, p.installedPackageRoot, true)).rejects.toThrow("review")
  expect(await Bun.file(p.global).text()).toBe(before)
  // A concurrent preference edit outside the reviewed package list still belongs to the user.
  await writeJson(p.global, { ...original, hideThinkingBlock: true })
  const result = await p.run("user", false, p.installedPackageRoot, true, { expected })
  expect(result.filter((line) => line.startsWith("!"))).toEqual([])
  expect(await Bun.file(p.global).json()).toEqual({
    ...original,
    hideThinkingBlock: true,
    packages: [...original.packages.slice(0, -3), unrelated, { ...previous, ...verified }],
  })
  expect(p.shell.calls).toEqual([])
  const backups = (await readdir(dirname(p.global))).filter((name) => name.endsWith(".bak"))
  expect(backups).toHaveLength(1)
  expect(await Bun.file(join(dirname(p.global), backups[0] ?? "")).json()).toEqual({
    source: persisted,
    entry: previous,
  })
  expect((await p.run("user")).join("\n")).toContain("already listed")
  expect(p.shell.calls).toEqual([])
})

test.each([
  "registry range",
  "Git source",
  "multiple old pins",
  "multiple matching local sources",
  "matching local source in another scope",
  "conflicting filters",
])("an existing duplicate with %s needs manual resolution", async (scenario) => {
  const p = fixture()
  const scope = scenario === "matching local source in another scope" ? "project" : "user"
  const target = scope === "user" ? p.global : p.project
  const source = relative(dirname(target), p.installedPackageRoot)
  const previous = "npm:holyagent@0.3.4"
  const packages: unknown[] = [previous, source]
  if (scenario === "registry range") packages[0] = "npm:holyagent@^0.3.0"
  if (scenario === "Git source") packages[0] = "git:github.com/davidbasilefilho/holyagent@main"
  if (scenario === "multiple old pins") packages.push("npm:holyagent@0.3.3")
  if (scenario === "multiple matching local sources") packages.push(p.installedPackageRoot)
  if (scenario === "matching local source in another scope") {
    packages.pop()
    await p.seed(p.global, [relative(dirname(p.global), p.installedPackageRoot)])
  }
  if (scenario === "conflicting filters") {
    packages[0] = { source: previous, prompts: ["old prompt filter"] }
    packages[1] = { source, prompts: ["local prompt filter"] }
  }
  await p.seed(target, packages)
  const before = await Bun.file(target).text()
  const other = scope === "project" ? await Bun.file(p.global).text() : undefined
  await expect(p.run(scope, true, p.installedPackageRoot, true)).rejects.toThrow(
    scenario === "conflicting filters"
      ? "Reconcile the filters"
      : "Keep only the intended HolyAgent source",
  )
  expect(await Bun.file(target).text()).toBe(before)
  if (other !== undefined) expect(await Bun.file(p.global).text()).toBe(other)
  expect(await readdir(dirname(target))).toEqual(["settings.json"])
  expect(p.shell.calls).toEqual([])
})

test.each(["between review and apply", "before atomic replace"])(
  "repair does not overwrite a concurrent package edit %s",
  async (race) => {
    const p = fixture()
    const previous = "npm:holyagent@0.3.4"
    const source = relative(dirname(p.global), p.installedPackageRoot)
    await p.seed(p.global, [previous, source])
    let expected = ""
    await p.run("user", true, p.installedPackageRoot, true, {
      preview: ({ fingerprint }) => {
        expected = fingerprint
      },
    })
    const original = (await Bun.file(p.global).json()) as { packages: unknown[] }
    const concurrent = JSON.stringify({
      ...original,
      packages: [...original.packages, "npm:concurrent@2.0.0"],
    })
    if (race === "between review and apply") {
      await Bun.write(p.global, concurrent)
      await expect(
        p.run("user", false, p.installedPackageRoot, true, { expected }),
      ).rejects.toThrow("changed after review")
      expect(await readdir(dirname(p.global))).toEqual(["settings.json"])
    } else {
      let injected = false
      const fs = {
        ...nodeFileSystem,
        chmod: async (...args: Parameters<typeof nodeFileSystem.chmod>) => {
          await nodeFileSystem.chmod(...args)
          if (!injected && String(args[0]).endsWith(".tmp")) {
            injected = true
            await Bun.write(p.global, concurrent)
          }
        },
      }
      expect(
        (await p.run("user", false, p.installedPackageRoot, true, { expected }, fs)).join("\n"),
      ).toContain("changed while repairing the package; did not remove the previous source")
      expect(injected).toBe(true)
      expect((await readdir(dirname(p.global))).some((name) => name.endsWith(".tmp"))).toBe(false)
    }
    expect(await Bun.file(p.global).text()).toBe(concurrent)
    expect(p.shell.calls).toEqual([])
  },
)
