import { Effect, FileSystem, Option, Path } from "effect"

import {
  isJsonObject,
  type JsonObject,
  readJsonObjectSnapshot,
  writeJsonObjectIfUnchanged,
} from "../json-file.ts"
import { Shell } from "../shell.ts"

/** Where the current user's Claude Code files live, as far as the leftovers scan needs them. */
export interface ClaudeFiles {
  /** The Claude Code configuration directory (`~/.claude` or `CLAUDE_CONFIG_DIR`). */
  readonly claudeDir: string
  /** The `.claude.json` file that holds the user's MCP servers. */
  readonly claudeJson: string
}

/** The Billion Context plugin and the marketplace it came from. */
const BILI_PLUGIN = "billion-context@billion-context"
const BILI_MARKETPLACE = "billion-context"

/**
 * The text of `commands/acp-cache.md` as Billion Context writes it. Its remove deletes the file
 * only when the text equals this one (ignoring trailing whitespace), and so does this cleanup.
 */
const ACP_CACHE_COMMAND = [
  "---",
  "description: billion-context prompt-cache reconciliation report (same as the acp_cache tool)",
  "---",
  'Run the `acp_cache` tool provided by the `bili` MCP server now. If the arguments below contain the word "full", call it with detail:"full"; otherwise call it with no arguments. Then paste the tool\'s complete output verbatim in a fenced code block \u2014 do not summarize, translate, reorder, or omit anything. If the tool is unavailable, reply exactly: bili: acp_cache tool not available (is the bili MCP server registered?)',
  "",
  "Arguments: $ARGUMENTS",
].join("\n")

