import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import { EMPTY_BUNFIG } from "../src/setup/shell.ts"
import { TUI_BUNDLE } from "../src/setup/tui/files.ts"
import {
  bunInstall,
  cacheHome,
  importFile,
  loadSetupTui,
  tuiDirectory,
  TuiUnavailable,
} from "../src/setup/tui/load.ts"
import { TUI_PACKAGES } from "../src/setup/tui/packages.ts"
import { tuiFallbackReason } from "../src/setup/tui/session.ts"
import type { SetupTuiModule } from "../src/setup/tui/types.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

let directory: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-tui-load-")
  directory = made.directory
  remove = made.remove
})
afterEach(() => remove())

const PACKAGES = { "@opentui/core": "1.0.0", "@opentui/solid": "1.0.1", "solid-js": "2.0.0" }
const EXPECTED_DIRECTORY = (root: string) =>
  join(root, "holyagent", "setup-tui", "opentui-core-1.0.0_opentui-solid-1.0.1_solid-js-2.0.0")

/** Puts the packages in a folder as an install would, at the given versions. */
const installTo = async (folder: string, versions: Record<string, string>) => {
  for (const [name, version] of Object.entries(versions)) {
    await mkdir(join(folder, "node_modules", name), { recursive: true })
    await writeFile(
      join(folder, "node_modules", name, "package.json"),
      JSON.stringify({ name, version }),
    )
  }
}

const bundleFile = async (text = "export const runSetupTui = () => Promise.resolve({})") => {
  const file = join(directory, "source", TUI_BUNDLE)
  await mkdir(join(directory, "source"), { recursive: true })
  await writeFile(file, text)
  return file
}

const MODULE: SetupTuiModule = { runSetupTui: () => Promise.resolve({ _tag: "Cancelled" }) }

const load = (options: Parameters<typeof loadSetupTui>[1]) =>
  Effect.runPromise(
    loadSetupTui({}, options).pipe(
      Effect.flip,
      Effect.catch(() => Effect.die("expected a failure")),
      Effect.provide(fakeShell({ commands: ["bun"] }).layer),
    ),
  )

const loaded = (options: Parameters<typeof loadSetupTui>[1]) =>
  Effect.runPromise(
    loadSetupTui({}, options).pipe(Effect.provide(fakeShell({ commands: ["bun"] }).layer)),
  )

