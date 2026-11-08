import { Effect, Equal } from "effect"

import { type Env } from "./environment.ts"
import {
  applyDefaults,
  type Default,
  type Entry,
  isJsonObject,
  type JsonObject,
  readJsonObject,
  writeJsonObject,
} from "./json-file.ts"
import { addRecorded, clearRecorded, readRecorded, type Recorded } from "./record.ts"
import { show } from "./report.ts"

/** The marketplace and plugin the user settings point Claude Code at. */
export const MARKETPLACE = { name: "holyagent", repo: "davidbasilefilho/holyagent" } as const
/** The plugin id Claude Code uses, `plugin@marketplace`. */
export const PLUGIN_ID = `${MARKETPLACE.name}@${MARKETPLACE.name}`

/** Prompt cache lifetimes Claude Code accepts for `subagentPromptCacheTtl`. */
export const CACHE_TTLS = ["1h", "5m"] as const

/** A prompt cache lifetime of {@link CACHE_TTLS}. */
export type CacheTtl = (typeof CACHE_TTLS)[number]

/**
 * The canonical name Claude Code keys the Opus 5.5 entry of `modelSettings` by, the model the
 * root's `opus` alias resolves to today. The key follows the model, so it changes when the alias
 * moves (docs/usage.md, "The root's effort and window").
 */
export const ROOT_MODEL = "claude-opus-5-5"

/**
 * The user settings `holyagent setup` makes sure exist: the keys a plugin cannot set itself. The
 * root's effort and compaction window are per-model entries, since a top-level `effortLevel` does
 * not apply to Opus 5.5 and a plugin's own settings honor neither.
 */
export const userSettingsDefaults = (subagentCacheTtl: CacheTtl): ReadonlyArray<Default> => [
  { path: ["attribution", "commit"], value: "" },
  { path: ["attribution", "pr"], value: "" },
  { path: ["attribution", "sessionUrl"], value: false },
  { path: ["includeGitInstructions"], value: false },
  { path: ["subagentPromptCacheTtl"], value: subagentCacheTtl },
  { path: ["modelSettings", ROOT_MODEL, "effortLevel"], value: "high" },
  { path: ["modelSettings", ROOT_MODEL, "autoCompactWindow"], value: 450000 },
  {
    path: ["extraKnownMarketplaces", MARKETPLACE.name],
    value: { source: { source: "github", repo: MARKETPLACE.repo } },
  },
  { path: ["enabledPlugins", PLUGIN_ID], value: true },
  { path: ["permissions", "deny"], value: ["WebSearch", "WebFetch"] },
]

/**
 * The defaults to merge into `existing`. `/effort auto` clears the saved level by removing
 * `effortLevel` from the model's entry and leaves the entry, so an Opus 5.5 entry that exists
 * without `effortLevel` is the user's choice of the model default, and the level is not re-added.
 */
const defaultsFor = (existing: JsonObject, subagentCacheTtl: CacheTtl): ReadonlyArray<Default> => {
  const models = existing["modelSettings"]
  const entry = isJsonObject(models) ? models[ROOT_MODEL] : undefined
  const cleared = isJsonObject(entry) && !("effortLevel" in entry)
  return userSettingsDefaults(subagentCacheTtl).filter(
    ({ path }) => !(cleared && path[2] === "effortLevel"),
  )
}

const describe = ({ path, status, value, wanted }: Entry): string => {
  switch (status) {
    case "added":
      return `+ ${path}: added ${show(value)}`
    case "present":
      return `= ${path}: already ${show(value)}`
    case "kept":
      return `~ ${path}: kept ${show(value)} (recommended ${show(wanted)})`
  }
}

/**
 * Adds the missing keys to the settings file `file` (the user, project or local settings, see
 * `settingsFile`), creating it when needed. Existing keys and values are never changed, and the
 * file is written only when something was added (and not at all on a dry run). The keys it added
 * are recorded outside the project (see `recordPath`), which is what `--undo` removes. Returns the
 * report lines: the file, one line per key and a summary. Fails with SetupFailure when the file or
 * the record cannot be read or written; a record that cannot be read fails before anything is
 * written.
 */
export const mergeUserSettings = Effect.fn("mergeUserSettings")(function* (options: {
  readonly env: Env
  readonly file: string
  readonly subagentCacheTtl: CacheTtl
  readonly dryRun: boolean
}) {
  const { file, env } = options
  const existing = yield* readJsonObject(file)
  const defaults = defaultsFor(existing, options.subagentCacheTtl)
  const { merged, entries } = applyDefaults(existing, defaults)
  const names = new Set(
    entries.filter((entry) => entry.status === "added").map((entry) => entry.path),
  )
  const added = names.size
  if (added > 0 && !options.dryRun) {
    // Read the record first, so one that cannot be decoded stops the run before the settings change.
    yield* readRecorded(env, file)
    yield* writeJsonObject(file, merged)
    yield* addRecorded(
      env,
      file,
      defaults.filter(({ path }) => names.has(path.join("."))),
    )
  }
  const summary =
    added === 0
      ? "no changes"
      : options.dryRun
        ? `dry run: would add ${added}, nothing written`
        : `added ${added}`
  return [file, ...entries.map(describe), summary] as ReadonlyArray<string>
})

