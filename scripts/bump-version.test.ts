import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import {
  type BumpKind,
  bumpVersion,
  bumpVersions,
  compareVersions,
  formatVersion,
  InvalidVersion,
  LOCKFILE,
  ManifestError,
  parseVersion,
  syncVersions,
  VERSION_COPIES,
  VERSION_SOURCE,
} from "./bump-version.ts"

const repository = join(import.meta.dir, "..")
const readJson = async <T>(file: string): Promise<T> =>
  (await Bun.file(join(repository, file)).json()) as T
interface Versioned {
  readonly version: string
}

const bump = (input: string, kind: BumpKind) =>
  Effect.runSync(
    parseVersion(input).pipe(Effect.map((version) => formatVersion(bumpVersion(version, kind)))),
  )

describe("bumpVersion", () => {
  test.each([
    ["0.1.0", "minor", "0.2.0"],
    ["0.1.0", "patch", "0.1.1"],
    ["0.3.2-1", "patch", "0.3.3"],
    ["0.3.2-1", "minor", "0.4.0"],
    ["0.9.9", "minor", "0.10.0"],
    ["0.0.9", "patch", "0.0.10"],
  ] as const)("%s bumped by %s is %s", (from, kind, to) => {
    expect(bump(from, kind)).toBe(to)
  })

  test.each(["0.1.0", "0.12.34"])("%s round-trips through parse and format", (v) => {
    expect(Effect.runSync(parseVersion(v).pipe(Effect.map(formatVersion)))).toBe(v)
  })

  test("a legacy -Z suffix is accepted on input and never written", () => {
    expect(Effect.runSync(parseVersion("0.3.2-1").pipe(Effect.map(formatVersion)))).toBe("0.3.2")
  })

  test.each([
    "",
    "1.2.3",
    "0.1",
    "0.1.0.0",
    "0.1.0-",
    "0.1.0-0",
    "0.1.0-1-2",
    "0.1.0-beta",
    "0.01.0",
    "0.1.0-01",
    "v0.1.0",
    "0.1.0\n",
  ])("rejects %j with InvalidVersion", (input) => {
    const error = Effect.runSync(Effect.flip(parseVersion(input)))
    expect(error).toBeInstanceOf(InvalidVersion)
    expect(error.input).toBe(input)
  })
})

describe("compareVersions", () => {
  const sign = (a: string, b: string) =>
    Math.sign(
      Effect.runSync(
        Effect.all([parseVersion(a), parseVersion(b)]).pipe(
          Effect.map(([x, y]) => compareVersions(x, y)),
        ),
      ),
    )

  test.each([
    ["0.2.1", "0.2.0", 1],
    ["0.3.0", "0.2.9", 1],
    ["0.10.0", "0.9.0", 1],
    ["0.2.10", "0.2.9", 1],
    ["0.2.1", "0.2.1", 0],
    ["0.2.1-3", "0.2.1", 0],
    ["0.2.0", "0.2.1", -1],
    ["0.2.9", "0.3.0", -1],
  ] as const)("%s compared with %s is %d", (a, b, expected) => {
    expect(sign(a, b)).toBe(expected)
  })
})

/** A lockfile in Bun's style: a root workspace without a version, two with, and a package entry. */
const lockfile = (version: string) => `{
  "lockfileVersion": 2,
  "workspaces": {
    "": {
      "name": "root",
      "devDependencies": {
        "effect": "^4.0.0",
      },
    },
    "packages/integrations/claude": {
      "name": "@scope/claude",
      "version": "${version}",
      "dependencies": {
        "effect": "^4.0.0",
      },
    },
    "packages/runtime": {
      "name": "@scope/runtime",
      "version": "${version}",
    },
  },
  "packages": {
    "effect": ["effect@4.0.4", "", {}, "sha512-x"],
  },
}
`

