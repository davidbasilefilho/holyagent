import { Effect } from "effect"

import { type Env, userFiles } from "./environment.ts"
import {
  applyDefaults,
  type Default,
  type Entry,
  readJsonObject,
  writeJsonObject,
} from "./json-file.ts"
import { show } from "./report.ts"

/** The marketplace and plugin the user settings point Claude Code at. */
export const MARKETPLACE = { name: "holyagent", repo: "davidbasilefilho/holyagent" } as const
/** The plugin id Claude Code uses, `plugin@marketplace`. */
export const PLUGIN_ID = `${MARKETPLACE.name}@${MARKETPLACE.name}`

/** Prompt cache lifetimes Claude Code accepts for `subagentPromptCacheTtl`. */
export const CACHE_TTLS = ["1h", "5m"] as const

/** A prompt cache lifetime of {@link CACHE_TTLS}. */
export type CacheTtl = (typeof CACHE_TTLS)[number]

/** The user settings `holyagent setup` makes sure exist: the keys a plugin cannot set itself. */
export const userSettingsDefaults = (subagentCacheTtl: CacheTtl): ReadonlyArray<Default> => [
  { path: ["attribution", "commit"], value: "" },
  { path: ["attribution", "pr"], value: "" },
  { path: ["attribution", "sessionUrl"], value: false },
  { path: ["includeGitInstructions"], value: false },
  { path: ["subagentPromptCacheTtl"], value: subagentCacheTtl },
  {
    path: ["extraKnownMarketplaces", MARKETPLACE.name],
    value: { source: { source: "github", repo: MARKETPLACE.repo } },
  },
  { path: ["enabledPlugins", PLUGIN_ID], value: true },
  { path: ["permissions", "deny"], value: ["WebSearch", "WebFetch"] },
]

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
 * Adds the missing keys to the user settings file (see `userFiles`), creating it when needed.
 * Existing keys and values are never changed, and the file is written only when something was added
 * (and not at all on a dry run). Returns the report lines: the file, one line per key and a
 * summary. Fails with SetupFailure when the file cannot be read as a JSON object or written.
 */
export const mergeUserSettings = Effect.fn("mergeUserSettings")(function* (
  env: Env,
  options: { readonly subagentCacheTtl: CacheTtl; readonly dryRun: boolean },
) {
  const file = userFiles(env).settings
  const existing = yield* readJsonObject(file)
  const { merged, entries } = applyDefaults(
    existing,
    userSettingsDefaults(options.subagentCacheTtl),
  )
  const added = entries.filter((entry) => entry.status === "added").length
  if (added > 0 && !options.dryRun) yield* writeJsonObject(file, merged)
  const summary =
    added === 0
      ? "no changes"
      : options.dryRun
        ? `dry run: would add ${added}, nothing written`
        : `added ${added}`
  return [file, ...entries.map(describe), summary] as ReadonlyArray<string>
})

/**
 * The key paths the user settings lack, without writing anything. Fails with SetupFailure when the
 * file cannot be read as a JSON object.
 */
export const missingSettingKeys = Effect.fn("missingSettingKeys")(function* (env: Env) {
  const existing = yield* readJsonObject(userFiles(env).settings)
  return applyDefaults(existing, userSettingsDefaults("1h"))
    .entries.filter((entry) => entry.status === "added")
    .map((entry) => entry.path)
})