/** Billion Context's own test for its `SessionStart` hook command. */
const HOOK_COMMAND = /claude-native-bootstrap\.(?:js|mjs|ts)["']?$/
/** The marker the report line names for a hook it removes. */
const HOOK_MARKER = "claude-native-bootstrap"
/** Billion Context's own test for the base URLs its proxy mode sets (any port). */
const PROXY_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/bili\/(?:[a-z][a-z0-9-]*\/)?https?:\/\//
/** The proxy base URL variables Billion Context sets in `settings.json` `env`. */
const BASE_URL_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_VERTEX_BASE_URL"]
/** Billion Context's own test for the program and the script of its MCP server entry. */
const MCP_PROGRAM = /^(?:.*[\\/])?node(?:\.exe|\.cmd)?$/
const MCP_SCRIPT = /dist[\\/](?:claude-mcp-entry|mcp)\.(?:js|mjs)$/
/** Where Billion Context keeps `settings.json` as it was before its install. */
const SETTINGS_BACKUP = "settings.json.bili-bak"

/**
 * What a hook handler matched, for the report line, or `undefined` when it is not Billion
 * Context's.
 */
const hookMatch = (handler: unknown): string | undefined =>
  isJsonObject(handler) &&
  typeof handler["command"] === "string" &&
  HOOK_COMMAND.test(handler["command"])
    ? HOOK_MARKER
    : undefined

/**
 * Whether an MCP server entry is the one Billion Context registers: `node` running its entry
 * script.
 */
const isBiliServer = (server: unknown): boolean =>
  isJsonObject(server) &&
  typeof server["command"] === "string" &&
  MCP_PROGRAM.test(server["command"]) &&
  Array.isArray(server["args"]) &&
  server["args"].some((arg) => typeof arg === "string" && MCP_SCRIPT.test(arg))

const without = (object: JsonObject, key: string): JsonObject =>
  Object.fromEntries(Object.entries(object).filter(([name]) => name !== key))

/** A JSON file with the Billion Context entries taken out, and a line for each entry removed. */
interface Plan {
  readonly merged: JsonObject
  readonly removed: ReadonlyArray<string>
}

/** Removes `key` from the object at `parent`, dropping `parent` when that leaves it empty. */
const dropKey = (root: JsonObject, parent: string, key: string): Plan => {
  const node = root[parent]
  if (!isJsonObject(node) || !Object.hasOwn(node, key)) return { merged: root, removed: [] }
  const rest = without(node, key)
  return {
    merged: Object.keys(rest).length === 0 ? without(root, parent) : { ...root, [parent]: rest },
    removed: [`${parent}.${key}`],
  }
}

/**
 * Removes the `SessionStart` hook handlers Billion Context registered, and any group or event they
 * empty. Other events and other handlers are kept.
 */
const dropHooks = (root: JsonObject): Plan => {
  const hooks = root["hooks"]
  const groups = isJsonObject(hooks) ? hooks["SessionStart"] : undefined
  if (!isJsonObject(hooks) || !Array.isArray(groups)) return { merged: root, removed: [] }
  const removed: Array<string> = []
  const kept: Array<unknown> = []
  for (const group of groups as ReadonlyArray<unknown>) {
    if (!isJsonObject(group) || !Array.isArray(group["hooks"])) {
      kept.push(group)
      continue
    }
    const handlers = (group["hooks"] as ReadonlyArray<unknown>).filter((handler) => {
      const matched = hookMatch(handler)
      if (matched === undefined) return true
      removed.push(`hooks.SessionStart command matching ${matched}`)
      return false
    })
    if (handlers.length === group["hooks"].length) kept.push(group)
    else if (handlers.length > 0) kept.push({ ...group, hooks: handlers })
  }
  if (removed.length === 0) return { merged: root, removed }
  const rest = kept.length > 0 ? { ...hooks, SessionStart: kept } : without(hooks, "SessionStart")
  return {
    merged: Object.keys(rest).length === 0 ? without(root, "hooks") : { ...root, hooks: rest },
    removed,
  }
}

const chain = (start: JsonObject, steps: ReadonlyArray<(root: JsonObject) => Plan>): Plan => {
  let merged = start
  const removed: Array<string> = []
  for (const step of steps) {
    const plan = step(merged)
    merged = plan.merged
    removed.push(...plan.removed)
  }
  return { merged, removed }
}

/** The `DISABLE_AUTO_COMPACT` value `settings.json.bili-bak` holds, if the backup could be read. */
interface PreInstall {
  readonly readable: boolean
  readonly value: unknown
}

/**
 * Plans the removal from `~/.claude/settings.json`: the proxy base URLs, the native-mode hook, and
 * the Billion Context plugin and marketplace entries. `DISABLE_AUTO_COMPACT=1` goes only when some
 * other Billion Context entry shows it set it (`nativeMode`, or a proxy URL, a hook, or a plugin or
 * marketplace entry in these settings), because a person can set that variable for their own
 * reasons. Where the backup Billion Context made holds a value, that value is put back instead.
 */
const planSettings = (settings: JsonObject, nativeMode: boolean, backup: PreInstall): Plan => {
  const env = settings["env"]
  const proxied = BASE_URL_KEYS.filter(
    (key) => isJsonObject(env) && typeof env[key] === "string" && PROXY_URL.test(env[key]),
  )
  const hooks = dropHooks(settings)
  const plugins = settings["enabledPlugins"]
  const markets = settings["extraKnownMarketplaces"]
  const evidence =
    nativeMode ||
    proxied.length > 0 ||
    hooks.removed.length > 0 ||
    (isJsonObject(plugins) && Object.hasOwn(plugins, BILI_PLUGIN)) ||
    (isJsonObject(markets) && Object.hasOwn(markets, BILI_MARKETPLACE))
  const compact = isJsonObject(env) ? env["DISABLE_AUTO_COMPACT"] : undefined
  const noChange = (root: JsonObject): Plan => ({ merged: root, removed: [] })
  return chain(settings, [
    ...proxied.map((key) => (root: JsonObject) => dropKey(root, "env", key)),
    (root) => {
      const current = root["env"]
      if (!evidence || compact !== "1" || !backup.readable || !isJsonObject(current)) {
        return noChange(root)
      }
      if (backup.value === undefined) return dropKey(root, "env", "DISABLE_AUTO_COMPACT")
      if (backup.value === compact) return noChange(root)
      return {
        merged: { ...root, env: { ...current, DISABLE_AUTO_COMPACT: backup.value } },
        removed: [`env.DISABLE_AUTO_COMPACT=1 (put back the value in ${SETTINGS_BACKUP})`],
      }
    },
    dropHooks,
    (root) => dropKey(root, "enabledPlugins", BILI_PLUGIN),
    (root) => dropKey(root, "extraKnownMarketplaces", BILI_MARKETPLACE),
  ])
}

/**
 * Removes the `bili` MCP server from `node` when it is Billion Context's entry; `where` prefixes
 * the line.
 */
const dropBiliServer = (node: JsonObject, where: string): Plan => {
  const servers = node["mcpServers"]
  const server = isJsonObject(servers) ? servers["bili"] : undefined
  if (!isBiliServer(server)) return { merged: node, removed: [] }
  const plan = dropKey(node, "mcpServers", "bili")
  return { ...plan, removed: [`${where}mcpServers.bili running the Billion Context entry script`] }
}

/**
 * Plans the removal of the `bili` MCP server from `~/.claude.json`, both the user-level one and the
 * ones under `projects.<path>`.
 */
const planClaudeJson = (config: JsonObject): Plan => {
  const top = dropBiliServer(config, "")
  const projects = top.merged["projects"]
  if (!isJsonObject(projects)) return top
  const removed = [...top.removed]
  const kept = Object.entries(projects).map(([name, project]) => {
    const plan = isJsonObject(project)
      ? dropBiliServer(project, `projects.${name}.`)
      : { merged: project, removed: [] }
    removed.push(...plan.removed)
    return [name, plan.merged] as const
  })
  // `fromEntries` defines every key as its own property, even one named `__proto__`.
  return removed.length === top.removed.length
    ? top
    : { merged: { ...top.merged, projects: Object.fromEntries(kept) }, removed }
}

/** One place Claude Code has the Billion Context plugin installed. */
export interface PluginInstall {
  readonly scope: "user" | "project" | "local"
  /** The project the plugin is installed for; `claude plugin uninstall` runs there. */
  readonly projectPath: string | undefined
}

/**
 * The installs of the Billion Context plugin recorded in `installed_plugins.json`; none when the
 * list is empty.
 */
const pluginInstalls = (record: JsonObject): ReadonlyArray<PluginInstall> => {
  const plugins = record["plugins"]
  if (!isJsonObject(plugins) || !Object.hasOwn(plugins, BILI_PLUGIN)) return []
  const entries: ReadonlyArray<unknown> = Array.isArray(plugins[BILI_PLUGIN])
    ? (plugins[BILI_PLUGIN] as ReadonlyArray<unknown>)
    : [plugins[BILI_PLUGIN]]
  const installs = entries.map((entry): PluginInstall => {
    const scope = isJsonObject(entry) ? entry["scope"] : undefined
    const projectPath = isJsonObject(entry) ? entry["projectPath"] : undefined
    return {
      scope: scope === "project" || scope === "local" ? scope : "user",
      projectPath: typeof projectPath === "string" && projectPath !== "" ? projectPath : undefined,
    }
  })
  const distinct = new Map(
    installs.map((install) => [`${install.scope}\0${install.projectPath ?? ""}`, install]),
  )
  return [...distinct.values()]
}

/** What an earlier Billion Context setup left behind, and the plans to remove it. */
export interface Leftovers {
  readonly settingsFile: string
  readonly settings: Plan
  /** The text `settings` was planned from, or `undefined` when the file is missing. */
  readonly settingsText: string | undefined
  readonly claudeJsonFile: string
  readonly claudeJson: Plan
  /** The text `claudeJson` was planned from, or `undefined` when the file is missing. */
  readonly claudeJsonText: string | undefined
  /** The `commands/acp-cache.md` path when it exists and has the text Billion Context writes. */
  readonly command: string | undefined
  /** The `commands/acp-cache.md` path when it exists with other text; it is left alone. */
  readonly foreignCommand: string | undefined
  /** Where Claude Code has the Billion Context plugin installed. */
  readonly pluginInstalls: ReadonlyArray<PluginInstall>
  /** Whether Claude Code has the Billion Context marketplace registered. */
  readonly marketplaceRegistered: boolean
  /** Files that could not be read; they are left alone. */
  readonly unreadable: ReadonlyArray<string>
  /** One description for every leftover. */
  readonly found: ReadonlyArray<string>
}

const none = { value: {} as JsonObject, text: undefined }

/** Reads a JSON object file; one that cannot be read is empty and its message is returned. */
const readOrReport = (file: string) =>
  readJsonObjectSnapshot(file).pipe(
    Effect.map((snapshot) => ({ ...snapshot, error: undefined as string | undefined })),
    Effect.catchTag("CliFailure", (error) => Effect.succeed({ ...none, error: error.message })),
  )

const installLabel = (install: PluginInstall) =>
  `plugin ${BILI_PLUGIN}${
    install.scope === "user"
      ? ""
      : ` (${install.scope} scope${install.projectPath === undefined ? "" : ` in ${install.projectPath}`})`
  }`

/**
 * Finds what an earlier Billion Context setup left in the Claude Code files. Only entries that
 * match what Billion Context wrote count; every other setting is left out of the plans.
 */
export const findLeftovers = (files: ClaudeFiles) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const settingsFile = path.join(files.claudeDir, "settings.json")
    const settings = yield* readOrReport(settingsFile)
    const config = yield* readOrReport(files.claudeJson)
    const plugins = yield* readOrReport(
      path.join(files.claudeDir, "plugins", "installed_plugins.json"),
    )
    const markets = yield* readOrReport(
      path.join(files.claudeDir, "plugins", "known_marketplaces.json"),
    )
    const backup = yield* readOrReport(path.join(files.claudeDir, SETTINGS_BACKUP))
    const commandFile = path.join(files.claudeDir, "commands", "acp-cache.md")
    // The file is Billion Context's only when its text is the one it writes; a missing or
    // unreadable file is not.
    const commandText = yield* fs.readFileString(commandFile).pipe(
      Effect.map((text) => ({ text, error: undefined as string | undefined })),
      Effect.catch((error) =>
        Effect.succeed({
          text: undefined,
          error:
            error.reason._tag === "NotFound"
              ? undefined
              : `cannot read ${commandFile}: ${error.message}`,
        }),
      ),
    )
    const mine =
      commandText.text !== undefined && commandText.text.trimEnd() === ACP_CACHE_COMMAND.trimEnd()
    const command = mine ? commandFile : undefined
    const foreignCommand = commandText.text !== undefined && !mine ? commandFile : undefined

    const claudeJson = planClaudeJson(config.value)
    const installs = pluginInstalls(plugins.value)
    const marketplaceRegistered = Object.hasOwn(markets.value, BILI_MARKETPLACE)
    const settingsPlan = planSettings(
      settings.value,
      command !== undefined ||
        claudeJson.removed.length > 0 ||
        installs.length > 0 ||
        marketplaceRegistered,
      {
        readable: backup.error === undefined,
        value: isJsonObject(backup.value["env"])
          ? backup.value["env"]["DISABLE_AUTO_COMPACT"]
          : undefined,
      },
    )
    const found = [
      ...settingsPlan.removed.map((item) => `${item} in ${settingsFile}`),
      ...claudeJson.removed.map((item) => `${item} in ${files.claudeJson}`),
      ...(command === undefined ? [] : [command]),
      ...installs.map(installLabel),
      ...(marketplaceRegistered ? [`marketplace ${BILI_MARKETPLACE}`] : []),
    ]
    return {
      settingsFile,
      settings: settingsPlan,
      settingsText: settings.text,
      claudeJsonFile: files.claudeJson,
      claudeJson,
      claudeJsonText: config.text,
      command,
      foreignCommand,
      pluginInstalls: installs,
      marketplaceRegistered,
      unreadable: [settings, config, plugins, markets, backup, commandText].flatMap((read) =>
        read.error === undefined ? [] : [read.error],
      ),
      found,
    } satisfies Leftovers
  })

