import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"

import { Effect, Schema } from "effect"

import {
  DEPENDENCY_FIELDS,
  EXACT_PACKAGES,
  isExactPin,
  isPiHostPeer,
  PI_HOST_PACKAGES,
} from "./dependency-pins.ts"
import { manifestFiles } from "./update-dependencies.ts"

const repository = join(import.meta.dir, "..")

/** A caret range at its line boundary: `^X.0.0` for X >= 1, `^0.X.0`, or `^0.0.X`. */
const BOUNDARY_RANGE = /^\^(?:[1-9]\d*\.0\.0|0\.[1-9]\d*\.0|0\.0\.\d+)$/

const PRERELEASE_RANGE = /^(?:[0-9A-Za-z-]+\.)*[0-9A-Za-z-]+$/
const PROTOCOL = /^(?:file:|link:|git[+:]|github:|https?:|catalog:|\$)/

const Manifest = Schema.Record(Schema.String, Schema.Unknown)

interface Use {
  readonly field: string
  readonly name: string
  readonly range: unknown
}

/** Every version specifier below the dependency fields, including nested override tables. */
const uses = (manifest: Record<string, unknown>): Array<Use> => {
  const walk = (field: string, value: unknown, name: string): Array<Use> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value).flatMap(([key, inner]) => walk(field, inner, key))
      : [{ field, name, range: value }]
  const fields = (table: Record<string, unknown>, names: ReadonlyArray<string>) =>
    names.flatMap((field) => (table[field] === undefined ? [] : walk(field, table[field], field)))
  const workspaces = manifest["workspaces"]
  const catalogFields = ["catalog", "catalogs"]
  return [
    ...fields(manifest, [...DEPENDENCY_FIELDS, ...catalogFields]),
    ...(workspaces !== null && typeof workspaces === "object" && !Array.isArray(workspaces)
      ? fields(workspaces as Record<string, unknown>, catalogFields)
      : []),
  ]
}

/** Whether a specifier uses the preferred semver form, including npm aliases and unions. */
const boundary = (specifier: string): boolean => {
  const alias = specifier.startsWith("npm:") ? specifier.slice(4) : undefined
  const at = alias?.lastIndexOf("@") ?? -1
  const range = alias === undefined ? specifier : at > 0 ? alias.slice(at + 1) : ""
  return range.split("||").every((side) => {
    const [base, ...suffix] = side.trim().split("-")
    return (
      BOUNDARY_RANGE.test(base ?? "") &&
      (suffix.length === 0 || PRERELEASE_RANGE.test(suffix.join("-")))
    )
  })
}

/**
 * A narrow tilde is allowed only when an installed dependency's peer contract imposes the same
 * lower bound and rejects the next minor. Check the boundaries with the package manager's semver.
 */
const peerNarrows = (specifier: string, requirements: ReadonlyArray<string>): boolean => {
  const [, x, y, z] = /^~(\d+)\.(\d+)\.(\d+)$/.exec(specifier) ?? []
  if (x === undefined || y === undefined || z === undefined) return false
  const [major, minor, patch] = [Number(x), Number(y), Number(z)]
  if (major === 0 && minor === 0) return false
  const below =
    patch > 0
      ? `${major}.${minor}.${patch - 1}`
      : minor > 0
        ? `${major}.${minor - 1}.999999`
        : `${major - 1}.999999.999999`
  const floor = major > 0 ? `${major}.0.0` : `0.${minor}.0`
  const lastPatch = `${major}.${minor}.999999`
  const nextMinor = `${major}.${minor + 1}.0`
  return requirements.some((required) => {
    const satisfies = (version: string) => Bun.semver.satisfies(version, required)
    return (
      satisfies(`${x}.${y}.${z}`) &&
      satisfies(lastPatch) &&
      !satisfies(below) &&
      !satisfies(nextMinor) &&
      (major > 0 || !satisfies(floor))
    )
  })
}

/** Find range violations without rewriting workspace, Pi host or other protocol contracts. */
const problems = (
  file: string,
  manifest: Record<string, unknown>,
  workspaces: ReadonlySet<string>,
  peers: ReadonlyMap<string, ReadonlyArray<string>> = new Map(),
): Array<string> =>
  uses(manifest).flatMap(({ field, name, range }) => {
    const ok = EXACT_PACKAGES.includes(name)
      ? isExactPin(name, range)
      : typeof range === "string" &&
        ((DEPENDENCY_FIELDS.slice(0, 4).includes(field) && workspaces.has(name)
          ? range === "workspace:*"
          : boundary(range) || PROTOCOL.test(range) || peerNarrows(range, peers.get(name) ?? [])) ||
          isPiHostPeer(field, name, range))
    return ok ? [] : [`${file} ${field} ${name}: ${JSON.stringify(range)}`]
  })

const loadManifests = async () => {
  const workspaces = await Effect.runPromise(manifestFiles(repository))
  const files = new Set(workspaces)
  // Integration builders write publishable manifests beneath each workspace's dist directory.
  // They are validated, but only their source workspace manifest is updated by deps:update.
  for (const file of workspaces) {
    if (file === "package.json") continue
    const generated = join(dirname(file), "dist/package.json")
    if (await Bun.file(join(repository, generated)).exists()) files.add(generated)
  }
  return Promise.all(
    [...files].map(async (file) => ({
      file,
      manifest: Effect.runSync(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
          await Bun.file(join(repository, file)).text(),
        ),
      ),
    })),
  )
}

