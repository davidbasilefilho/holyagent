import { homedir } from "node:os"
import { join } from "node:path"

/** An environment as a process holds it. */
export type Env = Readonly<Record<string, string | undefined>>

/** The first value that is set and not empty; an empty variable counts as unset. */
export const firstNonEmpty = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value !== "")

/**
 * The environment without its unset entries, the form a child process takes. Names in `omit` are
 * dropped too.
 */
export const definedEnv = (
  env: Env,
  omit: ReadonlySet<string> = new Set(),
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !omit.has(entry[0]),
    ),
  )

/**
 * The current user's home directory: `HOME`, else `USERPROFILE` (what Windows sets), else the
 * operating system's answer. An empty variable counts as unset.
 */
export const homeDirectory = (env: Env, fallback: () => string = homedir): string =>
  firstNonEmpty(env.HOME, env.USERPROFILE) ?? fallback()

/**
 * The folder of the user's Claude Code settings: `CLAUDE_CONFIG_DIR` when set, else `.claude` in
 * the home directory (`HOME`, else `USERPROFILE` as on Windows, else the operating system's).
 */
export const claudeConfigDirectory = (env: Env, home: () => string = homedir): string =>
  firstNonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(homeDirectory(env, home), ".claude")

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
    ctx7Credentials: join(home, ".config", "context7", "credentials.json"),
  }
}
