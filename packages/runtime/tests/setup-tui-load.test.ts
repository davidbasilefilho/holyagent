import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { EMPTY_BUNFIG } from "../src/setup/shell.ts"
import { TUI_BUNDLE } from "../src/setup/tui/files.ts"
import {
  bunInstall,
  cacheHome,
  importFile,
  INSTALLED_MARKER,
  loadSetupTui,
  markerText,
  plain,
  tuiDirectory,
  TuiUnavailable,
} from "../src/setup/tui/load.ts"
import { TUI_LOCK, TUI_PACKAGES } from "../src/setup/tui/packages.ts"
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
// The first eight hex digits of the SHA-256 of the lock text "lock".
const EXPECTED_DIRECTORY = (root: string) =>
  join(
    root,
    "holyagent",
    "setup-tui",
    "opentui-core-1.0.0_opentui-solid-1.0.1_solid-js-2.0.0_0c030586",
  )

const POSIX = process.platform !== "win32"

/** Puts the packages in a folder as an install would, at the given versions, marker last. */
const installTo = async (
  folder: string,
  versions: Record<string, string>,
  lock: string = TUI_LOCK,
) => {
  for (const [name, version] of Object.entries(versions)) {
    await mkdir(join(folder, "node_modules", name), { recursive: true })
    await writeFile(
      join(folder, "node_modules", name, "package.json"),
      JSON.stringify({ name, version }),
    )
  }
  await writeFile(join(folder, INSTALLED_MARKER), markerText(PACKAGES, lock))
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
    const at = (packages: Record<string, string>, lock: string) =>
      tuiDirectory({ XDG_CACHE_HOME: "/c" }, packages, "linux", lock)
    expect(at(PACKAGES, "lock")).toBe(EXPECTED_DIRECTORY("/c"))
    expect(at({ ...PACKAGES, "solid-js": "2.0.1" }, "lock")).not.toBe(EXPECTED_DIRECTORY("/c"))
    // A lock that moved a transitive package installs beside the old folder too.
    expect(at(PACKAGES, "another lock")).not.toBe(EXPECTED_DIRECTORY("/c"))
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
    const installs: Array<readonly [string, Record<string, string>, string]> = []
    const notices: Array<string> = []
    const module = await loaded({
      packages: PACKAGES,
      lock: "the lock",
      bundle,
      directory: target,
      notify: (text) => Effect.sync(() => void notices.push(text)),
      install: (folder, packages, lock) =>
        Effect.promise(async () => {
          installs.push([folder, packages, lock])
          await installTo(folder, packages)
          await rm(join(folder, INSTALLED_MARKER))
        }),
      importModule: (path) =>
        Effect.sync(() => {
          imported.push(path)
          return path.endsWith(TUI_BUNDLE) ? MODULE : {}
        }),
    })
    expect(module).toBe(MODULE)
    // The install runs in a fresh folder beside the final one, with the lock, and is renamed into place.
    expect(installs).toHaveLength(1)
    expect(installs[0]?.[0]).not.toBe(target)
    expect(dirname(installs[0]?.[0] ?? "")).toBe(dirname(target))
    expect(installs[0]?.[1]).toEqual(PACKAGES)
    expect(installs[0]?.[2]).toBe("the lock")
    expect(await readFile(join(target, INSTALLED_MARKER), "utf8")).toBe(
      markerText(PACKAGES, "the lock"),
    )
    expect((await readdir(dirname(target))).toSorted()).toEqual(["cache", "source"])
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

describe("an install that is interrupted, raced or planted", () => {
  const stage = async () => {
    const bundle = await bundleFile("export const runSetupTui = 1")
    return { bundle, target: join(directory, "cache", "versions") }
  }
  const fullInstall = (folder: string, packages: Record<string, string>) =>
    Effect.promise(() => installTo(folder, packages))

  test("a killed install leaves nothing at the final folder, and the next run installs again", async () => {
    const { bundle, target } = await stage()
    const killed = await load({
      packages: PACKAGES,
      bundle,
      directory: target,
      install: (folder, packages) =>
        Effect.promise(async () => {
          await installTo(folder, packages)
          await rm(join(folder, "node_modules", "@opentui", "solid", "package.json"))
        }).pipe(Effect.andThen(Effect.fail(new TuiUnavailable({ reason: "killed halfway" })))),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(killed.message).toBe("killed halfway")
    expect(await readdir(dirname(target))).toEqual([])
    let installs = 0
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      install: (folder, packages) =>
        Effect.sync(() => void (installs += 1)).pipe(Effect.andThen(fullInstall(folder, packages))),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(1)
  })

  test("a folder without the completion marker is absent: it is replaced, not trusted", async () => {
    const { bundle, target } = await stage()
    // Every package in place at its version, as a killed install could leave it, but no marker.
    await installTo(target, PACKAGES)
    await rm(join(target, INSTALLED_MARKER))
    await writeFile(join(target, "half-written.js"), "export const")
    let installs = 0
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      install: (folder, packages) =>
        Effect.sync(() => void (installs += 1)).pipe(Effect.andThen(fullInstall(folder, packages))),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(1)
    expect(await readFile(join(target, INSTALLED_MARKER), "utf8")).toBe(
      markerText(PACKAGES, TUI_LOCK),
    )
    expect(await readdir(target)).not.toContain("half-written.js")
  })

  test("a marker for other packages does not count either", async () => {
    const { bundle, target } = await stage()
    await installTo(target, PACKAGES)
    await writeFile(
      join(target, INSTALLED_MARKER),
      markerText({ ...PACKAGES, "solid-js": "1.0.0" }, TUI_LOCK),
    )
    let installs = 0
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      install: (folder, packages) =>
        Effect.sync(() => void (installs += 1)).pipe(Effect.andThen(fullInstall(folder, packages))),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(1)
  })

  test("a marker for another lock does not count: the same packages are installed again from this one", async () => {
    const { bundle, target } = await stage()
    await installTo(target, PACKAGES, "another lock")
    let installs = 0
    await loaded({
      packages: PACKAGES,
      lock: "this lock",
      bundle,
      directory: target,
      install: (folder, packages) =>
        Effect.sync(() => void (installs += 1)).pipe(
          Effect.andThen(Effect.promise(() => installTo(folder, packages, "this lock"))),
        ),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(1)
    expect(await readFile(join(target, INSTALLED_MARKER), "utf8")).toBe(
      markerText(PACKAGES, "this lock"),
    )
    expect(markerText(PACKAGES, "this lock")).not.toBe(markerText(PACKAGES, "another lock"))
  })

  test("sweeps the temporary folders an earlier run left, and keeps a recent one and other folders", async () => {
    const { bundle, target } = await stage()
    const parent = dirname(target)
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const leftovers = [".versions-AbC123", ".versions-Zz9999"]
    await mkdir(parent, { recursive: true, mode: 0o700 })
    await chmod(parent, 0o700)
    for (const name of [...leftovers, ".versions-recent", ".other-AbC123", "plain"]) {
      await mkdir(join(parent, name, "node_modules"), { recursive: true })
      await writeFile(join(parent, name, "node_modules", "file"), "x")
    }
    for (const name of [...leftovers, ".other-AbC123"]) await utimes(join(parent, name), old, old)
    let installs = 0
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      install: (folder, packages) =>
        Effect.sync(() => void (installs += 1)).pipe(Effect.andThen(fullInstall(folder, packages))),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(1)
    expect((await readdir(parent)).toSorted()).toEqual([
      ".other-AbC123",
      ".versions-recent",
      "plain",
      "versions",
    ])
  })

  test("two first runs at once: the first rename wins and the second uses it without a mess", async () => {
    const { bundle, target } = await stage()
    let installs = 0
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      // Another run finishes its install and renames it into place while this one is installing.
      install: (folder, packages) =>
        Effect.promise(async () => {
          installs += 1
          await installTo(target, packages)
          await writeFile(join(target, "winner"), "first")
          await installTo(folder, packages)
        }),
      importModule: () => Effect.succeed(MODULE),
    })
    expect(installs).toBe(1)
    expect(await readFile(join(target, "winner"), "utf8")).toBe("first")
    expect((await readdir(dirname(target))).toSorted()).toEqual(["versions"])
  })

  test.skipIf(!POSIX)("creates the cache folders private, with mode 0700", async () => {
    const { bundle, target } = await stage()
    await loaded({
      packages: PACKAGES,
      bundle,
      directory: target,
      install: fullInstall,
      importModule: () => Effect.succeed(MODULE),
    })
    expect((await stat(dirname(target))).mode & 0o777).toBe(0o700)
    expect((await stat(target)).mode & 0o777).toBe(0o700)
  })

  test.skipIf(!POSIX)(
    "refuses a cache folder that others can write, and falls back with the reason",
    async () => {
      const { bundle, target } = await stage()
      await mkdir(dirname(target), { recursive: true })
      await chmod(dirname(target), 0o777)
      let installs = 0
      const failure = await load({
        packages: PACKAGES,
        bundle,
        directory: target,
        install: () => Effect.sync(() => void (installs += 1)),
        importModule: () => Effect.succeed(MODULE),
      })
      expect(failure).toBeInstanceOf(TuiUnavailable)
      expect(failure.message).toContain(
        `the cache folder ${dirname(target)} can be written by others`,
      )
      expect(installs).toBe(0)
      await chmod(dirname(target), 0o770)
      expect((await load({ packages: PACKAGES, bundle, directory: target })).message).toContain(
        "can be written by others",
      )
    },
  )

  describe.skipIf(!POSIX)("the cache home itself", () => {
    // The folder every cache folder sits in: XDG_CACHE_HOME, as the real load resolves it.
    const home = () => join(directory, "cache-home")
    const attempt = async (options: { uid?: number } = {}) => {
      const bundle = await bundleFile("export const runSetupTui = 1")
      let installs = 0
      const run = loadSetupTui(
        { XDG_CACHE_HOME: home() },
        {
          packages: PACKAGES,
          bundle,
          ...options,
          install: (folder, packages) =>
            Effect.sync(() => void (installs += 1)).pipe(
              Effect.andThen(fullInstall(folder, packages)),
            ),
          importModule: () => Effect.succeed(MODULE),
        },
      ).pipe(Effect.provide(fakeShell({ commands: ["bun"] }).layer))
      const outcome = await Effect.runPromise(Effect.result(run))
      return { outcome, installs: () => installs }
    }

    test("a group-writable cache home is refused, with nothing installed", async () => {
      await mkdir(home(), { recursive: true })
      await chmod(home(), 0o775)
      const { outcome, installs } = await attempt()
      expect(outcome._tag).toBe("Failure")
      expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain(
        `the cache home ${home()} can be written by others`,
      )
      expect(installs()).toBe(0)
      expect(await readdir(home())).toEqual([])
    })

    test("a world-writable cache home with the sticky bit, a user-only one and a missing one are fine", async () => {
      await mkdir(home(), { recursive: true })
      await chmod(home(), 0o1777)
      expect((await attempt()).outcome._tag).toBe("Success")
      await rm(home(), { recursive: true, force: true })
      await mkdir(home(), { recursive: true })
      await chmod(home(), 0o755)
      expect((await attempt()).outcome._tag).toBe("Success")
      await rm(home(), { recursive: true, force: true })
      expect((await attempt()).outcome._tag).toBe("Success")
    })

    test("a cache home that is a link is refused", async () => {
      await mkdir(join(directory, "elsewhere"), { recursive: true, mode: 0o700 })
      await symlink(join(directory, "elsewhere"), home(), "dir")
      const { outcome, installs } = await attempt()
      expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain(
        `the cache home ${home()} is not a plain directory`,
      )
      expect(installs()).toBe(0)
      expect(await readdir(join(directory, "elsewhere"))).toEqual([])
    })

    test("a cache home that belongs to another user is refused", async () => {
      await mkdir(home(), { recursive: true })
      await chmod(home(), 0o755)
      const { outcome, installs } = await attempt({ uid: (process.getuid?.() ?? 0) + 1 })
      expect(outcome._tag === "Failure" ? outcome.failure.message : "").toContain(
        `the cache home ${home()} belongs to another user`,
      )
      expect(installs()).toBe(0)
    })
  })

  test.skipIf(!POSIX)("refuses a cache folder that belongs to another user", async () => {
    const { bundle, target } = await stage()
    await installTo(target, PACKAGES)
    await chmod(target, 0o700)
    let imports = 0
    const failure = await load({
      packages: PACKAGES,
      bundle,
      directory: target,
      uid: (process.getuid?.() ?? 0) + 1,
      importModule: () => Effect.sync(() => void (imports += 1)),
    })
    expect(failure.message).toContain("belongs to another user")
    expect(imports).toBe(0)
  })

  test.skipIf(!POSIX)(
    "refuses an installed folder that is a link or that others can write",
    async () => {
      const { bundle, target } = await stage()
      await installTo(join(directory, "elsewhere"), PACKAGES)
      await mkdir(dirname(target), { recursive: true })
      await symlink(join(directory, "elsewhere"), target, "dir")
      const linked = await load({ packages: PACKAGES, bundle, directory: target })
      expect(linked.message).toContain("is not a plain directory")
      await rm(target)
      await installTo(target, PACKAGES)
      await chmod(target, 0o777)
      expect((await load({ packages: PACKAGES, bundle, directory: target })).message).toContain(
        "can be written by others",
      )
    },
  )

  test.skipIf(!POSIX)(
    "writes the bundle without following a link planted at its path",
    async () => {
      const { bundle, target } = await stage()
      await installTo(target, PACKAGES)
      await chmod(target, 0o700)
      const victim = join(directory, "victim.txt")
      await writeFile(victim, "keep me")
      await symlink(victim, join(target, TUI_BUNDLE))
      await loaded({
        packages: PACKAGES,
        bundle,
        directory: target,
        importModule: () => Effect.succeed(MODULE),
      })
      expect(await readFile(victim, "utf8")).toBe("keep me")
      expect((await lstat(join(target, TUI_BUNDLE))).isSymbolicLink()).toBe(false)
      expect(await readFile(join(target, TUI_BUNDLE), "utf8")).toBe("export const runSetupTui = 1")
    },
  )
})

describe("what the install is held to", () => {
  test("the embedded lock names the three packages and the whole tree the repository's lock resolves", async () => {
    const root = Bun.JSONC.parse(
      await readFile(join(import.meta.dir, "../../../bun.lock"), "utf8"),
    ) as { packages: Record<string, unknown> }
    const lock = JSON.parse(TUI_LOCK) as {
      workspaces: Record<string, { dependencies: Record<string, string> }>
      packages: Record<string, unknown>
    }
    expect(lock.workspaces[""]?.dependencies).toEqual(TUI_PACKAGES)
    // Entries are the repository's, byte for byte, so versions and integrity hashes are the same.
    for (const [key, entry] of Object.entries(lock.packages))
      expect(entry).toEqual(root.packages[key])
    // Solid's s-js and the native renderer, which no direct dependency pins, are in the lock.
    for (const key of ["s-js", "@opentui/core-linux-x64", "@opentui/core-darwin-arm64"])
      expect(Object.keys(lock.packages)).toContain(key)
    // It holds the tree of the three packages and nothing of the repository's other dependencies.
    expect(Object.keys(lock.packages)).not.toContain("effect")
    expect(Object.keys(lock.packages).length).toBeLessThan(Object.keys(root.packages).length)
  })

  test("a bun install failure's output cannot move the cursor or recolour the terminal", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: () => ({
        exitCode: 1,
        stderr:
          "Resolving dependencies\n\u001B[31m\u001B]0;pwned\u0007error\u001B[0m: bad\u001B[2J\u0008\r tail\n",
      }),
    })
    const failure = await Effect.runPromise(
      bunInstall(join(directory, "cache"), PACKAGES).pipe(Effect.flip, Effect.provide(shell.layer)),
    )
    expect(failure.message).toBe("bun install failed (exit 1): error: bad tail")
  })

  test("plain removes escape sequences, control characters and line breaks", () => {
    expect(plain("\u001B[1;31mred\u001B[0m \u001B]8;;http://x\u0007link\u001B]8;;\u0007")).toBe(
      "red link",
    )
    expect(plain("a\u0000b\u0007c\u007Fd\u0085e\r\nf\tg")).toBe("abcdefg")
    expect(plain("日本語 ünï ✓")).toBe("日本語 ünï ✓")
  })

  test("plain removes bidi controls and other format characters that change how a line reads", () => {
    // An embedding that flips the text after it, an isolate, zero-width characters, a joiner, a
    // BOM and the Arabic letter mark: none is drawn, and all of them can reorder or hide text.
    expect(
      plain("error: \u202Efdp.exe\u202C \u2066x\u2069 a\u200Bb\u200Cc\u200Dd\u200Ee\u200Ff"),
    ).toBe("error: fdp.exe x abcdef")
    expect(plain("\uFEFFok\u061C\u00ADdone\u2060")).toBe("okdone")
  })

  test("a failure's reason carries no bidi control either", async () => {
    const shell = fakeShell({
      commands: ["bun"],
      respond: () => ({ exitCode: 1, stderr: "error: \u202Egnp.exe\u200B failed\n" }),
    })
    const failure = await Effect.runPromise(
      bunInstall(join(directory, "cache"), PACKAGES).pipe(Effect.flip, Effect.provide(shell.layer)),
    )
    expect(failure.message).toBe("bun install failed (exit 1): error: gnp.exe failed")
  })

  test("an import error's text is plain too", async () => {
    const failure = await Effect.runPromise(
      importFile(join(directory, "nothing\u001B[31m.js")).pipe(Effect.flip),
    )
    expect(failure.message).not.toContain("\u001B")
  })
})

describe("the real install and import steps", () => {
  test("bun install writes the exact versions and runs with no .env and the empty Bun config", async () => {
    const shell = fakeShell({ commands: ["bun"] })
    const target = join(directory, "cache")
    await Effect.runPromise(
      bunInstall(target, PACKAGES, "the lock\n").pipe(Effect.provide(shell.layer)),
    )
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
      "--frozen-lockfile",
      "--ignore-scripts",
    ])
    expect(shell.calls[0]?.cwd).toBe(target)
    // The lock beside the manifest is what `--frozen-lockfile` holds the install to.
    expect(await readFile(join(target, "bun.lock"), "utf8")).toBe("the lock\n")
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
    await writeFile(join(target, INSTALLED_MARKER), markerText(TUI_PACKAGES, TUI_LOCK))
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
