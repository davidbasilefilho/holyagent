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

/** The local proxy origin Billion Context's native mode pointed `ANTHROPIC_BASE_URL` at. */
const PROXY_ORIGIN = "http://127.0.0.1:18787"
/** What the native-mode `SessionStart` hook command contained. */
const HOOK_MARKER = "claude-native-bootstrap"
/** The Billion Context plugin and the marketplace it came from. */
const BILI_PLUGIN = "billion-context@billion-context"
const BILI_MARKETPLACE = "billion-context"

/** What `commands/acp-cache.md` says when Billion Context wrote it. */
const COMMAND_MARKER = /billion[- ]?context|\bbili\b|claude-native-bootstrap/i

/** Splits a command line into words, keeping quoted text (such as a path with spaces) in one. */
const words = (command: string): ReadonlyArray<string> => {
  const found: Array<string> = []
  let current = ""
  let quote: string | undefined
  let started = false
  for (const char of command.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started || current !== "") found.push(current)
      current = ""
      started = false
    } else current += char
  }
  if (started || current !== "") found.push(current)
  return found
}

/** The program a command line runs, after `VAR=value` assignments and an `env` wrapper. */
const programOf = (command: string): string | undefined => {
  const tokens = words(command)
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index] ?? ""
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) index += 1
    else if (/^(?:.*[\\/])?env(?:\.exe)?$/i.test(token)) {
      index += 1
      while ((tokens[index] ?? "").startsWith("-")) {
        index += /^(?:-u|--unset|-C|--chdir)$/.test(tokens[index] ?? "") ? 2 : 1
      }
    } else return token
  }
  return undefined
}

/** Whether a shell command line runs the `bili` executable (with or without a path or wrapper). */
const isBiliCommand = (command: unknown): boolean =>
  typeof command === "string" &&
  /^(?:.*[\\/])?bili(?:\.(?:cmd|exe|ps1))?$/i.test(programOf(command) ?? "")

/** What a hook command matched, for the report line: the marker or `bili`, never the command. */
const hookMatch = (handler: unknown): string | undefined => {
  if (!isJsonObject(handler) || typeof handler["command"] !== "string") return undefined
  if (handler["command"].includes(HOOK_MARKER)) return HOOK_MARKER
  return isBiliCommand(handler["command"]) ? "bili" : undefined
}

/** Whether `ANTHROPIC_BASE_URL` is the Billion Context proxy: that origin, with any path. */
const isProxyUrl = (value: unknown): boolean =>
  typeof value === "string" && URL.canParse(value) && new URL(value).origin === PROXY_ORIGIN

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

/** Removes the hook handlers Billion Context registered, and any group or event they empty. */
const dropHooks = (root: JsonObject): Plan => {
  const hooks = root["hooks"]
  if (!isJsonObject(hooks)) return { merged: root, removed: [] }
  const removed: Array<string> = []
  const events: Record<string, unknown> = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      events[event] = groups
      continue
    }
    const before = removed.length
    const kept: Array<unknown> = []
    for (const group of groups as ReadonlyArray<unknown>) {
      if (!isJsonObject(group) || !Array.isArray(group["hooks"])) {
        kept.push(group)
        continue
      }
      const handlers = (group["hooks"] as ReadonlyArray<unknown>).filter((handler) => {
        const matched = hookMatch(handler)
        if (matched === undefined) return true
        removed.push(`hooks.${event} command matching ${matched}`)
        return false
      })
      if (handlers.length === group["hooks"].length) kept.push(group)
      else if (handlers.length > 0) kept.push({ ...group, hooks: handlers })
    }
    if (removed.length === before || kept.length > 0) events[event] = kept
  }
  if (removed.length === 0) return { merged: root, removed }
  const merged =
    Object.keys(events).length === 0 ? without(root, "hooks") : { ...root, hooks: events }
  return { merged, removed }
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

/**
 * Plans the removal from `~/.claude/settings.json`: the proxy base URL, the native-mode hook, and
 * the Billion Context plugin and marketplace entries. `DISABLE_AUTO_COMPACT=1` goes only when some
 * other Billion Context entry shows it set it (`nativeMode`, or the proxy URL, a hook, or a plugin
 * or marketplace entry in these settings), because a person can set that variable for their own
 * reasons.
 */