describe("where the interface is installed", () => {
  test("uses XDG_CACHE_HOME when absolute, else .cache of the home directory", () => {
    expect(cacheHome({ HOME: "/home/a", XDG_CACHE_HOME: "/var/cache/a" }, "linux")).toBe(
      "/var/cache/a",
    )
    expect(cacheHome({ HOME: "/home/a", XDG_CACHE_HOME: "relative" }, "linux")).toBe(
      "/home/a/.cache",
    )
    expect(cacheHome({ HOME: "/home/a", XDG_CACHE_HOME: "" }, "darwin")).toBe(
      join("/home/a", ".cache"),
    )
    expect(cacheHome({ HOME: "/Users/a" }, "darwin")).toBe(join("/Users/a", ".cache"))
  })

  test("uses LOCALAPPDATA on Windows, else AppData/Local of the home directory", () => {
    expect(cacheHome({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32")).toBe(
      "C:\\Users\\a\\AppData\\Local",
    )
    expect(cacheHome({ HOME: "C:\\Users\\a" }, "win32")).toBe(
      join("C:\\Users\\a", "AppData", "Local"),
    )
  })

  test("names the folder by the exact versions, so a newer release installs beside an older one", () => {
    expect(tuiDirectory({ XDG_CACHE_HOME: "/c" }, PACKAGES, "linux")).toBe(EXPECTED_DIRECTORY("/c"))
    expect(
      tuiDirectory({ XDG_CACHE_HOME: "/c" }, { ...PACKAGES, "solid-js": "2.0.1" }, "linux"),
    ).not.toBe(EXPECTED_DIRECTORY("/c"))
  })
})

describe("the versions the interface installs", () => {
  test("are the exact versions bun.lock resolves, with solid-js at 1.9.16 or later", async () => {
    const lock = await readFile(join(import.meta.dir, "../../../bun.lock"), "utf8")
    for (const [name, version] of Object.entries(TUI_PACKAGES)) {
      expect(lock).toContain(`"${name}": ["${name}@${version}",`)
      expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    }
    expect(Object.keys(TUI_PACKAGES).toSorted()).toEqual([
      "@opentui/core",
      "@opentui/solid",
      "solid-js",
    ])
    const [major = 0, minor = 0, patch = 0] = (TUI_PACKAGES["solid-js"] ?? "")
      .split(".")
      .map(Number)
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(1_009_016)
  })

  test("are the ones installed in this checkout, which the bundle is built against", async () => {
    for (const [name, version] of Object.entries(TUI_PACKAGES)) {
      const manifest = (await Bun.file(
        join(import.meta.dir, "../../../node_modules", name, "package.json"),
      ).json()) as {
        version: string
      }
      expect(manifest.version).toBe(version)
    }
  })

  test("are embedded in the CLI bundles of the plugin and the Pi package, beside a TUI bundle each", async () => {
    for (const dist of ["claude", "pi"]) {
      const scripts = join(import.meta.dir, "../../integrations", dist, "dist", "scripts")
      const cli = await Bun.file(join(scripts, "holyagent.js")).text()
      for (const [name, version] of Object.entries(TUI_PACKAGES))
        expect(cli).toContain(`"${name}": "${version}"`)
      const tui = await Bun.file(join(scripts, TUI_BUNDLE)).text()
      for (const name of Object.keys(TUI_PACKAGES)) expect(tui).toContain(`from "${name}"`)
      expect(tui).not.toContain("node_modules")
      expect(cli).not.toContain("@opentui/solid/bun-plugin")
    }
  })
})

describe("loading the interface", () => {
  test("installs the exact versions on first use, copies the bundle beside them and imports Solid's preload, then the bundle", async () => {
    const bundle = await bundleFile("export const runSetupTui = 1")
    const target = join(directory, "cache")
    const imported: Array<string> = []
    const installs: Array<readonly [string, Record<string, string>]> = []
    const notices: Array<string> = []
    const module = await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      notify: (text) => Effect.sync(() => void notices.push(text)),
      install: (folder, packages) =>
        Effect.promise(async () => {
          installs.push([folder, packages])
          await installTo(folder, packages)
        }),
      importModule: (path) =>
        Effect.sync(() => {
          imported.push(path)
          return path.endsWith(TUI_BUNDLE) ? MODULE : {}
        }),
    })
    expect(module).toBe(MODULE)
    expect(installs).toEqual([[target, PACKAGES]])
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(`installing the setup interface into ${target} (first run only)`)
    expect(imported).toEqual([
      join(target, "node_modules", "@opentui", "solid", "scripts", "preload.js"),
      join(target, TUI_BUNDLE),
    ])
    expect(await readFile(join(target, TUI_BUNDLE), "utf8")).toBe("export const runSetupTui = 1")
  })

  test("does not install again when every package is in place at its version", async () => {
    const bundle = await bundleFile()
    const target = join(directory, "cache")
    await installTo(target, PACKAGES)
    let installs = 0
    const notices: Array<string> = []
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      notify: (text) => Effect.sync(() => void notices.push(text)),
      install: () => Effect.sync(() => void (installs += 1)),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(0)
    expect(notices).toEqual([])
  })

  test("installs again when a package is there at another version", async () => {
    const bundle = await bundleFile()
    const target = join(directory, "cache")
    await installTo(target, { ...PACKAGES, "solid-js": "1.0.0" })
    let installs = 0
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      install: (folder, packages) =>
        Effect.promise(async () => {
          installs += 1
          await installTo(folder, packages)
        }),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(1)
  })

  test("falls back with the install's reason when the install fails, offline included, and imports nothing", async () => {
    const bundle = await bundleFile()
    let imports = 0
    const failure = await load({
      packages: PACKAGES,
      bundle,
      directory: join(directory, "cache"),
      install: () =>
        Effect.fail(
          new TuiUnavailable({
            reason:
              "bun install failed (exit 1): GET https://registry.npmjs.org/solid-js - ENOTFOUND",
          }),
        ),
      importModule: () => Effect.sync(() => void (imports += 1)),
    })
    expect(failure).toBeInstanceOf(TuiUnavailable)
    expect(failure.message).toContain("ENOTFOUND")
    expect(imports).toBe(0)
  })

  test("falls back when the install ends without the packages at their versions", async () => {
    const bundle = await bundleFile()
    const failure = await load({
      packages: PACKAGES,
      bundle,
      directory: join(directory, "cache"),
      install: () => Effect.void,
      importModule: () => Effect.succeed(MODULE),
    })
    expect(failure.message).toContain("does not hold the expected package versions")
  })

  test("falls back when the TUI bundle is missing, before installing anything", async () => {
    let installs = 0
    const failure = await load({
      packages: PACKAGES,
      bundle: join(directory, "missing", TUI_BUNDLE),
      directory: join(directory, "cache"),
      install: () => Effect.sync(() => void (installs += 1)),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(failure.message).toContain("the interface bundle")
    expect(failure.message).toContain("is missing")
    expect(installs).toBe(0)
  })

  test("falls back when the preload or the bundle cannot be imported", async () => {
    const bundle = await bundleFile()
    const target = join(directory, "cache")
    await installTo(target, PACKAGES)
    const preload = await load({
      packages: PACKAGES,
      bundle,
      directory: target,
      importModule: (path) =>
        Effect.fail(new TuiUnavailable({ reason: `cannot import ${path}: boom` })),
    })
    expect(preload.message).toContain("preload.js: boom")
    const second = await load({
      packages: PACKAGES,
      bundle,
      directory: target,
      importModule: (path) =>
        path.endsWith(TUI_BUNDLE)
          ? Effect.fail(
              new TuiUnavailable({
                reason: "cannot import the bundle: the native library is missing",
              }),
            )
          : Effect.succeed({}),
    })
    expect(second.message).toContain("the native library is missing")
  })

  test("falls back when the bundle does not export runSetupTui", async () => {
    const bundle = await bundleFile()
    const target = join(directory, "cache")
    await installTo(target, PACKAGES)
    const failure = await load({
      packages: PACKAGES,
      bundle,
      directory: target,
      importModule: () => Effect.succeed({ other: 1 }),
    })
    expect(failure.message).toContain("does not export runSetupTui")
  })
})

describe("the real install and import steps", () => {
  test("bun install writes the exact versions and runs with no .env and the empty Bun config", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const target = join(directory, "cache")
    await Effect.runPromise(bunInstall(target, PACKAGES).pipe(Effect.provide(shell.layer)))
    expect(JSON.parse(await readFile(join(target, "package.json"), "utf8"))).toEqual({
      name: "holyagent-setup-tui",
      private: true,
      dependencies: PACKAGES,
    })
    expect(shell.calls).toHaveLength(1)
    expect(shell.calls[0]?.command).toBe("bun")
    expect(shell.calls[0]?.args).toEqual([
      "--no-env-file",
      `--config=${EMPTY_BUNFIG}`,
      "install",
      "--ignore-scripts",
    ])
    expect(shell.calls[0]?.cwd).toBe(target)
  })

  test("a failing bun install is TuiUnavailable with the line of its output that says why", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: () => ({
        exitCode: 1,
        stderr: "Resolving dependencies\nerror: failed to resolve\nsecond line",
      }),
    })
    const failure = await Effect.runPromise(
      bunInstall(join(directory, "cache"), PACKAGES).pipe(Effect.flip, Effect.provide(shell.layer)),
    )
    expect(failure).toBeInstanceOf(TuiUnavailable)
    expect(failure.message).toBe("bun install failed (exit 1): error: failed to resolve")
  })

  test("importing a file that does not exist is TuiUnavailable", async () => {
    const failure = await Effect.runPromise(
      importFile(join(directory, "nothing.js")).pipe(Effect.flip),
    )
    expect(failure.message).toContain("cannot import")
  })

  test("loads the built TUI bundle for real from a folder that holds the pinned packages", async () => {
    // The repository's own install stands in for the cache folder: same packages, same versions.
    const target = join(directory, "cache")
    await mkdir(target, { recursive: true })
    await symlink(
      join(import.meta.dir, "../../../node_modules"),
      join(target, "node_modules"),
      "dir",
    )
    const bundle = join(import.meta.dir, "../../integrations/claude/dist/scripts", TUI_BUNDLE)
    const module = await loaded({ bundle, directory: target })
    expect(typeof module.runSetupTui).toBe("function")
  })
})

