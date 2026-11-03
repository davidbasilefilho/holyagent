import { lstat, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { Effect } from "effect"

import { type Env, userFiles } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { Shell } from "./shell.ts"

/**
 * The settings scopes `holyagent setup` can target, named like Claude Code's own: `user` applies to
 * every project, `project` is the repository's shared `.claude/settings.json`, and `local` is its
 * untracked `.claude/settings.local.json` (https://code.claude.com/docs/en/settings).
 */
export const SCOPES = ["user", "project", "local"] as const

/** A settings scope of {@link SCOPES}. */
export type Scope = (typeof SCOPES)[number]

/** Whether `child` is `parent` or inside it, both as real paths. */
const within = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/** The real path, or undefined when it cannot be resolved (it does not exist, say). */
const real = (path: string) =>
  Effect.tryPromise(() => realpath(path)).pipe(Effect.orElseSucceed(() => undefined))

/** Whether the entry at `path` is itself a symlink; a missing entry is not. */
const isSymlink = (path: string) =>
  Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => cause as NodeJS.ErrnoException,
  }).pipe(
    Effect.map((stats) => stats.isSymbolicLink()),
    Effect.catch((error) =>
      error.code === "ENOENT" || error.code === "ENOTDIR"
        ? Effect.succeed(false)
        : Effect.fail(new SetupFailure({ message: `cannot inspect ${path}: ${error.message}` })),
    ),
  )

/**
 * Where `holyagent setup` and `doctor` read and write the settings of a scope: the `file`, and a
 * `notice` line when the answer is not the usual one.
 */
export interface SettingsTarget {
  readonly file: string
  readonly notice?: string
}

/**
 * The settings file of a scope. `user` is the file of `userFiles` (`CLAUDE_CONFIG_DIR`, else
 * `~/.claude`), with no process spawned. `project` and `local` live in `.claude` of the git
 * top-level of `cwd`, else of `cwd` itself when it is not inside a repository or git is missing.
 * The top-level counts only when it is `cwd` or an ancestor of it (compared as real paths), since a
 * crafted `core.worktree` can make git name any directory; otherwise `cwd` is used and the notice
 * says so. For `project` and `local`, a `.claude` folder or settings file that is a symlink fails
 * with SetupFailure, so a repository cannot redirect the write; `user` follows its links as
 * before.
 */
export const settingsFile = Effect.fn("settingsFile")(function* (
  env: Env,
  scope: Scope,
  cwd: string,
) {
  if (scope === "user") return { file: userFiles(env).settings } satisfies SettingsTarget
  const shell = yield* Shell
  const top = yield* shell.run("git", ["rev-parse", "--show-toplevel"], { cwd })
  const line = top.stdout.trim()
  const named = top.exitCode === 0 && line !== "" ? resolve(line) : undefined
  const realTop = named === undefined ? undefined : yield* real(named)
  const realCwd = yield* real(cwd)
  const trusted =
    named !== undefined &&
    realTop !== undefined &&
    realCwd !== undefined &&
    within(realTop, realCwd)
  const root = trusted ? named : cwd
  const notice =
    named !== undefined && !trusted
      ? `git names ${named} as the top-level, which is not the current directory or above it; using ${cwd}`
      : undefined
  const folder = join(root, ".claude")
  const file = join(folder, scope === "project" ? "settings.json" : "settings.local.json")
  for (const path of [folder, file]) {
    if (yield* isSymlink(path)) {
      return yield* new SetupFailure({
        message: `${path} is a symlink; refusing to write through it in the ${scope} scope. Replace it with a real ${path === folder ? "folder" : "file"} and run again`,
      })
    }
  }
  return { file, ...(notice === undefined ? {} : { notice }) } satisfies SettingsTarget
})
