import { Effect, FileSystem, Option, Path } from "effect"

import { isJsonObject, type JsonObject, readJsonObject, writeJsonObject } from "../json-file.ts"
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

/** Whether a shell command line starts with the `bili` executable (with or without a path). */
const isBiliCommand = (command: unknown): boolean => {
  if (typeof command !== "string") return false
  const program = (command.trim().split(/\s+/)[0] ?? "").replace(/^["']|["']$/g, "")
  return /^(?:.*[\\/])?bili(?:\.(?:cmd|exe|ps1))?$/i.test(program)
}

const isBiliHook = (handler: unknown): handler is JsonObject & { readonly command: string } =>
  isJsonObject(handler) &&
  typeof handler["command"] === "string" &&
  (handler["command"].includes(HOOK_MARKER) || isBiliCommand(handler["command"]))

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
        if (!isBiliHook(handler)) return true
        removed.push(`hooks.${event} command ${handler.command}`)
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
 * other native-mode artifact shows Billion Context set it (`nativeMode`), because a person can set
 * that variable for their own reasons.
 */
const planSettings = (settings: JsonObject, nativeMode: boolean): Plan => {
  const env = settings["env"]
  const proxyUrl = isJsonObject(env) ? env["ANTHROPIC_BASE_URL"] : undefined
  const proxied = typeof proxyUrl === "string" && proxyUrl.startsWith(PROXY_ORIGIN)
  const hooks = dropHooks(settings)
  const evidence = nativeMode || proxied || hooks.removed.length > 0
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

/** Plans the removal of the `bili` MCP server from `~/.claude.json`. */
const planClaudeJson = (config: JsonObject): Plan => {
  const servers = config["mcpServers"]
  const server = isJsonObject(servers) ? servers["bili"] : undefined
  if (!isJsonObject(server) || !isBiliCommand(server["command"])) {
    return { merged: config, removed: [] }
  }
  const plan = dropKey(config, "mcpServers", "bili")
  return { ...plan, removed: [`mcpServers.bili command ${String(server["command"])}`] }
}

/** What an earlier Billion Context setup left behind, and the plans to remove it. */
export interface Leftovers {
  readonly settingsFile: string
  readonly settings: Plan
  readonly claudeJsonFile: string
  readonly claudeJson: Plan
  /** The `commands/acp-cache.md` path when it exists. */
  readonly command: string | undefined
  /** Whether Claude Code has the Billion Context plugin installed. */
  readonly pluginInstalled: boolean
  /** Whether Claude Code has the Billion Context marketplace registered. */
  readonly marketplaceRegistered: boolean
  /** Files that could not be read; they are left alone. */
  readonly unreadable: ReadonlyArray<string>
  /** One description for every leftover. */
  readonly found: ReadonlyArray<string>
}

const none: JsonObject = {}

/** Reads a JSON object file; one that cannot be read is empty and its message is returned. */
const readOrReport = (file: string) =>
  readJsonObject(file).pipe(
    Effect.map((value) => ({ value, error: undefined as string | undefined })),
    Effect.catchTag("CliFailure", (error) => Effect.succeed({ value: none, error: error.message })),
  )

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
    const command = (yield* fs.exists(commandFile).pipe(Effect.orElseSucceed(() => false)))
      ? commandFile
      : undefined

    const claudeJson = planClaudeJson(config.value)
    const settingsPlan = planSettings(
      settings.value,
      command !== undefined || claudeJson.removed.length > 0,
    )
    const installed = plugins.value["plugins"]
    const pluginInstalled = isJsonObject(installed) && Object.hasOwn(installed, BILI_PLUGIN)
    const marketplaceRegistered = Object.hasOwn(markets.value, BILI_MARKETPLACE)
    const found = [
      ...settingsPlan.removed.map((item) => `${item} in ${settingsFile}`),
      ...claudeJson.removed.map((item) => `${item} in ${files.claudeJson}`),
      ...(command === undefined ? [] : [command]),
      ...(pluginInstalled ? [`plugin ${BILI_PLUGIN}`] : []),
      ...(marketplaceRegistered ? [`marketplace ${BILI_MARKETPLACE}`] : []),
    ]
    return {
      settingsFile,
      settings: settingsPlan,
      claudeJsonFile: files.claudeJson,
      claudeJson,
      command,
      pluginInstalled,
      marketplaceRegistered,
      unreadable: [settings, config].flatMap((read) =>
        read.error === undefined ? [] : [read.error],
      ),
      found,
    } satisfies Leftovers
  })

/** Rewrites a JSON file with the plan applied, reporting what was (or would be) removed. */
const applyPlan = (file: string, plan: Plan, dryRun: boolean) =>
  Effect.gen(function* () {
    if (plan.removed.length === 0) return []
    if (!dryRun) yield* writeJsonObject(file, plan.merged)
    return plan.removed.map(
      (item) => `+ billion-context: ${dryRun ? "would remove" : "removed"} ${item} from ${file}`,
    )
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

  lines.push(...(yield* applyPlan(leftovers.settingsFile, leftovers.settings, dryRun)))
  lines.push(...(yield* applyPlan(leftovers.claudeJsonFile, leftovers.claudeJson, dryRun)))

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

  const removals = [
    ...(leftovers.pluginInstalled
      ? [
          {
            what: `plugin ${BILI_PLUGIN}`,
            args: ["plugin", "uninstall", BILI_PLUGIN],
          },
        ]
      : []),
    ...(leftovers.marketplaceRegistered
      ? [
          {
            what: `marketplace ${BILI_MARKETPLACE}`,
            args: ["plugin", "marketplace", "remove", BILI_MARKETPLACE],
          },
        ]
      : []),
  ]
  if (removals.length > 0) {
    const claude = yield* shell.which("claude", { includeBunBin: true })
    for (const removal of removals) {
      if (Option.isNone(claude)) {
        lines.push(
          `~ billion-context: ${removal.what} stays; \`claude\` not found, run: claude ${removal.args.join(" ")}`,
        )
      } else if (dryRun) {
        lines.push(
          `+ billion-context: ${verb} ${removal.what} with claude ${removal.args.join(" ")}`,
        )
      } else {
        const result = yield* shell.run("claude", removal.args)
        const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? ""
        lines.push(
          result.exitCode === 0
            ? `+ billion-context: ${verb} ${removal.what}`
            : `! billion-context: claude ${removal.args.join(" ")} failed (exit ${result.exitCode})${detail === "" ? "" : `: ${detail}`}`,
        )
      }
    }
  }

  return lines.length === 0 ? ["= billion-context: no leftovers"] : lines
})
