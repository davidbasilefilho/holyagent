import { describe, expect, test } from "bun:test"
import { join } from "node:path"

import { Effect, Schema } from "effect"

import { DEPENDENCY_FIELDS } from "./dependency-pins.ts"
import { manifestFiles } from "./update-dependencies.ts"

const repository = join(import.meta.dir, "..")

/** A caret range at its line boundary: `^X.0.0` for X >= 1, `^0.X.0`, or `^0.0.X`. */
const BOUNDARY_RANGE = /^\^(?:[1-9]\d*\.0\.0|0\.[1-9]\d*\.0|0\.0\.\d+)$/

const Manifest = Schema.Record(Schema.String, Schema.Unknown)

interface Use {
  readonly field: string
  readonly name: string
  readonly range: unknown
}

/** Every version specifier below the dependency fields, including nested override tables. */
const uses = (manifest: Record<string, unknown>): Array<Use> =>
  DEPENDENCY_FIELDS.flatMap((field) => {
    const walk = (value: unknown, path: string): Array<Use> =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value).flatMap(([name, inner]) => walk(inner, name))
        : [{ field, name: path, range: value }]
    const table = manifest[field]
    return table === undefined ? [] : walk(table, field)
  })

/**
 * What breaks the rule in a manifest: any specifier that is not a boundary caret range, and a
 * `workspace:*` that does not name a workspace package.
 */
const problems = (
  file: string,
  manifest: Record<string, unknown>,
  workspaces: ReadonlySet<string>,
): Array<string> =>
  uses(manifest).flatMap(({ field, name, range }) => {
    const ok =
      typeof range === "string" &&
      (BOUNDARY_RANGE.test(range) || (range === "workspace:*" && workspaces.has(name)))
    return ok ? [] : [`${file} ${field} ${name}: ${JSON.stringify(range)}`]
  })

const loadManifests = async () => {
  const files = await Effect.runPromise(manifestFiles(repository))
  return Promise.all(
    files.map(async (file) => ({
      file,
      manifest: Effect.runSync(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))(
          await Bun.file(join(repository, file)).text(),
        ),
      ),
    })),
  )
}

describe("the rule", () => {
  const workspaces = new Set(["@holyagent/runtime"])

  test.each(["^1.0.0", "^4.0.0", "^2026.0.0", "^0.5.0", "^0.0.7"])("%s is allowed", (range) => {
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
    "^1.0.0-rc.1",
    "^1",
    "npm:x@^1.0.0",
    "workspace:^",
  ])("%s is refused", (range) => {
    expect(problems("f", { dependencies: { x: range } }, workspaces)).toHaveLength(1)
  })

  test("workspace:* is for workspace packages only", () => {
    expect(
      problems("f", { dependencies: { "@holyagent/runtime": "workspace:*" } }, workspaces),
    ).toEqual([])
    expect(problems("f", { dependencies: { other: "workspace:*" } }, workspaces)).toHaveLength(1)
  })

  test.each(DEPENDENCY_FIELDS)("a bad range in %s is found", (field) => {
    expect(problems("f", { [field]: { x: "1.2.3" } }, workspaces)).toHaveLength(1)
  })

  test("a bad range in a nested override is found", () => {
    expect(problems("f", { overrides: { x: { y: "1.2.3" } } }, workspaces)).toHaveLength(1)
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
    expect(manifests.flatMap(({ file, manifest }) => problems(file, manifest, workspaces))).toEqual(
      [],
    )
  })
})
