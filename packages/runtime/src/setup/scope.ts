import { join, resolve } from "node:path"

import { Effect } from "effect"

import { type Env, userFiles } from "./environment.ts"
import { Shell } from "./shell.ts"

/**
 * The settings scopes `holyagent setup` can target, named like Claude Code's own: `user` applies to
 * every project, `project` is the repository's shared `.claude/settings.json`, and `local` is its
 * untracked `.claude/settings.local.json` (https://code.claude.com/docs/en/settings).
 */
export const SCOPES = ["user", "project", "local"] as const

/** A settings scope of {@link SCOPES}. */
export type Scope = (typeof SCOPES)[number]

/**
 * The settings file of a scope. `user` is the file of `userFiles` (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`), with no process spawned. `project` and `local` live in `.claude` of the git
 * top-level of `cwd`, else of `cwd` itself when it is not inside a repository or git is missing.
 */
export const settingsFile = Effect.fn("settingsFile")(function* (
  env: Env,
  scope: Scope,
  cwd: string,
) {
  if (scope === "user") return userFiles(env).settings
  const shell = yield* Shell
  const top = yield* shell.run("git", ["rev-parse", "--show-toplevel"], { cwd })
  const line = top.stdout.trim()
  const root = top.exitCode === 0 && line !== "" ? resolve(line) : cwd
  return join(root, ".claude", scope === "project" ? "settings.json" : "settings.local.json")
})