const installedPeers = async (file: string, manifest: Record<string, unknown>) => {
  const requirements = new Map<string, string[]>()
  const direct = ["dependencies", "devDependencies", "optionalDependencies"]
  const names = new Set(
    uses(manifest)
      .filter(({ field }) => direct.includes(field))
      .map(({ name }) => name),
  )
  for (const name of names) {
    const local = Bun.file(join(repository, dirname(file), "node_modules", name, "package.json"))
    const candidate = (await local.exists())
      ? local
      : Bun.file(join(repository, "node_modules", name, "package.json"))
    if (!(await candidate.exists())) continue
    const dependency = Effect.runSync(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(await candidate.text()),
    )
    for (const { field, name: peer, range } of uses(dependency)) {
      if (field !== "peerDependencies" || typeof range !== "string") continue
      requirements.set(peer, [...(requirements.get(peer) ?? []), range])
    }
  }
  return requirements
}

describe("the rule", () => {
  const workspaces = new Set(["@holyagent/runtime"])

  test.each([
    "^1.0.0",
    "^4.0.0",
    "^2026.0.0",
    "^0.5.0",
    "^0.0.7",
    "^0.21.0-ts7.1.0-beta",
    "npm:x@^1.0.0",
    "^1.0.0 || ^2.0.0",
    "catalog:",
    "catalog:node",
  ])("%s is allowed", (range) => {
    expect(problems("f", { dependencies: { x: range } }, workspaces)).toEqual([])
  })

  test.each([
    "1.2.3",
    "^1.2.3",
    "^1.0.1",
    "^0.5.2",
    "~1.0.0",
    ">=1.0.0",
    "*",
    "latest",
    "^1.1.0-rc.1",
    "^1",
    "npm:x@^1.1.0",
    "workspace:^",
  ])("%s is refused", (range) => {
    expect(problems("f", { dependencies: { x: range } }, workspaces)).toHaveLength(1)
  })

  test("allows a tilde only when an installed dependency narrows the peer range", () => {
    const manifest = { dependencies: { x: "~1.7.16" } }
    expect(problems("f", manifest, workspaces, new Map([["x", [">=1.7.16 <1.8.0"]]]))).toEqual([])
    expect(problems("f", manifest, workspaces, new Map([["x", [">=1.7.15 <1.8.0"]]]))).toHaveLength(
      1,
    )
    expect(problems("f", manifest, workspaces, new Map([["x", [">=1.7.16 <2.0.0"]]]))).toHaveLength(
      1,
    )
  })
  test("workspace:* is for workspace packages only", () => {
    expect(
      problems("f", { dependencies: { "@holyagent/runtime": "workspace:*" } }, workspaces),
    ).toEqual([])
    expect(problems("f", { dependencies: { other: "workspace:*" } }, workspaces)).toHaveLength(1)
    expect(
      problems("f", { dependencies: { "@holyagent/runtime": "^1.0.0" } }, workspaces),
    ).toHaveLength(1)
  })

  test.each(DEPENDENCY_FIELDS)("a bad range in %s is found", (field) => {
    expect(problems("f", { [field]: { x: "1.2.3" } }, workspaces)).toHaveLength(1)
  })

  test("a Pi host package may be a peer with the range *, and nothing else may", () => {
    for (const name of PI_HOST_PACKAGES)
      expect(problems("f", { peerDependencies: { [name]: "*" } }, workspaces)).toEqual([])
    expect(problems("f", { peerDependencies: { other: "*" } }, workspaces)).toHaveLength(1)
    expect(problems("f", { dependencies: { typebox: "*" } }, workspaces)).toHaveLength(1)
    expect(problems("f", { devDependencies: { typebox: "*" } }, workspaces)).toHaveLength(1)
    expect(problems("f", { peerDependencies: { typebox: ">=1.0.0" } }, workspaces)).toHaveLength(1)
  })

  test("an exact version is refused everywhere, just-bash included", () => {
    expect(problems("f", { dependencies: { "just-bash": "3.6.1" } }, workspaces)).toHaveLength(1)
    expect(problems("f", { dependencies: { "just-bash": "^3.0.0" } }, workspaces)).toEqual([])
    expect(problems("f", { dependencies: { "just-bash": "3.6.0-rc.1" } }, workspaces)).toHaveLength(
      1,
    )
  })

  test("checks default and named catalog values at the root or under workspaces", () => {
    expect(
      problems(
        "f",
        {
          catalog: { x: "^1.2.0" },
          catalogs: { node: { y: "^2.0.0" } },
          workspaces: {
            packages: ["packages/*"],
            catalog: { z: "1.0.0" },
            catalogs: { tools: { w: "^0.5.4" } },
          },
        },
        workspaces,
      ),
    ).toHaveLength(3)
  })

  test("a bad range in a nested override is found", () => {
    expect(problems("f", { overrides: { x: { y: "1.2.3" } } }, workspaces)).toHaveLength(1)
  })
})

describe("the runtime manifest", () => {
  test("holds no exact dependency range, so an exact just-bash pin fails here", async () => {
    const text = await Bun.file(join(repository, "packages/runtime/package.json")).text()
    const manifest = Effect.runSync(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(text),
    )
    expect(
      problems(
        "packages/runtime/package.json",
        manifest,
        new Set(["@holyagent/runtime", "@holyagent/core"]),
      ),
    ).toEqual([])
  })
})

describe("every package.json of the repository", () => {
  test("holds only boundary caret ranges, or workspace:* for workspace packages", async () => {
    const manifests = await loadManifests()
    expect(manifests.length).toBeGreaterThanOrEqual(3)
    const workspaces = new Set(
      manifests.flatMap(({ manifest }) =>
        typeof manifest["name"] === "string" ? [manifest["name"]] : [],
      ),
    )
    const violations = await Promise.all(
      manifests.map(async ({ file, manifest }) =>
        problems(file, manifest, workspaces, await installedPeers(file, manifest)),
      ),
    )
    expect(violations.flat()).toEqual([])
  })
})
