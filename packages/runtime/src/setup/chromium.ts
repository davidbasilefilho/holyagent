import { existsSync, readdirSync } from "node:fs"
import { posix, win32 } from "node:path"

import { Effect } from "effect"

import { type Env, firstNonEmpty } from "./environment.ts"

/** The environment variable in which the person can name the Chromium executable to use. */
export const CHROMIUM_EXECUTABLE_VARIABLE = "HOLYAGENT_CHROMIUM_PATH"

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
 * The Chromium executable the machine already provides, which `holyagent browser-server` starts
 * headless for the browser-use MCP server, or `undefined` when there is none. In order: the path
 * the person set in {@link CHROMIUM_EXECUTABLE_VARIABLE}; the `chromium` entry or the newest
 * `chromium-<revision>` build in `PLAYWRIGHT_BROWSERS_PATH` when it names a folder (Playwright
 * itself looks nowhere else then), else in {@link PREINSTALLED_BROWSERS}. It only looks at the file
 * system; `exists` and `list` replace that for a test. Paths are joined the way `platform` joins
 * them (the machine's by default), whatever the host is.
 */
export const findChromium = (
  env: Env,
  platform: string = process.platform,
  exists: (path: string) => boolean = existsSync,
  list: (folder: string) => ReadonlyArray<string> = safeList,
): string | undefined => {
  const given = firstNonEmpty(env[CHROMIUM_EXECUTABLE_VARIABLE])
  if (given !== undefined) return given
  const configured = firstNonEmpty(env["PLAYWRIGHT_BROWSERS_PATH"])
  return inFolder(
    configured === undefined || configured === "0" ? PREINSTALLED_BROWSERS : configured,
    platform,
    exists,
    list,
  )
}
