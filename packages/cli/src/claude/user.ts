import { homedir } from "node:os"

import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"

import { CliFailure, type Report } from "../report.ts"
import { Shell, type ShellResult } from "../shell.ts"
import { MARKETPLACE, PLUGIN_ID } from "./project.ts"

const InstalledPlugins = Schema.Array(Schema.Struct({ id: Schema.String }))
const Marketplaces = Schema.Array(Schema.Struct({ name: Schema.String }))

const added = (text: string) => `+ ${text}`
const present = (text: string) => `= ${text}`
const skipped = (text: string) => `- ${text}`
const hint = (text: string) => `~ ${text}`
const failed = (what: string, result: ShellResult) => {
  const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? ""
  return `! ${what}: failed (exit ${result.exitCode})${detail === "" ? "" : `: ${detail}`}`
}

/**
 * The current user's home directory: `HOME`, else `USERPROFILE` (what Windows sets), else the
 * operating system's answer. An empty variable counts as unset.
 */
export const homeDirectory = Effect.gen(function* () {
  const home = yield* Config.option(Config.String("HOME"))
  const profile = yield* Config.option(Config.String("USERPROFILE"))
  return (
    [home, profile]
      .map(Option.getOrUndefined)
      .find((value) => value !== undefined && value !== "") ?? homedir()
  )
})

/** Where the current user's Claude Code and Context7 files live. */
const userFiles = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* homeDirectory
  const claudeConfigDir = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"))
  const claudeDir = Option.getOrElse(claudeConfigDir, () => path.join(home, ".claude"))
  return {
    claudeDir,
    // Claude Code keeps .claude.json inside CLAUDE_CONFIG_DIR when that is set, else in $HOME.
    claudeJson: path.join(
      Option.getOrElse(claudeConfigDir, () => home),
      ".claude.json",
    ),
    ctx7Credentials: path.join(home, ".config", "context7", "credentials.json"),
  }
}).pipe(Effect.mapError((error) => new CliFailure({ message: `environment: ${error.message}` })))

const fileExists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.exists(path)
  }).pipe(Effect.catch(() => Effect.succeed(false)))

/** Installs the HolyAgent plugin through `claude plugin`, unless it is already installed. */
const installPlugin = Effect.fn("installPlugin")(function* (dryRun: boolean) {
  const shell = yield* Shell
  if (Option.isNone(yield* shell.which("claude", { includeBunBin: true }))) {
    return [
      `! plugin ${PLUGIN_ID}: \`claude\` not found; install Claude Code first (https://code.claude.com/docs/en/setup)`,
    ]
  }
  const listing = yield* shell.run("claude", ["plugin", "list", "--json"])
  if (listing.exitCode !== 0) return [failed("claude plugin list", listing)]
  const installed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(InstalledPlugins))(
    listing.stdout,
  ).pipe(Effect.option)
  if (Option.isNone(installed))
    return [`! claude plugin list: output is not the expected JSON list`]
  if (installed.value.some((plugin) => plugin.id === PLUGIN_ID)) {
    return [present(`plugin ${PLUGIN_ID}: already installed`)]
  }
  if (dryRun) return [added(`plugin ${PLUGIN_ID}: would install`)]
  // The plugin's own marketplace must be registered before the install. `marketplace add` is skipped
  // for a registered one; a listing that cannot be read falls through to the add, which Claude Code
  // also accepts for a known marketplace.
  const known = yield* shell.run("claude", ["plugin", "marketplace", "list", "--json"])
  const registered =
    known.exitCode === 0
      ? yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Marketplaces))(known.stdout).pipe(
          Effect.map((list) => new Set(list.map((entry) => entry.name))),
          Effect.orElseSucceed(() => new Set<string>()),
        )
      : new Set<string>()
  if (!registered.has(MARKETPLACE.name)) {
    const result = yield* shell.run("claude", ["plugin", "marketplace", "add", MARKETPLACE.repo])
    if (result.exitCode !== 0)
      return [failed(`claude plugin marketplace add ${MARKETPLACE.repo}`, result)]
  }
  const install = yield* shell.run("claude", ["plugin", "install", PLUGIN_ID])
  if (install.exitCode !== 0) return [failed("claude plugin install", install)]
  return [added(`plugin ${PLUGIN_ID}: installed`)]
})