/** How often a file that changed under the cleanup is re-read and re-planned before it is skipped. */
const WRITE_ATTEMPTS = 3

/**
 * Rewrites a JSON file with the plan applied, reporting what was (or would be) removed. The file is
 * checked again just before it is replaced; one that changed meanwhile (Claude Code rewrites
 * `~/.claude.json` while it runs) is planned again from its new content, and after
 * {@link WRITE_ATTEMPTS} changes it is skipped with a note.
 */
const applyPlan = (
  files: ClaudeFiles,
  first: Leftovers,
  pick: (leftovers: Leftovers) => {
    readonly file: string
    readonly plan: Plan
    readonly text: string | undefined
  },
  dryRun: boolean,
) =>
  Effect.gen(function* () {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
      const { file, plan, text } = pick(attempt === 1 ? first : yield* findLeftovers(files))
      if (text === undefined && attempt > 1) {
        // The file read fine at first; now it is gone or is not valid JSON (it may be mid-write).
        return [
          `~ billion-context: ${file} changed while it was cleaned and cannot be read now, so it was left as it is; run holyagent setup claude again`,
        ]
      }
      if (plan.removed.length === 0 || text === undefined) return []
      if (dryRun || (yield* writeJsonObjectIfUnchanged(file, plan.merged, text))) {
        return plan.removed.map(
          (item) =>
            `+ billion-context: ${dryRun ? "would remove" : "removed"} ${item} from ${file}`,
        )
      }
    }
    return [
      `~ billion-context: ${pick(first).file} kept changing while it was cleaned and was left as it is; run holyagent setup claude again`,
    ]
  }).pipe(
    Effect.catchTag("CliFailure", (error) =>
      Effect.succeed([`! billion-context: ${error.message}`]),
    ),
  )