/** One planned removal: `removed` when setup's value is there, `absent` when nothing of it is. */
export interface Removal {
  readonly path: string
  readonly status: "removed" | "absent" | "kept" | "unrecorded"
  /** What was taken out, or the existing value for `kept` and `unrecorded`. */
  readonly value: unknown
  readonly wanted: unknown
}

const without = (node: JsonObject, key: string): JsonObject =>
  Object.fromEntries(Object.entries(node).filter(([name]) => name !== key))

/** The value at `path`, or undefined when a level is missing or not an object. */
const valueAt = (node: JsonObject, path: readonly string[]): unknown => {
  let current: unknown = node
  for (const key of path) {
    if (!isJsonObject(current)) return undefined
    current = current[key]
  }
  return current
}

/**
 * Takes setup's value for `path` out of `node`. A scalar or object is removed only when equal to
 * `wanted`. A list is cut by the entries `wanted` names, so the user's own entries stay. A parent
 * object that the removal leaves empty is dropped too.
 */
export const take = (
  node: JsonObject,
  path: readonly [string, ...Array<string>],
  depth: number,
  wanted: unknown,
): readonly [JsonObject, Removal] => {
  const key = path[depth] as string
  const full = path.join(".")
  const current = node[key]
  const absent = { path: full, status: "absent", value: undefined, wanted } satisfies Removal
  if (current === undefined) return [node, absent]
  if (depth < path.length - 1) {
    // A scalar or list where setup needs an object means setup wrote nothing here.
    if (!isJsonObject(current)) return [node, absent]
    const [child, removal] = take(current, path, depth + 1, wanted)
    if (removal.status !== "removed") return [node, removal]
    return [
      Object.keys(child).length === 0 ? without(node, key) : { ...node, [key]: child },
      removal,
    ]
  }
  if (Array.isArray(wanted)) {
    if (!Array.isArray(current)) return [node, { ...absent, status: "kept", value: current }]
    const named = (item: unknown) => wanted.some((entry) => Equal.equals(item, entry))
    const gone = current.filter(named)
    if (gone.length === 0) return [node, absent]
    const left = current.filter((item) => !named(item))
    return [
      left.length === 0 ? without(node, key) : { ...node, [key]: left },
      { path: full, status: "removed", value: gone, wanted },
    ]
  }
  if (!Equal.equals(current, wanted)) return [node, { ...absent, status: "kept", value: current }]
  return [without(node, key), { path: full, status: "removed", value: current, wanted }]
}

const describeRemoval = ({ path, status, value, wanted }: Removal): string => {
  switch (status) {
    case "removed":
      return `- ${path}: removed ${show(value)}`
    case "absent":
      return `= ${path}: nothing to remove`
    case "kept":
      return `~ ${path}: kept ${show(value)} (setup writes ${show(wanted)})`
    case "unrecorded":
      return `~ ${path}: kept ${show(value)} (setup did not record adding it; remove it by hand if you want it gone)`
  }
}

/**
 * Backs out what {@link mergeUserSettings} recorded for the settings file `file`. A recorded key is
 * removed only while its value still equals what setup wrote (from a list such as
 * `permissions.deny`, only the entries setup added), so a changed value stays and is reported as
 * kept. A key that setup has no record of adding, such as one that was there before setup or was
 * added by an earlier version, stays and is reported with a hint. A parent object left empty is
 * dropped. The file is rewritten only when something was removed (and not on a dry run), a missing
 * file is not created, and the record of the file is cleared after a real run. Returns the report
 * lines: the file, one line per key and a summary. Fails with SetupFailure when the file or the
 * record cannot be read as JSON or written.
 */
export const undoUserSettings = Effect.fn("undoUserSettings")(function* (options: {
  readonly env: Env
  readonly file: string
  readonly dryRun: boolean
}) {
  const { file, env } = options
  let result = yield* readJsonObject(file)
  const recorded = yield* readRecorded(env, file)
  const plan: ReadonlyArray<Recorded> = [
    ...recorded,
    ...userSettingsDefaults("1h")
      .filter(({ path }) => !recorded.some((item) => item.path.join(".") === path.join(".")))
      .map(({ path }) => ({ path, value: undefined })),
  ]
  const removals: Array<Removal> = []
  for (const { path, value } of plan) {
    if (value === undefined) {
      const existing = valueAt(result, path)
      removals.push(
        existing === undefined
          ? { path: path.join("."), status: "absent", value: undefined, wanted: undefined }
          : { path: path.join("."), status: "unrecorded", value: existing, wanted: undefined },
      )
      continue
    }
    const [next, removal] = take(result, path, 0, value)
    result = next
    removals.push(removal)
  }
  const removed = removals.filter((removal) => removal.status === "removed").length
  if (!options.dryRun) {
    if (removed > 0) yield* writeJsonObject(file, result)
    yield* clearRecorded(env, file)
  }
  const summary =
    removed === 0
      ? "no changes"
      : options.dryRun
        ? `dry run: would remove ${removed}, nothing written`
        : `removed ${removed}`
  return [file, ...removals.map(describeRemoval), summary] as ReadonlyArray<string>
})

/**
 * The key paths the settings file `file` lacks, without writing anything. Fails with SetupFailure
 * when the file cannot be read as a JSON object.
 */
export const missingSettingKeys = Effect.fn("missingSettingKeys")(function* (file: string) {
  const existing = yield* readJsonObject(file)
  return applyDefaults(existing, defaultsFor(existing, "1h"))
    .entries.filter((entry) => entry.status === "added")
    .map((entry) => entry.path)
})