/**
 * Installs a command with `bun add -g` unless it is already available. Returns the report lines and
 * whether the command can be used afterwards (on a dry run, whether it would be).
 */
const ensureGlobal = Effect.fn("ensureGlobal")(function* (
  command: string,
  packageName: string,
  dryRun: boolean,
) {
  const shell = yield* Shell
  if (Option.isSome(yield* shell.which(command, { includeBunBin: true }))) {
    return { usable: true, lines: [present(`${command}: already installed`)] }
  }
  if (dryRun) {
    return {
      usable: true,
      lines: [added(`${command}: would install with bun add -g ${packageName}`)],
    }
  }
  const result = yield* shell.run("bun", ["add", "-g", packageName])
  if (result.exitCode !== 0)
    return { usable: false, lines: [failed(`bun add -g ${packageName}`, result)] }
  const lines = [added(`${command}: installed with bun add -g ${packageName}`)]
  const onPath = yield* shell.which(command)
  const anywhere = yield* shell.which(command, { includeBunBin: true })
  if (Option.isNone(onPath) && Option.isSome(anywhere)) {
    lines.push(hint(`${command}: ${anywhere.value} is not on PATH; add its directory to PATH`))
  }
  return { usable: true, lines }
})

/** Ctx7 and the Context7 skill; the skill is skipped, with a hint, when no login or key exists. */
const installCtx7 = Effect.fn("installCtx7")(function* (dryRun: boolean) {
  const shell = yield* Shell
  const path = yield* Path.Path
  const files = yield* userFiles
  const global = yield* ensureGlobal("ctx7", "ctx7", dryRun)
  if (!global.usable) return global.lines

  const skillReady =
    (yield* fileExists(path.join(files.claudeDir, "skills", "find-docs", "SKILL.md"))) &&
    (yield* fileExists(path.join(files.claudeDir, "rules", "context7.md")))
  if (skillReady) return [...global.lines, present("ctx7 skill: already installed")]
  // An empty variable counts as unset.
  const apiKey = Option.filter(
    yield* Config.option(Config.String("CONTEXT7_API_KEY")).pipe(
      Effect.mapError((error) => new CliFailure({ message: `environment: ${error.message}` })),
    ),
    (key) => key !== "",
  )

  // ctx7 reads CONTEXT7_API_KEY during setup only for self-hosted deployments, so the key has to
  // go on the command line, where `ps` shows it for the seconds the command runs.
  const setupArgs = ["setup", "--cli", "--claude", "--yes"]
  const args = Option.isSome(apiKey)
    ? [...setupArgs, "--api-key", apiKey.value]
    : (yield* fileExists(files.ctx7Credentials))
      ? setupArgs
      : undefined
  if (args === undefined) {
    return [
      ...global.lines,
      skipped(
        "ctx7 skill: no CONTEXT7_API_KEY and no saved login; run `ctx7 login` or export CONTEXT7_API_KEY, then re-run",
      ),
    ]
  }
  if (dryRun) {
    return [...global.lines, added("ctx7 skill: would install with ctx7 setup --cli --claude")]
  }
  const result = yield* shell.run("ctx7", args)
  return [
    ...global.lines,
    result.exitCode === 0
      ? added("ctx7 skill: installed with ctx7 setup --cli --claude")
      : failed("ctx7 setup", result),
  ]
})

/** Turns a step that cannot start (unreadable environment) into a failed line, not an abort. */
export const asStep = <R>(
  label: string,
  step: Effect.Effect<ReadonlyArray<string>, CliFailure, R>,
) =>
  step.pipe(
    Effect.catchTag("CliFailure", (error) => Effect.succeed([`! ${label}: ${error.message}`])),
  )

/**
 * Installs HolyAgent for the current user: the Claude Code plugin and ctx7. Every step checks its
 * own result first, and a step that fails does not stop the others. On a dry run nothing is
 * installed or written, and the lines say what would be.
 */
export const setupUser = Effect.fn("setupUser")(function* (options: {
  readonly skipCtx7: boolean
  readonly dryRun: boolean
}) {
  const lines = [
    ...(yield* installPlugin(options.dryRun)),
    ...(options.skipCtx7
      ? [skipped("ctx7: skipped by flag")]
      : yield* asStep("ctx7", installCtx7(options.dryRun))),
  ]
  return { lines, ok: !lines.some((line) => line.startsWith("! ")) } satisfies Report
})
