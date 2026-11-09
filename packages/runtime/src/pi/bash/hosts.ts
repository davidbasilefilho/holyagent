import { accessSync, constants, readdirSync, statSync } from "node:fs"
import { delimiter, join, win32 } from "node:path"

import { Effect } from "effect"

/** The variables the search reads, with the names as the platform spells them. */
type Env = Readonly<Record<string, string | undefined>>

/** The value of a variable; Windows matches the name without regard to case. */
export const variable = (
  env: Env,
  name: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  const key =
    platform === "win32"
      ? Object.keys(env).find((entry) => entry.toUpperCase() === name.toUpperCase())
      : name
  const value = key === undefined ? undefined : env[key]
  return value === "" ? undefined : value
}

// A folder a program is looked up in from anywhere: rooted on POSIX, a drive or UNC path on Windows.
// A relative `PATH` entry names a place below the working directory, where a project could plant a
// program, so it is never searched.
const ROOTED = { posix: /^\//, win32: /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/ }

const splitPath = (value: string, platform: NodeJS.Platform): ReadonlyArray<string> =>
  value
    .split(platform === "win32" ? ";" : delimiter)
    .map((folder) => (platform === "win32" ? folder.replace(/^"(.*)"$/, "$1") : folder))
    .filter((folder) => ROOTED[platform === "win32" ? "win32" : "posix"].test(folder))

/**
 * The folders the shell finds host programs in: the `PATH` of the call, then the places a program
 * of a developer's machine lives that a `PATH` set by a launcher (a desktop app, a service, a
 * minimal shell) may leave out: Bun's install folder, `~/.local/bin`, mise's shims, cargo's `bin`,
 * Homebrew and the system folders. A folder `PATH` already lists keeps its place. Folders that do
 * not exist are harmless: the scan skips them.
 */
export const hostSearchFolders = (
  env: Env,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> => {
  const windows = platform === "win32"
  const home = windows
    ? (variable(env, "USERPROFILE", platform) ?? variable(env, "HOME", platform))
    : variable(env, "HOME", platform)
  const joined = windows ? win32.join : join
  const under = (base: string | undefined, ...parts: ReadonlyArray<string>) =>
    base === undefined ? [] : [joined(base, ...parts)]
  const bunInstall = variable(env, "BUN_INSTALL", platform)
  const extra = windows
    ? [
        ...under(bunInstall, "bin"),
        ...under(home, ".bun", "bin"),
        ...under(variable(env, "LOCALAPPDATA", platform), "mise", "shims"),
        ...under(variable(env, "APPDATA", platform), "npm"),
        ...under(variable(env, "ProgramFiles", platform), "Git", "cmd"),
        ...under(variable(env, "ProgramFiles", platform), "GitHub CLI"),
        ...under(variable(env, "SystemRoot", platform), "System32"),
        ...under(variable(env, "SystemRoot", platform)),
      ]
    : [
        ...under(bunInstall, "bin"),
        ...under(home, ".bun", "bin"),
        ...under(home, ".local", "bin"),
        ...under(
          variable(env, "MISE_DATA_DIR", platform) ??
            (home === undefined ? undefined : join(home, ".local", "share", "mise")),
          "shims",
        ),
        ...under(home, ".cargo", "bin"),
        "/opt/homebrew/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
      ]
  const seen = new Set<string>()
  return [...splitPath(variable(env, "PATH", platform) ?? "", platform), ...extra].filter(
    (folder) => {
      const key = windows ? folder.toLowerCase() : folder
      if (seen.has(key)) return false
      seen.add(key)
      return true
    },
  )
}

/** `PATH` for a host program: {@link hostSearchFolders} joined the way the platform joins `PATH`. */
export const hostPathValue = (env: Env, platform: NodeJS.Platform = process.platform): string =>
  hostSearchFolders(env, platform).join(platform === "win32" ? ";" : delimiter)

/** The extensions Windows runs as programs, in the order it prefers them, lowercase. */
export const programExtensions = (env: Env): ReadonlyArray<string> =>
  (variable(env, "PATHEXT", "win32") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => extension.startsWith("."))
    .map((extension) => extension.toLowerCase())

// A name the shell can register: no path separator, space or glob, and not a dotfile.
const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9._+@-]*$/

const readNames = (folder: string): ReadonlyArray<string> =>
  Effect.runSync(
    Effect.try(() => readdirSync(folder)).pipe(Effect.orElseSucceed((): Array<string> => [])),
  )

const isRunnable = (path: string, windows: boolean): boolean =>
  Effect.runSync(
    Effect.try(() => {
      if (!statSync(path).isFile()) return false
      if (!windows) accessSync(path, constants.X_OK)
      return true
    }).pipe(Effect.orElseSucceed(() => false)),
  )

/**
 * The name a person types for a directory entry, and how much `PATHEXT` prefers its extension
 * (lower is better), or `undefined` when the entry is not a program name. On POSIX the name is the
 * entry as it is. On Windows it is the entry without its extension, in lowercase, and the entry
 * needs one of the `extensions`.
 */
export const programName = (
  entry: string,
  platform: NodeJS.Platform,
  extensions: ReadonlyArray<string>,
): { readonly name: string; readonly rank: number } | undefined => {
  if (platform !== "win32") return COMMAND_NAME.test(entry) ? { name: entry, rank: 0 } : undefined
  const dot = entry.lastIndexOf(".")
  const rank = extensions.indexOf(dot < 0 ? "" : entry.slice(dot).toLowerCase())
  const name = entry.slice(0, dot < 0 ? entry.length : dot).toLowerCase()
  return rank < 0 || !COMMAND_NAME.test(name) ? undefined : { name, rank }
}

/**
 * The programs in some folders, by the name a person types: the first folder that has a name wins.
 * On POSIX a program is a regular file the user may execute. On Windows it is a file with one of
 * the `extensions` (`PATHEXT`), and the extension that comes first in `PATHEXT` wins within a
 * folder (see {@link programName}).
 */
export const scanHostPrograms = (
  folders: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
  extensions: ReadonlyArray<string> = [],
): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.sync(() => {
    const windows = platform === "win32"
    const found = new Map<string, string>()
    for (const folder of folders) {
      const here = new Map<string, { readonly path: string; readonly rank: number }>()
      for (const entry of readNames(folder)) {
        const named = programName(entry, platform, extensions)
        if (named === undefined || found.has(named.name)) continue
        const best = here.get(named.name)
        const path = windows ? win32.join(folder, entry) : join(folder, entry)
        if ((best === undefined || named.rank < best.rank) && isRunnable(path, windows))
          here.set(named.name, { path, rank: named.rank })
      }
      for (const [name, { path }] of here) found.set(name, path)
    }
    return found
  })
