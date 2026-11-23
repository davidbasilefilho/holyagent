import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { Effect } from "effect"

import { fileSystem } from "../ports/filesystem.ts"
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
  fileSystem.pipe(
    Effect.flatMap((fs) => Effect.tryPromise(() => fs.realpath(path))),
    Effect.orElseSucceed(() => undefined),
  )

/** Whether anything (a folder, or the file a linked worktree has) exists at `path`. */
const present = (path: string) =>
  fileSystem.pipe(
    Effect.flatMap((fs) => Effect.tryPromise(() => fs.lstat(path))),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

/**
 * The device and inode of the entry at `path`, read without following a symlink, or undefined when
 * it cannot be inspected (missing, say). Two paths with the same identity are the same file.
 */
const identity = (path: string) =>
  fileSystem.pipe(
    Effect.flatMap((fs) => Effect.tryPromise(() => fs.lstat(path, { bigint: true }))),
    Effect.map((stats) => `${stats.dev}:${stats.ino}`),
    Effect.orElseSucceed(() => undefined),
  )

/**
 * Whether the entry at `path` is itself a symlink; a missing entry is not. Fails with SetupFailure
 * when the entry cannot be inspected.
 */
export const isSymlink = (path: string) =>
  fileSystem.pipe(
    Effect.flatMap((fs) =>
      Effect.tryPromise({
        try: () => fs.lstat(path),
        catch: (cause) => cause as NodeJS.ErrnoException,
      }),
    ),
    Effect.map((stats) => stats.isSymbolicLink()),
    Effect.catch((error) =>
      error.code === "ENOENT" || error.code === "ENOTDIR"
        ? Effect.succeed(false)
        : Effect.fail(new SetupFailure({ message: `cannot inspect ${path}: ${error.message}` })),
    ),
  )

/**
 * Refuses a symlinked folder, folder below it or file on the way from `cwd` to `file` at project
 * and local scope, so a repository cannot redirect a write (or an `--undo`) to a file outside the
 * project, as the Claude settings step does for `.claude`. Scope `user` follows its links, as
 * before. `action` names what was refused, in the message.
 */
export const refuseLinks = Effect.fn("refuseProjectLinks")(function* (
  cwd: string,
  scope: Scope,
  file: string,
  action: string,
) {
  if (scope === "user") return
  const parts = relative(cwd, file).split(sep)
  for (let depth = 1; depth <= parts.length; depth++) {
    const path = join(cwd, ...parts.slice(0, depth))
    if (yield* isSymlink(path)) {
      return yield* new SetupFailure({
        message: `${path} is a symlink; refusing to ${action} through it in the ${scope} scope. Replace it with a real ${depth === parts.length ? "file" : "folder"} and run again`,
      })
    }
  }
})

/**
 * Where `holyagent setup` and `doctor` read and write the settings of a scope: the `file`, and a
 * `notice` line when the answer is not the usual one.
 */
export interface SettingsTarget {
  readonly file: string
  readonly notice?: string
}

/**
 * The folder `project` and `local` settings live in: its `.claude` folder, the `root` that holds
 * it, whether that root is a `trusted` git work tree top-level, and a notice when it is not the
 * usual one.
 */
const claudeFolder = Effect.fn("claudeFolder")(function* (cwd: string) {
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
  return { folder: join(root, ".claude"), root, trusted, notice }
})

/** The settings file name of a `project` or `local` scope. */
const fileName = (scope: "project" | "local") =>
  scope === "project" ? "settings.json" : "settings.local.json"

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
  const { folder, notice } = yield* claudeFolder(cwd)
  const file = join(folder, fileName(scope))
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
 * the user's own untracked `local` settings `file` enable the plugin, `default` (`user`) otherwise.
 * A default carries `notices`, extra report lines for what the search found.
 */
export type ResolvedScope =
  | { readonly scope: Scope; readonly source: "flag" }
  | { readonly scope: "local"; readonly source: "inferred"; readonly file: string }
  | { readonly scope: "user"; readonly source: "default"; readonly notices: ReadonlyArray<string> }

/** What a settings file says about the plugin, read for scope inference only. */
type Enablement = "enabled" | "disabled" | "unset" | "symlink"

/**
 * Whether the settings file in `folder` sets the plugin id in `enabledPlugins` to true (`enabled`),
 * to false (`disabled`) or neither (`unset`). A symlinked folder or file is not read (`symlink`): a
 * repository must not steer the scope through a link, and inference needs no write. A file that is
 * not a JSON object fails with SetupFailure naming it.
 */
const enablement = Effect.fn("enablement")(function* (folder: string, file: string) {
  if ((yield* isSymlink(folder)) || (yield* isSymlink(file))) return "symlink" as const
  const plugins = (yield* readJsonObject(file))["enabledPlugins"]
  const value = isJsonObject(plugins) ? plugins[PLUGIN_ID] : undefined
  return (value === true ? "enabled" : value === false ? "disabled" : "unset") satisfies Enablement
})

/**
 * Why a settings `file` of the trusted work tree `root` may have come with the repository, or
 * undefined when git leaves it to the user: no index entry names it or the `.claude` folder above
 * it, and `folder` is no other repository's work tree. Fails closed: when git cannot answer
 * (missing or failing, say), the reason says so and the file is not taken for the user's.
 *
 * The index entries are listed for the folder as a whole, not for the file alone, because a
 * repository can commit `.claude` as a submodule (a gitlink entry, whose checkout holds the file
 * while `git ls-files` for the file prints nothing) and, on a case-insensitive file system, a
 * tracked `Settings.Local.json` is read as the file though the literal name misses it. The names
 * are compared without case. Folding beyond letter case (Unicode equivalents, ignorable code
 * points, a trailing dot or space, a Windows 8.3 short name) is caught by identity: a tracked entry
 * that exists on disk with the device and inode of the file is the file, and a tracked top-level
 * entry with the device and inode of the `.claude` folder is the folder, so the repository controls
 * the file. Each distinct top-level name is inspected once, stopping at a match.
 *
 * Known limit: an archive that ships its own `.git` with an index that omits the file still counts
 * as untracked, since the index is all git has to say. Pass `--scope` to choose a scope then.
 *
 * The identity comparison runs only on index entries under the `.claude` prefix, so a tracked path
 * such as `link/settings.local.json` that reaches the file through a symlinked folder is not
 * compared. Git does not write through symlinks, so only a hand-crafted index or a git bug produces
 * such an entry; statting every tracked file to close the gap would cost a stat per index entry.
 */
const repositoryControl = Effect.fn("repositoryControl")(function* (
  root: string,
  folder: string,
  file: string,
) {
  const shell = yield* Shell
  const name = relative(root, file).split(sep).join("/")
  const folderName = relative(root, folder).split(sep).join("/")
  const listed = yield* shell.run("git", ["ls-files", "--cached", "-z"], { cwd: root })
  if (listed.exitCode !== 0) return "git could not say whether it tracks it"
  const everything = listed.stdout.split("\0").filter((entry) => entry !== "")
  const lowerFolder = folderName.toLowerCase()
  const tracked = everything.filter((entry) => {
    const lower = entry.toLowerCase()
    return lower === lowerFolder || lower.startsWith(`${lowerFolder}/`)
  })
  const entries = tracked.map((entry) => entry.toLowerCase())
  if (entries.includes(name.toLowerCase())) return "git tracks it"
  if (entries.includes(lowerFolder)) return `git tracks ${folderName} itself`
  const own = yield* identity(file)
  if (own !== undefined) {
    for (const entry of tracked) {
      if ((yield* identity(join(root, entry))) === own) return "git tracks it"
    }
  }
  const home = yield* identity(folder)
  if (home !== undefined) {
    const seen = new Set<string>()
    for (const entry of everything) {
      const component = entry.split("/")[0] ?? entry
      if (component === folderName || seen.has(component)) continue
      seen.add(component)
      if ((yield* identity(join(root, component))) === home)
        return `git tracks ${component} as ${folderName}`
    }
  }
  const top = yield* shell.run("git", ["rev-parse", "--show-toplevel"], { cwd: folder })
  const named = top.stdout.trim()
  if (top.exitCode !== 0 || named === "") return "git could not say whether it tracks it"
  const [there, here] = [yield* real(named), yield* real(root)]
  return there !== undefined && there === here
    ? undefined
    : `${folderName} is inside another git repository`
})

/**
 * The scope `setup` and `doctor` use without `--scope`. Only the user's own uncommitted
 * `.claude/settings.local.json` moves it off `user`: when that file sets the plugin to `true`, the
 * folder is a git work tree that `claudeFolder` trusts, and the file is untracked (see
 * `repositoryControl`: no index entry for the file or `.claude`, in any letter case, none that is
 * the same file by device and inode, no top-level entry that is the `.claude` folder by device and
 * inode, and `.claude` is no other repository), the scope is `local`. An enabled file in a folder
 * that is not a trusted git work tree (a source archive, say) or that git tracks might have come
 * with a cloned repository, so the scope stays `user` and a notice names the file and `--scope
 * local`. An archive that ships its own `.git` with an index that omits the file still counts as
 * untracked. An explicit `false` there means the plugin is disabled for this project, so the search
 * stops and `user` is used with a notice saying so. A committed `.claude/settings.json` that
 * enables the plugin never selects a scope, because a cloned repository must not choose where setup
 * writes or which registry a Pi install reads; the notice names the file and `--scope project`. A
 * symlinked `local` or `project` file is not read, with a notice for `local`. A `local` file that
 * is not a JSON object fails with SetupFailure naming it; a bad `project` file is ignored.
 */
export const installedScope = Effect.fn("installedScope")(function* (cwd: string) {
  const { folder, root, trusted } = yield* claudeFolder(cwd)
  const local = join(folder, fileName("local"))
  const project = join(folder, fileName("project"))
  const notices: Array<string> = []
  const found = yield* enablement(folder, local)
  if (found === "enabled") {
    const reason = trusted
      ? yield* repositoryControl(root, folder, local)
      : "the folder is not a trusted git work tree"
    if (reason === undefined) {
      return { scope: "local", source: "inferred", file: local } satisfies ResolvedScope
    }
    notices.push(
      `${local} enables HolyAgent but ${reason}, so it is not taken for your own uncommitted file; using user; --scope local targets it`,
    )
  }
  if (found === "disabled") {
    notices.push(
      `${PLUGIN_ID} is set to false in ${local}, so HolyAgent is disabled for this project; using user`,
    )
  } else {
    if (found === "symlink") notices.push(`${local} is a symlink and was not read; using user`)
    const shared = yield* enablement(folder, project).pipe(
      Effect.orElseSucceed(() => "unset" as const),
    )
    if (shared === "enabled") {
      notices.push(`the repository enables HolyAgent in ${project}; --scope project targets it`)
    }
  }
  return { scope: "user", source: "default", notices } satisfies ResolvedScope
})

/** The extra report lines of a resolved scope: what the search found beyond the scope itself. */
export const scopeNotices = (resolved: ResolvedScope): ReadonlyArray<string> =>
  resolved.source === "default" ? resolved.notices : []

/** The text that says which scope was used and where it came from, for a `scope:` report line. */
export const describeScope = (resolved: ResolvedScope): string => {
  switch (resolved.source) {
    case "flag":
      return `${resolved.scope} (from --scope)`
    case "inferred":
      return `${resolved.scope} (inferred: ${PLUGIN_ID} is enabled in ${resolved.file})`
    case "default":
      return "user (default)"
  }
}
