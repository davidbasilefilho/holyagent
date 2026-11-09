import { readFileSync } from "node:fs"
import { join } from "node:path"

import { Schema } from "effect"

/** The packages the setup interface runs on, which setup installs on first use. */
export const TUI_PACKAGE_NAMES = ["@opentui/core", "@opentui/solid", "solid-js"] as const

// Only the part of bun.lock this reads: `packages` maps a name to a list whose first entry is
// `name@version`. Bun owns the file and adds keys over time, so the other keys are ignored.
const Lock = Schema.Struct({
  packages: Schema.Record(
    Schema.String,
    Schema.TupleWithRest(Schema.Tuple([Schema.String]), [Schema.Unknown]),
  ),
})

/**
 * The exact version `bun.lock` resolves for each of {@link TUI_PACKAGE_NAMES}. It runs as a Bun
 * macro, so the build embeds the versions into the CLI bundle and a `mise run deps:update` that
 * moves the lock moves what setup installs, with no second pin table.
 */
export const lockedPackages = (): Record<string, string> => {
  const text = readFileSync(join(import.meta.dir, "../../../../../bun.lock"), "utf8")
  const lock = Schema.decodeUnknownSync(Lock, { onExcessProperty: "ignore" })(Bun.JSONC.parse(text))
  return Object.fromEntries(
    TUI_PACKAGE_NAMES.map((name) => {
      const [spec] = lock.packages[name] ?? []
      if (spec === undefined || !spec.startsWith(`${name}@`))
        throw new Error(`bun.lock has no resolved version of ${name}`)
      return [name, spec.slice(name.length + 1)]
    }),
  )
}
