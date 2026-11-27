import { posix, win32 } from "node:path"

import { Effect, Option, Schema } from "effect"

import { type Env, homeDirectory } from "./environment.ts"
import { Shell } from "./shell.ts"

const Installed = Schema.Struct({
  version: Schema.String,
  install_path: Schema.String,
  installed: Schema.Boolean,
  active: Schema.Boolean,
  requested_version: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  sources: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.String))),
  symlinked_to: Schema.optional(Schema.String),
  broken: Schema.optional(Schema.Boolean),
  scheduled_for_pruning: Schema.optional(Schema.Boolean),
  prune_after: Schema.optional(Schema.String),
})
const Inventory = Schema.fromJsonString(Schema.Array(Installed))
const Bins = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ name: Schema.String, path: Schema.String, symlink: Schema.Boolean }),
  ),
)

const tool = "npm:ctx7"
const discoveryOptions = {
  MISE_OFFLINE: "1",
  MISE_AUTO_INSTALL: "0",
  MISE_NOT_FOUND_AUTO_INSTALL: "0",
} as const
const versionNumber = /^\d+\.\d+\.\d+(?:[-+][\dA-Za-z.-]+)*$/
const controls = /\p{Cc}/u

type Lookup =
  | { readonly kind: "path" | "bun" | "mise"; readonly path: string }
  | { readonly kind: "missing" | "unverified" }

/** Locate an existing Context7 CLI without running it or activating a shell. */
export const lookupCtx7 = Effect.fn("lookupCtx7")(function* (
  env: Env,
  cwd = process.cwd(),
  platform = process.platform,
): Effect.fn.Return<Lookup, never, Shell> {
  const shell = yield* Shell
  const onPath = yield* shell.which("ctx7")
  if (Option.isSome(onPath)) return { kind: "path", path: onPath.value }
  const inBun = yield* shell.which("ctx7", { includeBunBin: true })
  if (Option.isSome(inBun)) return { kind: "bun", path: inBun.value }

  // Only a trusted installed mise executable, in the user's home with no mise config loaded.
  const mise = yield* shell.which("mise", { strict: { cwd, platform } })
  if (Option.isNone(mise))
    return { kind: Option.isSome(yield* shell.which("mise")) ? "unverified" : "missing" }
  const options = { cwd: homeDirectory(env), env: discoveryOptions }
  const inventory = yield* shell.run(
    mise.value,
    ["--no-config", "ls", "--installed", "--json", tool],
    options,
  )
  const records = Schema.decodeUnknownOption(Inventory)(inventory.stdout, {
    onExcessProperty: "error",
  })
  if (inventory.exitCode !== 0 || Option.isNone(records)) return { kind: "unverified" }
  if (records.value.length === 0)
    return { kind: inventory.stderr.trim() === "" ? "missing" : "unverified" }

  const api = platform === "win32" ? win32 : posix
  const absolute = (path: string) =>
    api.isAbsolute(path) &&
    !controls.test(path) &&
    (platform !== "win32" || /^(?:[a-z]:[\\/]|\\\\[^?.])/i.test(path))
  const installed = records.value.filter(
    (record) =>
      record.installed &&
      !record.broken &&
      versionNumber.test(record.version) &&
      absolute(record.install_path),
  )
  for (const record of installed.toReversed()) {
    const reported = yield* shell.run(
      mise.value,
      ["--no-config", "bin-paths", "--json", `${tool}@${record.version}`],
      options,
    )
    const bins = Schema.decodeUnknownOption(Bins)(reported.stdout, { onExcessProperty: "error" })
    if (reported.exitCode !== 0 || Option.isNone(bins)) continue
    for (const bin of bins.value) {
      if (!absolute(bin.path)) continue
      const name = api.basename(bin.path)
      if (platform === "win32" ? !/^ctx7(?:\.(?:exe|cmd|bat))?$/i.test(name) : name !== "ctx7")
        continue
      const relative = api.relative(record.install_path, bin.path)
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${api.sep}`) ||
        api.isAbsolute(relative)
      )
        continue
      const found = yield* shell.which("ctx7", { directory: api.dirname(bin.path) })
      if (Option.isSome(found) && api.relative(bin.path, found.value) === "")
        return { kind: "mise", path: found.value }
    }
  }
  return { kind: "unverified" }
})

/** Explain why setup did not install a duplicate when the mise lookup could not be verified. */
export const CTX7_MISE_UNVERIFIED =
  "could not verify mise's npm:ctx7 installation; make an existing ctx7 available on PATH or check mise"