/** Manifest text in the repository's style, with fields before and after `version`. */
const manifest = (file: string, version: string) =>
  `${JSON.stringify(
    { name: file, version, description: "kept", scripts: { build: "x" }, license: "MIT" },
    null,
    2,
  )}\n`

let root = ""
const read = (file: string) => readFileSync(join(root, file), "utf8")
const write = (file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), text)
}
const FILES = [VERSION_SOURCE, ...VERSION_COPIES, LOCKFILE]
const state = () => FILES.map(read)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "holyagent-bump-"))
  write(VERSION_SOURCE, manifest(VERSION_SOURCE, "0.3.2-1"))
  for (const file of VERSION_COPIES) write(file, manifest(file, "0.3.2-1"))
  write(LOCKFILE, lockfile("0.3.2-1"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("bumpVersions", () => {
  test.each([
    ["minor", "0.4.0"],
    ["patch", "0.3.3"],
  ] as const)("a %s bump writes %s to the source only", async (kind, to) => {
    const before = state()
    expect(await Effect.runPromise(bumpVersions(root, kind))).toEqual({ from: "0.3.2-1", to })
    expect(read(VERSION_SOURCE)).toBe(
      before[0]!.replace(`"version": "0.3.2-1"`, `"version": "${to}"`),
    )
    expect(state().slice(1)).toEqual(before.slice(1))
  })

  test("rewrites the repository's own root manifest keeping its formatting", async () => {
    cpSync(join(repository, VERSION_SOURCE), join(root, VERSION_SOURCE))
    const before = read(VERSION_SOURCE)
    const { from, to } = await Effect.runPromise(bumpVersions(root, "patch"))
    expect(to).toBe(bump(from, "patch"))
    expect(read(VERSION_SOURCE)).toBe(
      before.replace(new RegExp(`("version": ")${from}(")`), `$1${to}$2`),
    )
  })

  test("bumps a source whose copies are behind, without reading them", async () => {
    write("packages/runtime/package.json", manifest("runtime", "0.3.1"))
    expect((await Effect.runPromise(bumpVersions(root, "patch"))).to).toBe("0.3.3")
  })

  test("fails with InvalidVersion when the source is malformed", async () => {
    write(VERSION_SOURCE, manifest(VERSION_SOURCE, "1.0"))
    const before = state()
    const error = await Effect.runPromise(Effect.flip(bumpVersions(root, "patch")))
    expect(error).toBeInstanceOf(InvalidVersion)
    expect(state()).toEqual(before)
  })

  test.each([
    ["is missing", undefined],
    ["has no version", `{ "name": "x" }\n`],
    ["has a non-string version", `{ "version": 1 }\n`],
    ["is not JSON", "nope"],
  ])("fails with ManifestError when the source %s", async (_name, text) => {
    if (text === undefined) rmSync(join(root, VERSION_SOURCE))
    else write(VERSION_SOURCE, text)
    const error = await Effect.runPromise(Effect.flip(bumpVersions(root, "patch")))
    expect(error).toBeInstanceOf(ManifestError)
    expect(error.message).toContain(VERSION_SOURCE)
  })
})

describe("syncVersions", () => {
  test("writes the source version to every copy and workspace entry and nothing else", async () => {
    write(VERSION_SOURCE, manifest(VERSION_SOURCE, "0.4.0"))
    const before = state()
    expect(await Effect.runPromise(syncVersions(root))).toBe("0.4.0")
    VERSION_COPIES.forEach((file, index) => {
      expect(read(file)).toBe(
        before[index + 1]!.replace(`"version": "0.3.2-1"`, `"version": "0.4.0"`),
      )
    })
    expect(read(VERSION_SOURCE)).toBe(before[0]!)
    expect(read(LOCKFILE)).toBe(lockfile("0.4.0"))
  })

  test("a bump followed by a sync leaves one version in every file", async () => {
    await Effect.runPromise(bumpVersions(root, "minor"))
    await Effect.runPromise(syncVersions(root))
    for (const file of [VERSION_SOURCE, ...VERSION_COPIES])
      expect(read(file)).toContain(`"version": "0.4.0"`)
    expect(read(LOCKFILE)).toBe(lockfile("0.4.0"))
  })

  test("is a no-op on files that already agree", async () => {
    write(VERSION_SOURCE, manifest(VERSION_SOURCE, "0.3.2"))
    await Effect.runPromise(syncVersions(root))
    const synced = state()
    await Effect.runPromise(syncVersions(root))
    expect(state()).toEqual(synced)
  })

  test("rewrites the repository's own manifests keeping their formatting", async () => {
    for (const file of FILES) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      cpSync(join(repository, file), join(root, file))
    }
    const before = state()
    const { to } = await Effect.runPromise(bumpVersions(root, "minor"))
    await Effect.runPromise(syncVersions(root))
    const after = state()
    const from = (await readJson<Versioned>(VERSION_SOURCE)).version
    before.forEach((text, index) => {
      expect(after[index]).toBe(
        text.replace(new RegExp(`("version": ")${from}(")`, "g"), `$1${to}$2`),
      )
    })
  })

  test("fails with InvalidVersion and writes nothing when the source is malformed", async () => {
    write(VERSION_SOURCE, manifest(VERSION_SOURCE, "1.0"))
    const before = state()
    const error = await Effect.runPromise(Effect.flip(syncVersions(root)))
    expect(error).toBeInstanceOf(InvalidVersion)
    expect(state()).toEqual(before)
  })

  test("fails with ManifestError naming a copy that is missing, writing nothing", async () => {
    write(VERSION_SOURCE, manifest(VERSION_SOURCE, "0.4.0"))
    rmSync(join(root, "packages/integrations/claude/package.json"))
    const written = [VERSION_SOURCE, "packages/runtime/package.json", LOCKFILE]
    const before = written.map(read)
    const error = await Effect.runPromise(Effect.flip(syncVersions(root)))
    expect(error).toBeInstanceOf(ManifestError)
    expect(error.message).toContain("packages/integrations/claude/package.json")
    expect(written.map(read)).toEqual(before)
  })

  test("syncs a lockfile with CRLF line endings, keeping them", async () => {
    write(VERSION_SOURCE, manifest(VERSION_SOURCE, "0.4.0"))
    write(LOCKFILE, lockfile("0.3.2-1").replaceAll("\n", "\r\n"))
    await Effect.runPromise(syncVersions(root))
    expect(read(LOCKFILE)).toBe(lockfile("0.4.0").replaceAll("\n", "\r\n"))
  })

  test.each([
    ["is missing", undefined],
    ["has no workspace version", `{ "workspaces": { "": { "name": "root" } } }\n`],
  ])("fails with ManifestError and writes nothing when bun.lock %s", async (_name, text) => {
    write(VERSION_SOURCE, manifest(VERSION_SOURCE, "0.4.0"))
    if (text === undefined) rmSync(join(root, LOCKFILE))
    else write(LOCKFILE, text)
    const before = [VERSION_SOURCE, ...VERSION_COPIES].map(read)
    const error = await Effect.runPromise(Effect.flip(syncVersions(root)))
    expect(error).toBeInstanceOf(ManifestError)
    expect(error.message).toContain(LOCKFILE)
    expect([VERSION_SOURCE, ...VERSION_COPIES].map(read)).toEqual(before)
  })
})

describe("the command line", () => {
  const run = async (...args: string[]) => {
    const result = await $`${process.execPath} ${join(import.meta.dir, "bump-version.ts")} ${args}`
      .nothrow()
      .quiet()
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }

  test("a bump prints the old and new version, exits 0 and edits only the source", async () => {
    const { code, out } = await run("patch", root)
    expect(code).toBe(0)
    expect(out.trim()).toBe("0.3.2-1 -> 0.3.3")
    expect(read(VERSION_SOURCE)).toContain(`"version": "0.3.3"`)
    for (const file of VERSION_COPIES) expect(read(file)).toContain(`"version": "0.3.2-1"`)
    expect(read(LOCKFILE)).toBe(lockfile("0.3.2-1"))
  })

  test("sync prints the version, exits 0 and writes the copies", async () => {
    await run("minor", root)
    const { code, out } = await run("sync", root)
    expect(code).toBe(0)
    expect(out.trim()).toBe("0.4.0")
    for (const file of VERSION_COPIES) expect(read(file)).toContain(`"version": "0.4.0"`)
    expect(read(LOCKFILE)).toBe(lockfile("0.4.0"))
  })

  test("prints the tagged error and exits 1 when the source is unreadable", async () => {
    write(VERSION_SOURCE, "nope")
    const { code, err } = await run("patch", root)
    expect(code).toBe(1)
    expect(err).toContain("error: ManifestError")
    expect(err).toContain(VERSION_SOURCE)
  })

  test.each(["major", "hotfix"])(
    "prints usage and exits 1 on the unknown bump %s",
    async (kind) => {
      const { code, err } = await run(kind, root)
      expect(code).toBe(1)
      expect(err).toContain("error: Usage")
    },
  )
})

describe("a bump followed by one build", () => {
  // The build bundles the repository it sits in, so the test runs it in a copy of the sources. The
  // installed dependencies are linked, not copied, and the built plugin and Pi package are left
  // out: the build makes them again.
  const SKIPPED = ["node_modules", ".git", ".holyagent"]
  const BUILT = ["claude", "pi"].map((name) =>
    join(repository, `packages/integrations/${name}/dist`),
  )

  test("leaves every copy, the plugin and marketplace manifests included, at the new version", async () => {
    const copy = mkdtempSync(join(tmpdir(), "holyagent-build-bump-"))
    try {
      cpSync(repository, copy, {
        recursive: true,
        filter: (path) => !BUILT.includes(path) && !SKIPPED.includes(basename(path)),
      })
      symlinkSync(
        join(repository, "node_modules"),
        join(copy, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      )
      for (const workspace of ["packages/core", "packages/runtime", "packages/integrations/pi"]) {
        const source = join(repository, workspace, "node_modules")
        const destination = join(copy, workspace, "node_modules")
        mkdirSync(destination, { recursive: true })
        for (const name of readdirSync(source)) {
          if (name === ".bin" || name === "@holyagent") continue
          const names = name.startsWith("@")
            ? readdirSync(join(source, name)).map((child) => join(name, child))
            : [name]
          for (const dependency of names) {
            mkdirSync(dirname(join(destination, dependency)), { recursive: true })
            symlinkSync(
              realpathSync(join(source, dependency)),
              join(destination, dependency),
              process.platform === "win32" ? "junction" : "dir",
            )
          }
        }
        if (workspace !== "packages/core") {
          mkdirSync(join(destination, "@holyagent"), { recursive: true })
          symlinkSync(
            join(copy, "packages/core"),
            join(destination, "@holyagent/core"),
            process.platform === "win32" ? "junction" : "dir",
          )
        }
      }
      const { to } = await Effect.runPromise(bumpVersions(copy, "minor"))
      // The same two builds, in the same order, as the `build` task.
      for (const name of ["claude", "pi"]) {
        const build =
          await $`${process.execPath} ${join(copy, `packages/integrations/${name}/build.ts`)}`
            .nothrow()
            .quiet()
        expect(build.stderr.toString()).toBe("")
        expect(build.exitCode).toBe(0)
      }
      const versionOf = async (file: string) =>
        ((await Bun.file(join(copy, file)).json()) as { version?: string }).version
      const marketplace = (await Bun.file(
        join(copy, ".claude-plugin/marketplace.json"),
      ).json()) as {
        plugins: Versioned[]
      }
      const lock = Bun.JSONC.parse(await Bun.file(join(copy, LOCKFILE)).text()) as {
        workspaces: Record<string, { version?: string }>
      }
      expect({
        files: await Promise.all(
          [
            VERSION_SOURCE,
            ...VERSION_COPIES,
            "packages/integrations/claude/dist/.claude-plugin/plugin.json",
            "packages/integrations/pi/dist/package.json",
          ].map(versionOf),
        ),
        marketplace: marketplace.plugins.map(({ version }) => version),
        lockfile: Object.values(lock.workspaces).flatMap(({ version }) => version ?? []),
      }).toEqual({
        files: Array.from({ length: VERSION_COPIES.length + 3 }, () => to),
        marketplace: [to],
        lockfile: Array.from({ length: VERSION_COPIES.length }, () => to),
      })
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("a build whose version sync fails", () => {
  test("reports the error and exits 1 without building", async () => {
    // Only the files the build reads before the sync: the real tree is not needed to reach it.
    const copy = mkdtempSync(join(tmpdir(), "holyagent-build-fail-"))
    try {
      for (const file of [
        "scripts/bump-version.ts",
        "packages/integrations/claude/build.ts",
        "packages/integrations/claude/src/files.ts",
        "packages/runtime/src/domain/paths.ts",
        "packages/runtime/src/instructions/families.ts",
        "packages/runtime/src/instructions/generated.ts",
        "packages/runtime/src/instructions/requirements.ts",
        "packages/runtime/src/instructions/skills.ts",
      ])
        cpSync(join(repository, file), join(copy, file), { recursive: true })
      symlinkSync(
        join(repository, "node_modules"),
        join(copy, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      )
      await Bun.write(join(copy, "package.json"), JSON.stringify({ version: "1.x" }))
      const build =
        await $`${process.execPath} ${join(copy, "packages/integrations/claude/build.ts")}`
          .nothrow()
          .quiet()
      expect(build.stderr.toString()).toContain('error: InvalidVersion: Invalid version "1.x"')
      expect(build.stderr.toString()).not.toContain("FiberFailure")
      expect(build.exitCode).toBe(1)
      expect(build.stdout.toString()).not.toContain("built")
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  }, 30_000)
})

describe("the repository's versions", () => {
  test("every copy equals the version in the root package.json", async () => {
    const source = (await readJson<Versioned>(VERSION_SOURCE)).version
    expect(() => Effect.runSync(parseVersion(source))).not.toThrow()
    const lock = Bun.JSONC.parse(await Bun.file(join(repository, LOCKFILE)).text()) as {
      workspaces: Record<string, { version?: string }>
    }
    const marketplace = await readJson<{ plugins: Versioned[] }>(".claude-plugin/marketplace.json")
    const plugin = await readJson<Versioned>(
      "packages/integrations/claude/dist/.claude-plugin/plugin.json",
    )
    const copyVersions = await Promise.all(
      VERSION_COPIES.map(
        async (file) => [file, (await readJson<Versioned>(file)).version] as const,
      ),
    )
    const copies: Record<string, string | ReadonlyArray<string | undefined>> = {
      ...Object.fromEntries(copyVersions),
      "bun.lock workspaces": [
        ...new Set(
          Object.values(lock.workspaces).flatMap(({ version }) => (version ? [version] : [])),
        ),
      ],
      "plugin.json": plugin.version,
      "marketplace.json": marketplace.plugins.map(({ version }) => version),
    }
    const expected: typeof copies = {
      ...Object.fromEntries(VERSION_COPIES.map((file) => [file, source])),
      "bun.lock workspaces": [source],
      "plugin.json": source,
      "marketplace.json": [source],
    }
    expect(copies).toEqual(expected)
  })

  test("the bundled plugin CLI reports the version in the root package.json", async () => {
    const source = (await readJson<Versioned>(VERSION_SOURCE)).version
    const bundle = join(repository, "packages/integrations/claude/dist/scripts/holyagent.js")
    expect((await $`${process.execPath} ${bundle} --version`.quiet()).text()).toBe(`${source}\n`)
  })
})