describe("when the interface is not used", () => {
  const terminal = { stdin: true, stdout: true }
  const base = { env: {}, terminal, noTui: false, choiceFlag: false }

  test("is used on a terminal with no flag, no CI and a TERM that draws", () => {
    expect(tuiFallbackReason(base)).toBeUndefined()
    expect(
      tuiFallbackReason({ ...base, env: { TERM: "xterm-256color", CI: "false" } }),
    ).toBeUndefined()
  })

  test.each([
    ["--no-tui", { noTui: true }, "--no-tui was passed"],
    ["a choice flag", { choiceFlag: true }, "a choice flag was passed, so it applies directly"],
    ["no terminal", { terminal: undefined }, "stdin or stdout is not a terminal"],
    [
      "stdin not a terminal",
      { terminal: { stdin: false, stdout: true } },
      "stdin or stdout is not a terminal",
    ],
    [
      "stdout not a terminal",
      { terminal: { stdin: true, stdout: false } },
      "stdin or stdout is not a terminal",
    ],
    ["CI", { env: { CI: "true" } }, "CI is set"],
    ["a dumb terminal", { env: { TERM: "dumb" } }, "TERM is dumb"],
  ])("%s gives the line-based setup", (_, change, reason) => {
    expect(tuiFallbackReason({ ...base, ...change })).toBe(reason)
  })
})