const planSettings = (settings: JsonObject, nativeMode: boolean): Plan => {
  const env = settings["env"]
  const proxied = isJsonObject(env) && isProxyUrl(env["ANTHROPIC_BASE_URL"])
  const hooks = dropHooks(settings)
  const plugins = settings["enabledPlugins"]
  const markets = settings["extraKnownMarketplaces"]
  const evidence =
    nativeMode ||
    proxied ||
    hooks.removed.length > 0 ||
    (isJsonObject(plugins) && Object.hasOwn(plugins, BILI_PLUGIN)) ||
    (isJsonObject(markets) && Object.hasOwn(markets, BILI_MARKETPLACE))
  const compact = isJsonObject(env) ? env["DISABLE_AUTO_COMPACT"] : undefined
  return chain(settings, [
    (root) =>
      proxied ? dropKey(root, "env", "ANTHROPIC_BASE_URL") : { merged: root, removed: [] },
    (root) =>
      evidence && (compact === "1" || compact === 1)
        ? dropKey(root, "env", "DISABLE_AUTO_COMPACT")
        : { merged: root, removed: [] },
    dropHooks,
    (root) => dropKey(root, "enabledPlugins", BILI_PLUGIN),
    (root) => dropKey(root, "extraKnownMarketplaces", BILI_MARKETPLACE),
  ])
}

/** Removes the `bili` MCP server from `node` when its command is `bili`; `where` prefixes the line. */
const dropBiliServer = (node: JsonObject, where: string): Plan => {
  const servers = node["mcpServers"]
  const server = isJsonObject(servers) ? servers["bili"] : undefined
  if (!isJsonObject(server) || !isBiliCommand(server["command"])) {
    return { merged: node, removed: [] }
  }
  const plan = dropKey(node, "mcpServers", "bili")
  return { ...plan, removed: [`${where}mcpServers.bili command bili`] }
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
  const kept: Record<string, unknown> = {}
  for (const [name, project] of Object.entries(projects)) {
    const plan = isJsonObject(project)
      ? dropBiliServer(project, `projects.${name}.`)
      : { merged: project, removed: [] }
    removed.push(...plan.removed)
    kept[name] = plan.merged
  }
  return removed.length === top.removed.length
    ? top
    : { merged: { ...top.merged, projects: kept }, removed }
}

/** One place Claude Code has the Billion Context plugin installed. */
export interface PluginInstall {
  readonly scope: "user" | "project" | "local"
  /** The project the plugin is installed for; `claude plugin uninstall` runs there. */
  readonly projectPath: string | undefined
}

/** The installs of the Billion Context plugin recorded in `installed_plugins.json`. */
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
  return distinct.size === 0 ? [{ scope: "user", projectPath: undefined }] : [...distinct.values()]
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
  /** The `commands/acp-cache.md` path when it exists and says it is Billion Context's. */
  readonly command: string | undefined
  /** The `commands/acp-cache.md` path when it exists but does not say so; it is left alone. */
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
  `plugin ${BILI_PLUGIN}${install.scope === "user" ? "" : ` (${install.scope} scope)`}`

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
    const commandFile = path.join(files.claudeDir, "commands", "acp-cache.md")
    // The file is Billion Context's only when its text says so; a missing or unreadable file is not.
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
    const mine = commandText.text !== undefined && COMMAND_MARKER.test(commandText.text)
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
      unreadable: [settings, config, plugins, markets, commandText].flatMap((read) =>
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

/**
 * Removes what an earlier Billion Context setup left in the Claude Code files: the proxy base URL
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
      `~ billion-context: ${leftovers.foreignCommand} does not mention Billion Context and stays; delete it yourself if it is a leftover`,
    )
  }

  const removals = [
    ...leftovers.pluginInstalls.map((install) => ({
      what: installLabel(install),
      args: [
        "plugin",
        "uninstall",
        BILI_PLUGIN,
        ...(install.scope === "user" ? [] : ["--scope", install.scope]),
      ],
      cwd: install.scope === "user" ? undefined : install.projectPath,
    })),
    ...(leftovers.marketplaceRegistered
      ? [
          {
            what: `marketplace ${BILI_MARKETPLACE}`,
            args: ["plugin", "marketplace", "remove", BILI_MARKETPLACE],
            cwd: undefined,
          },
        ]
      : []),
  ]
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
        lines.push(`+ billion-context: ${verb} ${removal.what} with ${command}${where}`)
      } else {
        const result = yield* shell.run(
          "claude",
          removal.args,
          removal.cwd === undefined ? undefined : { cwd: removal.cwd },
        )
        const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? ""
        lines.push(
          result.exitCode === 0
            ? `+ billion-context: ${verb} ${removal.what}`
            : `! billion-context: ${command} failed (exit ${result.exitCode})${detail === "" ? "" : `: ${detail}`}`,
        )
      }
    }
  }

  return lines.length === 0 ? ["= billion-context: no leftovers"] : lines
})
