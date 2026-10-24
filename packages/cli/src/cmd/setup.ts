import { Console, Effect, Path } from "effect"
import { Command, Flag } from "effect/cli"

import {
  applyDefaults,
  type Default,
  type Entry,
  readJsonObject,
  writeJsonObject,
} from "../json-file.ts"
import { type Report, show } from "../report.ts"

/** The marketplace and plugin the project settings point teammates at. */
export const MARKETPLACE = { name: "holyagent", repo: "davidbasilefilho/holyagent" } as const
/** The plugin id Claude Code uses, `plugin@marketplace`. */
export const PLUGIN_ID = `${MARKETPLACE.name}@${MARKETPLACE.name}`

/** Prompt cache lifetimes Claude Code accepts for `subagentPromptCacheTtl`. */
export const CACHE_TTLS = ["1h", "5m"] as const

/** The project settings `holyagent setup` makes sure exist. */
export const projectDefaults = (
  subagentCacheTtl: (typeof CACHE_TTLS)[number],
): ReadonlyArray<Default> => [
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
]

/** Where a project keeps its shared Claude Code settings. */
export const settingsPath = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    return path.join(path.resolve(directory), ".claude", "settings.json")
  })

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
 * Adds the missing project settings to `<directory>/.claude/settings.json`, creating the file when
 * needed. Existing keys and values are never changed, and the file is written only when something
 * was added (and not at all on a dry run).
 */
export const setup = Effect.fn("setup")(function* (options: {
  readonly directory: string
  readonly subagentCacheTtl: (typeof CACHE_TTLS)[number]
  readonly dryRun: boolean
}) {
  const file = yield* settingsPath(options.directory)
  const existing = yield* readJsonObject(file)
  const { merged, entries } = applyDefaults(existing, projectDefaults(options.subagentCacheTtl))
  const added = entries.filter((entry) => entry.status === "added").length
  if (added > 0 && !options.dryRun) yield* writeJsonObject(file, merged)
  const summary =
    added === 0
      ? "no changes"
      : options.dryRun
        ? `dry run: would add ${added}, nothing written`
        : `added ${added}`
  return { lines: [file, ...entries.map(describe), summary], ok: true } satisfies Report
})

/** The `holyagent setup` command. */
export const setupCommand = Command.make(
  "setup",
  {
    directory: Flag.Directory("dir", { mustExist: true }).pipe(
      Flag.withDescription("Project directory (default: the current directory)"),
      Flag.withDefault("."),
    ),
    subagentCacheTtl: Flag.Literals("subagent-cache-ttl", CACHE_TTLS).pipe(
      Flag.withDescription("Prompt cache lifetime for subagents (default: 1h)"),
      Flag.withDefault("1h"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Show what would change and write nothing"),
      Flag.withDefault(false),
    ),
  },
  (options) =>
    setup(options).pipe(Effect.flatMap((report) => Console.log(report.lines.join("\n")))),
)
  .pipe(
    Command.withDescription(
      [
        "Add HolyAgent's project settings to .claude/settings.json without changing anything already set.",
        "A plugin can only set `agent` and `subagentStatusLine`, so these project keys are this command's job:",
        "attribution (empty commit and PR text, no session URL), includeGitInstructions false (removes the",
        "built-in commit/PR instructions and the git status snapshot from context), subagentPromptCacheTtl,",
        "and the marketplace and plugin entries that offer the plugin to teammates.",
      ].join(" "),
    ),
  )
  .pipe(
    Command.withShortDescription(
      "Add HolyAgent's project settings to .claude/settings.json, keeping what is set",
    ),
  )
