import { readFileSync } from "node:fs"
import { join } from "node:path"

import { Schema } from "effect"

/** The packages the setup interface runs on, which setup installs on first use. */
export const TUI_PACKAGE_NAMES = ["@opentui/core", "@opentui/solid", "solid-js"] as const

/** The name of the package.json that setup writes beside the lockfile it installs from. */
export const TUI_MANIFEST_NAME = "holyagent-setup-tui"

const Dependencies = Schema.optional(Schema.Record(Schema.String, Schema.String))

// Only the parts of bun.lock this reads: `packages` maps a key to a list whose first entry is
// `name@version` and whose third is the package's own dependencies. Bun owns the file and adds
// keys over time, so the other keys are ignored.
const Entry = Schema.TupleWithRest(
  Schema.Tuple([
    Schema.String,
    Schema.String,
    Schema.Struct({
      dependencies: Dependencies,
      optionalDependencies: Dependencies,
      peerDependencies: Dependencies,
    }),
  ]),
  [Schema.Unknown],
)

const Lock = Schema.Struct({
  lockfileVersion: Schema.Number,
  configVersion: Schema.optional(Schema.Number),
  packages: Schema.Record(Schema.String, Schema.Unknown),
})

const readLock = () => {
  const text = readFileSync(join(import.meta.dir, "../../../../../bun.lock"), "utf8")
  return Schema.decodeUnknownSync(Lock, { onExcessProperty: "ignore" })(Bun.JSONC.parse(text))
}

const specOf = (packages: Readonly<Record<string, unknown>>, name: string): string => {
  const [spec] = Schema.decodeUnknownSync(Schema.Array(Schema.Unknown))(packages[name] ?? [])
  if (typeof spec !== "string" || !spec.startsWith(`${name}@`))
    throw new Error(`bun.lock has no resolved version of ${name}`)
  return spec.slice(name.length + 1)
}

/**
 * The exact version `bun.lock` resolves for each of {@link TUI_PACKAGE_NAMES}. It runs as a Bun
 * macro, so the build embeds the versions into the CLI bundle and a `mise run deps:update` that
 * moves the lock moves what setup installs, with no second pin table.
 */
export const lockedPackages = (): Record<string, string> => {
  const { packages } = readLock()
  return Object.fromEntries(TUI_PACKAGE_NAMES.map((name) => [name, specOf(packages, name)]))
}

// The names a lock key is nested under: "a/@b/c" is package c below b below a.
const namesOf = (key: string): ReadonlyArray<string> =>
  key.split("/").reduce<Array<string>>((names, part) => {
    const last = names.at(-1)
    return last !== undefined && last.startsWith("@") && !last.includes("/")
      ? [...names.slice(0, -1), `${last}/${part}`]
      : [...names, part]
  }, [])

// Where `dependency` of the package at `key` resolves: nested below it, below its parents, else
// at the top level.
const resolve = (
  packages: Readonly<Record<string, unknown>>,
  key: string,
  dependency: string,
): string | undefined => {
  const names = namesOf(key)
  for (let depth = names.length; depth >= 0; depth -= 1) {
    const candidate = [...names.slice(0, depth), dependency].join("/")
    if (candidate in packages) return candidate
  }
  return undefined
}

/**
 * The `bun.lock` for setup's own install of {@link TUI_PACKAGE_NAMES}: a workspace of the three
 * packages at their locked versions, and exactly the lock entries they reach (dependencies,
 * optional dependencies such as the native `@opentui/core-<platform>` and peers), with the
 * resolutions and integrity hashes of the repository's lock. Installed with `--frozen-lockfile`, it
 * puts the same tree on the user's machine that the bundle was built against. It runs as a Bun
 * macro, so the build embeds the text.
 */
export const lockedFile = (): string => {
  const lock = readLock()
  const wanted = lockedPackages()
  const reached = new Set<string>()
  const visit = (key: string) => {
    if (reached.has(key)) return
    reached.add(key)
    const [, , info] = Schema.decodeUnknownSync(Entry, { onExcessProperty: "ignore" })(
      lock.packages[key],
    )
    for (const group of [info.dependencies, info.optionalDependencies, info.peerDependencies])
      for (const name of Object.keys(group ?? {})) {
        const found = resolve(lock.packages, key, name)
        if (found !== undefined) visit(found)
      }
  }
  for (const name of TUI_PACKAGE_NAMES) visit(name)
  return `${JSON.stringify(
    {
      lockfileVersion: lock.lockfileVersion,
      ...(lock.configVersion === undefined ? {} : { configVersion: lock.configVersion }),
      workspaces: { "": { name: TUI_MANIFEST_NAME, dependencies: wanted } },
      packages: Object.fromEntries(
        Object.entries(lock.packages).filter(([key]) => reached.has(key)),
      ),
    },
    undefined,
    2,
  )}\n`
}
