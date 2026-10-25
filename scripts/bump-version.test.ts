import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import {
  type BumpKind,
  bumpVersion,
  bumpVersions,
  formatVersion,
  InvalidVersion,
  LOCKFILE,
  ManifestError,
  parseVersion,
  VERSION_FILES,
  VersionMismatch,
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
    ["0.1.0", "hotfix", "0.1.0-1"],
    ["0.3.2-1", "hotfix", "0.3.2-2"],
    ["0.3.2-1", "patch", "0.3.3"],
    ["0.3.2-1", "minor", "0.4.0"],
    ["0.9.9", "minor", "0.10.0"],
    ["0.0.9", "patch", "0.0.10"],
  ] as const)("%s bumped by %s is %s", (from, kind, to) => {
    expect(bump(from, kind)).toBe(to)
  })

  test.each(["0.1.0", "0.3.2-1", "0.12.34-56"])("%s round-trips through parse and format", (v) => {
    expect(Effect.runSync(parseVersion(v).pipe(Effect.map(formatVersion)))).toBe(v)
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
    "packages/cli": {
      "name": "@scope/cli",
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
const state = () => [...VERSION_FILES, LOCKFILE].map(read)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "holyagent-bump-"))
  for (const file of VERSION_FILES) write(file, manifest(file, "0.3.2-1"))
  write(LOCKFILE, lockfile("0.3.2-1"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("bumpVersions", () => {
  test.each([
    ["minor", "0.4.0"],
    ["patch", "0.3.3"],
    ["hotfix", "0.3.2-2"],
  ] as const)("a %s bump writes %s to every file and changes nothing else", async (kind, to) => {
    const before = VERSION_FILES.map(read)
    expect(await Effect.runPromise(bumpVersions(root, kind))).toEqual({ from: "0.3.2-1", to })
    VERSION_FILES.forEach((file, index) => {
      expect(read(file)).toBe(before[index]!.replace(`"version": "0.3.2-1"`, `"version": "${to}"`))
    })
    expect(read(LOCKFILE)).toBe(lockfile(to))
  })

  test("a hotfix bump of a release version starts the hotfix count at 1", async () => {
    for (const file of VERSION_FILES) write(file, manifest(file, "0.1.0"))
    write(LOCKFILE, lockfile("0.1.0"))
    expect((await Effect.runPromise(bumpVersions(root, "hotfix"))).to).toBe("0.1.0-1")
  })

  test("rewrites the repository's own manifests keeping their formatting", async () => {
    for (const file of [...VERSION_FILES, LOCKFILE]) {
      mkdirSync(dirname(join(root, file)), { recursive: true })
      cpSync(join(repository, file), join(root, file))
    }
    const before = state()
    const { from, to } = await Effect.runPromise(bumpVersions(root, "hotfix"))
    expect(to).toBe(bump(from, "hotfix"))
    const after = state()
    before.forEach((text, index) => {
      expect(after[index]).toBe(
        text.replace(new RegExp(`("version": ")${from}(")`, "g"), `$1${to}$2`),
      )
    })
    expect(after.join()).toContain(`"version": "${to}"`)
  })

  test("refuses disagreeing versions, names each file and writes nothing", async () => {
    write("packages/runtime/package.json", manifest("runtime", "0.3.1"))
    const before = state()
    const error = await Effect.runPromise(Effect.flip(bumpVersions(root, "minor")))
    expect(error).toBeInstanceOf(VersionMismatch)
    for (const file of VERSION_FILES) expect(error.message).toContain(file)
    expect(error.message).toContain("packages/runtime/package.json 0.3.1")
    expect(state()).toEqual(before)
  })

  test("fails with InvalidVersion when all files agree on a malformed version", async () => {
    for (const file of VERSION_FILES) write(file, manifest(file, "1.0"))
    const before = state()
    const error = await Effect.runPromise(Effect.flip(bumpVersions(root, "patch")))
    expect(error).toBeInstanceOf(InvalidVersion)
    expect(state()).toEqual(before)
  })

  test("fails with ManifestError naming a file that is missing", async () => {
    rmSync(join(root, "packages/cli/package.json"))
    const error = await Effect.runPromise(Effect.flip(bumpVersions(root, "patch")))
    expect(error).toBeInstanceOf(ManifestError)
    expect(error.message).toContain("packages/cli/package.json")
  })

  test.each([
    ["has no version", `{ "name": "x" }\n`],
    ["has a non-string version", `{ "version": 1 }\n`],
    ["is not JSON", "nope"],
  ])("fails with ManifestError when a file %s", async (_name, text) => {
    write("packages/cli/package.json", text)
    const error = await Effect.runPromise(Effect.flip(bumpVersions(root, "patch")))
    expect(error).toBeInstanceOf(ManifestError)
    expect(error.message).toContain("packages/cli/package.json")
  })

  test.each([
    ["is missing", undefined],
    ["has no workspace version", `{ "workspaces": { "": { "name": "root" } } }\n`],
  ])("fails with ManifestError and writes nothing when bun.lock %s", async (_name, text) => {
    if (text === undefined) rmSync(join(root, LOCKFILE))
    else write(LOCKFILE, text)
    const before = VERSION_FILES.map(read)
    const error = await Effect.runPromise(Effect.flip(bumpVersions(root, "patch")))
    expect(error).toBeInstanceOf(ManifestError)
    expect(error.message).toContain(LOCKFILE)
    expect(VERSION_FILES.map(read)).toEqual(before)
  })
})

describe("the command line", () => {
  const run = async (...args: string[]) => {
    const result = await $`${process.execPath} ${join(import.meta.dir, "bump-version.ts")} ${args}`
      .nothrow()
      .quiet()
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }

  test("prints the old and new version and exits 0", async () => {
    const { code, out } = await run("hotfix", root)
    expect(code).toBe(0)
    expect(out.trim()).toBe("0.3.2-1 -> 0.3.2-2")
    expect(read("package.json")).toContain(`"version": "0.3.2-2"`)
  })

  test("prints the tagged error and exits 1 on disagreement", async () => {
    write("packages/cli/package.json", manifest("cli", "0.3.1"))
    const { code, err } = await run("patch", root)
    expect(code).toBe(1)
    expect(err).toContain("error: VersionMismatch")
    expect(err).toContain("packages/cli/package.json 0.3.1")
  })

  test("prints usage and exits 1 on an unknown bump", async () => {
    const { code, err } = await run("major", root)
    expect(code).toBe(1)
    expect(err).toContain("error: Usage")
  })
})

describe("the repository's versions", () => {
  test("every package, the generated manifests and the lockfile carry one valid version", async () => {
    const lock = Bun.JSONC.parse(await Bun.file(join(repository, LOCKFILE)).text()) as {
      workspaces: Record<string, { version?: string }>
    }
    const marketplace = await readJson<{ plugins: Versioned[] }>(".claude-plugin/marketplace.json")
    const plugin = await readJson<Versioned>(
      "packages/integrations/claude/.claude-plugin/plugin.json",
    )
    const versions = new Set<string | undefined>([
      ...(await Promise.all(
        VERSION_FILES.map(async (file) => (await readJson<Versioned>(file)).version),
      )),
      plugin.version,
      ...marketplace.plugins.map(({ version }) => version),
      ...Object.values(lock.workspaces).flatMap(({ version }) => (version ? [version] : [])),
    ])
    expect(versions.size).toBe(1)
    expect(() => Effect.runSync(parseVersion([...versions][0]!))).not.toThrow()
  })
})