/** What `ownedDirectory` found out about a project folder. */
type DirectoryOwnership =
  | { readonly _tag: "Owned" }
  /** The system has no user ids (Windows), so only the folder's existence was checked. */
  | { readonly _tag: "Unchecked" }
  /** Not absolute, missing, not a folder, or owned by someone else. */
  | { readonly _tag: "Refused" }
  /** The folder could not be inspected for a reason other than being absent. */
  | { readonly _tag: "Failed"; readonly message: string }

const owned: DirectoryOwnership = { _tag: "Owned" }
const unchecked: DirectoryOwnership = { _tag: "Unchecked" }
const refused: DirectoryOwnership = { _tag: "Refused" }

/**
 * Checks that `directory` is an existing absolute folder owned by the current user. `claude` reads
 * the project settings of the folder it runs in, so it runs only in a folder nobody else controls.
 * A stat error other than not-found is reported as `Failed` instead of as a plain refusal.
 */
const ownedDirectory = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    if (!path.isAbsolute(directory)) return refused
    const info = yield* fs.stat(directory)
    if (info.type !== "Directory") return refused
    const user = process.getuid?.()
    if (user === undefined) return unchecked
    return Option.isSome(info.uid) && info.uid.value === user ? owned : refused
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        error.reason._tag === "NotFound"
          ? refused
          : ({ _tag: "Failed", message: error.message } satisfies DirectoryOwnership),
      ),
    ),
  )

