import { homedir } from "node:os"
import { join } from "node:path"

import { claudeConfigDirectory } from "../cli/config.ts"

/** An environment as a process holds it. */
export type Env = Readonly<Record<string, string | undefined>>

const firstNonEmpty = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value !== "")

/**
 * The current user's home directory: `HOME`, else `USERPROFILE` (what Windows sets), else the
 * operating system's answer. An empty variable counts as unset.
 */
export const homeDirectory = (env: Env, fallback: () => string = homedir): string =>
  firstNonEmpty(env.HOME, env.USERPROFILE) ?? fallback()

/**
 * Where the current user's Claude Code and Context7 files live. The Claude Code folder is
 * `CLAUDE_CONFIG_DIR` when set, else `.claude` in the home directory
 * (https://code.claude.com/docs/en/env-vars).
 */
export const userFiles = (env: Env) => {
  const home = homeDirectory(env)
  const claudeDir = claudeConfigDirectory(env, () => home)
  return {
    claudeDir,
    /** The user settings, which Claude Code applies to every project. */
    settings: join(claudeDir, "settings.json"),
    // Claude Code keeps .claude.json inside CLAUDE_CONFIG_DIR when that is set, else in $HOME.
    claudeJson: join(firstNonEmpty(env.CLAUDE_CONFIG_DIR) ?? home, ".claude.json"),
    ctx7Credentials: join(home, ".config", "context7", "credentials.json"),
  }
}
