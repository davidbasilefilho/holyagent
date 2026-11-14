import { existsSync, readdirSync } from "node:fs"
import { posix, win32 } from "node:path"

import { Effect, Option } from "effect"

import type { nodeFileSystem } from "../ports/filesystem.ts"
import { type Env, firstNonEmpty } from "./environment.ts"
import { findCommand, whichWith } from "./shell.ts"

/** The environment variable in which the person can name the Chromium executable to use. */
export const CHROMIUM_EXECUTABLE_VARIABLE = "HOLYAGENT_CHROMIUM_PATH"

/**
 * The old name of {@link CHROMIUM_EXECUTABLE_VARIABLE}, from when the Playwright MCP server took
 * the executable: still read when the new one is unset, so a machine set up for it keeps working.
 */
export const LEGACY_CHROMIUM_EXECUTABLE_VARIABLE = "PLAYWRIGHT_MCP_EXECUTABLE_PATH"

/**
 * The folder where the images of cloud sessions preinstall Playwright's browsers, whose `chromium`
 * entry is the Chromium executable (or a link to it), and the folder of the Chromium build it came
 * from (`chromium-<revision>`).
 */
export const PREINSTALLED_BROWSERS = "/opt/pw-browsers"

// Where Playwright puts the executable inside a `chromium-<revision>` folder, by platform.
const BUILD_EXECUTABLES: Readonly<Record<string, ReadonlyArray<string>>> = {
  linux: ["chrome-linux64/chrome", "chrome-linux/chrome"],
  darwin: [
    "chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: ["chrome-win64/chrome.exe", "chrome-win/chrome.exe"],
}

// The path functions of the platform the executable is looked up for, not the host's, so a path is
// joined with the separator that platform uses wherever HolyAgent runs.
const pathsOf = (platform: string) => (platform === "win32" ? win32 : posix)

const revisionOf = (name: string): number =>
  Number(/^chromium-(\d+)$/.exec(name)?.[1] ?? Number.NaN)

const inFolder = (
  folder: string,
  platform: string,
  exists: (path: string) => boolean,
  list: (folder: string) => ReadonlyArray<string>,
): string | undefined => {
  const { join } = pathsOf(platform)
  const entry = join(folder, "chromium")
  if (exists(entry)) return entry
  const builds = list(folder)
    .filter((name) => Number.isFinite(revisionOf(name)))
    .toSorted((a, b) => revisionOf(b) - revisionOf(a))
  for (const build of builds)
    for (const executable of BUILD_EXECUTABLES[platform] ?? BUILD_EXECUTABLES["linux"] ?? []) {
      const path = join(folder, build, ...executable.split("/"))
      if (exists(path)) return path
    }
  return undefined
}

const safeList = (folder: string): ReadonlyArray<string> =>
  Effect.runSync(
    Effect.try(() => readdirSync(folder)).pipe(Effect.orElseSucceed((): Array<string> => [])),
  )

/**
 * The Chromium path the person configured and the variable it came from:
 * {@link CHROMIUM_EXECUTABLE_VARIABLE}, else {@link LEGACY_CHROMIUM_EXECUTABLE_VARIABLE}; an empty
 * variable counts as unset.
 */
export const configuredChromium = (
  env: Env,
): { readonly variable: string; readonly path: string } | undefined => {
  for (const variable of [CHROMIUM_EXECUTABLE_VARIABLE, LEGACY_CHROMIUM_EXECUTABLE_VARIABLE]) {
    const path = firstNonEmpty(env[variable])
    if (path !== undefined) return { variable, path }
  }
  return undefined
}

/**
 * The executable a bare command name (no path separator) stands for on the environment's `PATH`, or
 * `undefined` when none is there.
 */
const onPath = (command: string, env: Env): string | undefined =>
  Option.getOrUndefined(findCommand(env, command))

// The executable the person configured, or `undefined` when it is missing. A path with a separator
// must exist as given; a bare command name such as `chromium` is looked up on the PATH, the way a
// shell would start it.
const resolveConfigured = (
  given: string,
  env: Env,
  exists: (path: string) => boolean,
  which: (command: string, env: Env) => string | undefined,
): string | undefined =>
  /[\\/]/.test(given) ? (exists(given) ? given : undefined) : which(given, env)

/**
 * The Chromium executable the machine already provides, which `holyagent browser-server` starts
 * headless for the browser-use MCP server, or `undefined` when there is none. In order: the path
 * the person set in {@link CHROMIUM_EXECUTABLE_VARIABLE}, else in the old
 * {@link LEGACY_CHROMIUM_EXECUTABLE_VARIABLE}, which must exist, or, as a bare command name such as
 * `chromium`, be found on the `PATH` (it then resolves to that file); a configured one that is
 * missing is no Chromium, and no other one the person did not choose stands in for it, see
 * {@link chromiumFixFor}; the `chromium` entry or the newest `chromium-<revision>` build in
 * `PLAYWRIGHT_BROWSERS_PATH` when it names a folder (Playwright itself looks nowhere else then),
 * else in {@link PREINSTALLED_BROWSERS}. It only looks at the file system and the `PATH`; `exists`,
 * `list` and `which` replace that for a test. Paths are joined the way `platform` joins them (the
 * machine's by default), whatever the host is.
 */
export const findChromium = (
  env: Env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
  list: (folder: string) => ReadonlyArray<string> = safeList,
  which: (command: string, env: Env) => string | undefined = onPath,
): string | undefined => {
  const given = configuredChromium(env)
  if (given !== undefined) return resolveConfigured(given.path, env, exists, which)
  const configured = firstNonEmpty(env["PLAYWRIGHT_BROWSERS_PATH"])
  return inFolder(
    configured === undefined || configured === "0" ? PREINSTALLED_BROWSERS : configured,
    platform,
    exists,
    list,
  )
}

/** Finds Chromium through a trusted host filesystem rather than the default filesystem. */
export const findChromiumWith = (fs: typeof nodeFileSystem, env: Env, platform: string) => {
  const list = (folder: string): ReadonlyArray<string> =>
    Effect.runSync(
      Effect.try(() => fs.readdirSync(folder)).pipe(Effect.orElseSucceed((): Array<string> => [])),
    )
  const lookup = (command: string, currentEnv: Env) =>
    Option.getOrUndefined(
      findCommand(currentEnv, command, undefined, (name, options) => whichWith(fs, name, options)),
    )
  return findChromium(env, platform, fs.existsSync, list, lookup)
}

/** Describes a missing configured Chromium using the trusted filesystem. */
export const chromiumFixWith = (fs: typeof nodeFileSystem, env: Env, fix: string) => {
  const lookup = (command: string, currentEnv: Env) =>
    Option.getOrUndefined(
      findCommand(currentEnv, command, undefined, (name, options) => whichWith(fs, name, options)),
    )
  return chromiumFixFor(env, fix, fs.existsSync, lookup)
}

/**
 * How the person gets a Chromium, as `fix` says, led by what is wrong with the path they configured
 * when {@link findChromium} rejected it because the file does not exist or, for a bare command name,
 * is not on the `PATH`.
 */
export const chromiumFixFor = (
  env: Env,
  fix: string,
  exists: (path: string) => boolean = existsSync,
  which: (command: string, env: Env) => string | undefined = onPath,
): string => {
  const given = configuredChromium(env)
  return given === undefined || resolveConfigured(given.path, env, exists, which) !== undefined
    ? fix
    : `${given.variable} is set to ${given.path}, which does not exist; ${fix}`
}
