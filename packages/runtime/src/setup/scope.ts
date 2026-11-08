import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { Effect } from "effect"

import { type Env, userFiles } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { isJsonObject, readJsonObject } from "./json-file.ts"
import { PLUGIN_ID } from "./settings.ts"
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

/** Whether anything (a folder, or the file a linked worktree has) exists at `path`. */
const present = (path: string) =>
  Effect.tryPromise(() => lstat(path)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/**
 * Whether the entry at `path` is itself a symlink; a missing entry is not. Fails with SetupFailure
 * when the entry cannot be inspected.
 */
export const isSymlink = (path: string) =>
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
 * The top-level counts only when it is `cwd` or an ancestor of it (compared as real paths) and
 * holds a `.git` entry, since a crafted `core.worktree` can make git name any directory, an
 * ancestor of `cwd` included; otherwise `cwd` is used and the notice says so, as it does outside a
 * repository. For `project` and `local`, a `.claude` folder or settings file that is a symlink
 * fails with SetupFailure, so a repository cannot redirect the write; `user` follows its links as
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
    within(realTop, realCwd) &&
    (yield* present(join(named, ".git")))
  const root = trusted ? named : cwd
  const notice = trusted
    ? undefined
    : named === undefined
      ? `not inside a git repository; using ${cwd}`
      : `git names ${named} as the top-level, which is not the current directory or an ancestor holding a .git entry; using ${cwd}`
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

/**
 * The project and local settings files that may hold the keys of a session started in `cwd`, for
 * the SessionStart check, which spawns nothing: the files of `cwd` and of its nearest ancestor with
 * a `.git` entry (the folder `settingsFile` picks inside a repository). The files need not exist.
 */
export const projectSettingsFiles = Effect.fn("projectSettingsFiles")(function* (cwd: string) {
  const roots = [resolve(cwd)]
  for (let folder = resolve(cwd); ; folder = dirname(folder)) {
    if (yield* present(join(folder, ".git"))) {
      if (folder !== roots[0]) roots.push(folder)
      break
    }
    if (dirname(folder) === folder) break
  }
  return roots.flatMap((root) => [
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ])
})

/**
 * The scope `setup` and `doctor` work on and why: `flag` when `--scope` named it, `inferred` when
 * the HolyAgent plugin is enabled in `file`, `default` (`user`) when it is enabled nowhere.
 */
export type ResolvedScope =
  | { readonly scope: Scope; readonly source: "flag" }
  | { readonly scope: Scope; readonly source: "inferred"; readonly file: string }
  | { readonly scope: "user"; readonly source: "default" }

/**
 * The scope the HolyAgent plugin is installed at, from where `enabledPlugins` has the plugin id set
 * to `true`: Claude Code reads `local` over `project` over `user`, so the files are read in that
 * order and the first that enables the plugin wins. The files are those of {@link settingsFile}, so
 * a symlinked `project` or `local` target fails with SetupFailure as it does for a write, and a
 * file read that is not a JSON object fails naming the file. The plugin enabled nowhere gives
 * `user` as the `default`.
 */
export const installedScope = Effect.fn("installedScope")(function* (env: Env, cwd: string) {
  for (const scope of ["local", "project", "user"] as const) {
    const { file } = yield* settingsFile(env, scope, cwd)
    const plugins = (yield* readJsonObject(file))["enabledPlugins"]
    if (isJsonObject(plugins) && plugins[PLUGIN_ID] === true) {
      return { scope, source: "inferred", file } satisfies ResolvedScope
    }
  }
  return { scope: "user", source: "default" } satisfies ResolvedScope
})

/** The text that says which scope was used and where it came from, for a `scope:` report line. */
export const describeScope = (resolved: ResolvedScope): string => {
  switch (resolved.source) {
    case "flag":
      return `${resolved.scope} (from --scope)`
    case "inferred":
      return `${resolved.scope} (inferred: ${PLUGIN_ID} is enabled in ${resolved.file})`
    case "default":
      return `user (default: ${PLUGIN_ID} is not enabled in any settings file)`
  }
}
