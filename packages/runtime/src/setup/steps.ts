import { join } from "node:path"

import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import { type Env, homeDirectory, userFiles } from "./environment.ts"
import type { SetupFailure } from "./errors.ts"
import { fileExists } from "./json-file.ts"
import { cleanupLeftovers } from "./leftovers.ts"
import { added, failed, hint, present, type Report, skipped } from "./report.ts"
import { type CacheTtl, mergeUserSettings } from "./settings.ts"
import { EMPTY_BUNFIG, Shell } from "./shell.ts"

/** Why ctx7 is left out of a claude.ai cloud session. */
const CLOUD_SKIP =
  "skipped in a claude.ai cloud session (CLAUDE_CODE_REMOTE=true), which has no machine of yours to install it on"

/**
 * The directory every setup child runs in: the home directory, not the process directory, which is
 * the user's project and may hold a .npmrc, bunfig.toml or .env that would steer an install.
 */
const neutralDirectory = (env: Env) => homeDirectory(env)

/**
 * Installs a command with `bun add -g` unless it is already available. Returns the report lines and
 * whether the command can be used afterwards (on a dry run, whether it would be).
 */
const ensureGlobal = Effect.fn("ensureGlobal")(function* (
  env: Env,
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
  // Bun reads no .env and the empty config, so a project's own files cannot redirect the install.
  const result = yield* shell.run(
    "bun",
    ["--no-env-file", `--config=${EMPTY_BUNFIG}`, "add", "-g", packageName],
    { cwd: neutralDirectory(env) },
  )
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
export const installCtx7 = Effect.fn("installCtx7")(function* (env: Env, dryRun: boolean) {
  const shell = yield* Shell
  const files = userFiles(env)
  const global = yield* ensureGlobal(env, "ctx7", "ctx7", dryRun)
  if (!global.usable) return global.lines

  const skillReady =
    (yield* fileExists(join(files.claudeDir, "skills", "find-docs", "SKILL.md"))) &&
    (yield* fileExists(join(files.claudeDir, "rules", "context7.md")))
  if (skillReady) return [...global.lines, present("ctx7 skill: already installed")]
  // An empty variable counts as unset.
  const apiKey = env.CONTEXT7_API_KEY === "" ? undefined : env.CONTEXT7_API_KEY

  // ctx7 reads CONTEXT7_API_KEY during setup only for self-hosted deployments, so the key has to
  // go on the command line, where `ps` shows it for the seconds the command runs.
  const setupArgs = ["setup", "--cli", "--claude", "--yes"]
  const args =
    apiKey !== undefined
      ? [...setupArgs, "--api-key", apiKey]
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
  const result = yield* shell.run("ctx7", args, { cwd: neutralDirectory(env) })
  return [
    ...global.lines,
    result.exitCode === 0
      ? added("ctx7 skill: installed with ctx7 setup --cli --claude")
      : failed("ctx7 setup", result),
  ]
})

/** Turns a step that cannot finish (an unreadable settings file) into a failed line, not an abort. */
export const asStep = <R>(
  label: string,
  step: Effect.Effect<ReadonlyArray<string>, SetupFailure, R>,
) =>
  step.pipe(
    Effect.catchTag("SetupFailure", (error) => Effect.succeed([`! ${label}: ${error.message}`])),
  )

/** What `holyagent setup` was asked to do. */
export interface SetupOptions {
  readonly subagentCacheTtl: CacheTtl
  readonly dryRun: boolean
  readonly skipCtx7: boolean
}

/**
 * Sets up HolyAgent for the current user: ctx7, the recommended keys of the user settings, and the
 * removal of what an earlier Billion Context setup left in the Claude Code files. Every step checks
 * its own result first, and a step that fails does not stop the next one. On a dry run nothing is
 * installed, removed or written, and the lines say what would be. In a claude.ai cloud session ctx7
 * is skipped, and the settings are still merged.
 */
export const setup = Effect.fn("setup")(function* (env: Env, options: SetupOptions) {
  const cloud = inCloudSession(env)
  const lines = [
    ...(yield* asStep("billion-context", cleanupLeftovers(env, options.dryRun))),
    ...(options.skipCtx7
      ? [skipped("ctx7: skipped by flag")]
      : cloud
        ? [skipped(`ctx7: ${CLOUD_SKIP}`)]
        : yield* asStep("ctx7", installCtx7(env, options.dryRun))),
    ...(yield* asStep("user settings", mergeUserSettings(env, options))),
  ]
  return { lines, ok: !lines.some((line) => line.startsWith("! ")) } satisfies Report
})