/**
 * Removes what an earlier Billion Context setup left in the Claude Code files: the proxy base URLs
 * and `DISABLE_AUTO_COMPACT` it set, its hook, the `bili` MCP server, `commands/acp-cache.md`, and
 * its plugin and marketplace. It removes only entries that match what Billion Context wrote and
 * keeps every other setting. On a dry run it removes nothing and the lines say what would go.
 */
export const cleanupLeftovers = Effect.fn("cleanupLeftovers")(function* (
  files: ClaudeFiles,
  dryRun: boolean,
) {
  const fs = yield* FileSystem.FileSystem
  const shell = yield* Shell
  const leftovers = yield* findLeftovers(files)
  const verb = dryRun ? "would remove" : "removed"
  const lines: Array<string> = leftovers.unreadable.map(
    (message) => `! billion-context: ${message}; its entries were not checked`,
  )

  lines.push(
    ...(yield* applyPlan(
      files,
      leftovers,
      (l) => ({ file: l.settingsFile, plan: l.settings, text: l.settingsText }),
      dryRun,
    )),
  )
  lines.push(
    ...(yield* applyPlan(
      files,
      leftovers,
      (l) => ({ file: l.claudeJsonFile, plan: l.claudeJson, text: l.claudeJsonText }),
      dryRun,
    )),
  )

  if (leftovers.command !== undefined) {
    const file = leftovers.command
    if (dryRun) lines.push(`+ billion-context: ${verb} ${file}`)
    else {
      lines.push(
        yield* fs.remove(file).pipe(
          Effect.as(`+ billion-context: ${verb} ${file}`),
          Effect.catch((error) =>
            Effect.succeed(`! billion-context: cannot remove ${file}: ${error.message}`),
          ),
        ),
      )
    }
  }
  if (leftovers.foreignCommand !== undefined) {
    lines.push(
      `~ billion-context: ${leftovers.foreignCommand} is not the text Billion Context writes and stays; delete it yourself if it is a leftover`,
    )
  }

  const removals: Array<{
    readonly what: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string | undefined
    /** Said on the printed line when the removal runs without a full check of its folder. */
    readonly note?: string
  }> = []
  for (const install of leftovers.pluginInstalls) {
    const args = [
      "plugin",
      "uninstall",
      BILI_PLUGIN,
      ...(install.scope === "user" ? [] : ["--scope", install.scope]),
    ]
    const what = installLabel(install)
    if (install.scope === "user") removals.push({ what, args, cwd: undefined })
    else if (install.projectPath === undefined) {
      lines.push(
        `~ billion-context: ${what} stays; its install records no project folder, run in that project: claude ${args.join(" ")}`,
      )
    } else {
      const owner = yield* ownedDirectory(install.projectPath)
      if (owner._tag === "Failed") {
        lines.push(
          `~ billion-context: ${what} stays; cannot check ${install.projectPath}: ${owner.message}, so claude is not run there; run in that project: claude ${args.join(" ")}`,
        )
      } else if (owner._tag === "Refused") {
        lines.push(
          `~ billion-context: ${what} stays; ${install.projectPath} is not an existing folder of yours, so claude is not run there; run in that project: claude ${args.join(" ")}`,
        )
      } else {
        removals.push({
          what,
          args,
          cwd: install.projectPath,
          ...(owner._tag === "Unchecked"
            ? { note: "; this system has no user ids, so the folder's owner was not checked" }
            : {}),
        })
      }
    }
  }
  if (leftovers.marketplaceRegistered) {
    removals.push({
      what: `marketplace ${BILI_MARKETPLACE}`,
      args: ["plugin", "marketplace", "remove", BILI_MARKETPLACE],
      cwd: undefined,
    })
  }
  if (removals.length > 0) {
    const claude = yield* shell.which("claude", { includeBunBin: true })
    for (const removal of removals) {
      const command = `claude ${removal.args.join(" ")}`
      const where = removal.cwd === undefined ? "" : ` (in ${removal.cwd})`
      if (Option.isNone(claude)) {
        lines.push(
          `~ billion-context: ${removal.what} stays; \`claude\` not found, run${where}: ${command}`,
        )
      } else if (dryRun) {
        lines.push(
          `+ billion-context: ${verb} ${removal.what} with ${command}${where}${removal.note ?? ""}`,
        )
      } else {
        const result = yield* shell.run(
          "claude",
          removal.args,
          removal.cwd === undefined ? undefined : { cwd: removal.cwd },
        )
        const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? ""
        lines.push(
          result.exitCode === 0
            ? `+ billion-context: ${verb} ${removal.what}${removal.note ?? ""}`
            : `! billion-context: ${command} failed (exit ${result.exitCode})${detail === "" ? "" : `: ${detail}`}`,
        )
      }
    }
  }

  return lines.length === 0 ? ["= billion-context: no leftovers"] : lines
})
