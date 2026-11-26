import { constants } from "node:fs"
import { posix, win32 } from "node:path"

import { Effect, Schema } from "effect"

import { fileSystem } from "../ports/filesystem.ts"
import { browserDirectories } from "./browse.ts"
import { type Env, homeDirectory } from "./environment.ts"
import { Shell } from "./shell.ts"

/** Local evidence for a browser, separate from extension installation and live pairing. */
export interface DetectedBrowser {
  readonly id: string
  readonly name: string
  readonly family: "chromium" | "gecko" | "unknown"
  readonly browseCompatibility: "supported" | "unverified" | "unsupported"
  readonly source: "registry" | "known-path" | "path" | "profile" | "manual"
  /** An existing executable-shaped file; a profile alone never supplies this field. */
  readonly executable?: string
  /** The standard user-data root for this browser when known, not necessarily a configured profile. */
  readonly profileDirectory?: string
}

interface Browser {
  readonly id: string
  readonly name: string
  readonly family?: "gecko"
  readonly winInstall?: readonly string[]
  readonly clients?: readonly string[]
  readonly winExe?: readonly string[]
  readonly app?: string
  readonly macExe?: string
  readonly commands?: readonly string[]
}

const BROWSERS: readonly Browser[] = [
  {
    id: "chrome",
    name: "Google Chrome",
    clients: ["Google Chrome", "Chrome"],
    winExe: ["chrome.exe"],
    winInstall: ["Google/Chrome/Application/chrome.exe"],
    app: "Google Chrome",
    commands: ["google-chrome", "google-chrome-stable"],
  },
  {
    id: "chrome-beta",
    name: "Google Chrome Beta",
    clients: ["Google Chrome Beta", "Chrome Beta"],
    winExe: ["chrome.exe"],
    winInstall: ["Google/Chrome Beta/Application/chrome.exe"],
    app: "Google Chrome Beta",
    commands: ["google-chrome-beta"],
  },
  {
    id: "chrome-canary",
    name: "Google Chrome Canary",
    clients: ["Google Chrome Canary", "Chrome Canary"],
    winExe: ["chrome.exe"],
    winInstall: ["Google/Chrome SxS/Application/chrome.exe"],
    app: "Google Chrome Canary",
  },
  { id: "chrome-unstable", name: "Google Chrome Unstable", commands: ["google-chrome-unstable"] },
  {
    id: "chromium",
    name: "Chromium",
    clients: ["Chromium"],
    winExe: ["chromium.exe", "chrome.exe"],
    winInstall: ["Chromium/Application/chrome.exe"],
    app: "Chromium",
    commands: ["chromium", "chromium-browser"],
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    clients: ["Microsoft Edge", "MSEdge"],
    winExe: ["msedge.exe"],
    winInstall: ["Microsoft/Edge/Application/msedge.exe"],
    app: "Microsoft Edge",
    commands: ["microsoft-edge", "microsoft-edge-stable"],
  },
  {
    id: "brave",
    name: "Brave",
    clients: ["Brave", "Brave Browser", "BraveSoftware.Brave-Browser"],
    winExe: ["brave.exe"],
    winInstall: ["BraveSoftware/Brave-Browser/Application/brave.exe"],
    app: "Brave Browser",
    commands: ["brave", "brave-browser"],
  },
  {
    id: "opera",
    name: "Opera",
    clients: ["Opera", "OperaStable"],
    winExe: ["opera.exe", "launcher.exe"],
    winInstall: [
      "Programs/Opera/opera.exe",
      "Programs/Opera/launcher.exe",
      "Opera/opera.exe",
      "Opera/launcher.exe",
    ],
    app: "Opera",
    commands: ["opera"],
  },
  {
    id: "vivaldi",
    name: "Vivaldi",
    clients: ["Vivaldi"],
    winExe: ["vivaldi.exe"],
    winInstall: ["Vivaldi/Application/vivaldi.exe"],
    app: "Vivaldi",
    commands: ["vivaldi", "vivaldi-stable"],
  },
  // Windows Helium intentionally ships chrome.exe under its branded install directory.
  {
    id: "helium",
    name: "Helium",
    clients: ["Helium"],
    winExe: ["helium.exe", "chrome.exe"],
    winInstall: ["imput/Helium/Application/chrome.exe"],
    app: "Helium",
    commands: ["helium", "helium-browser"],
  },
  { id: "arc", name: "Arc", clients: ["Arc"], winExe: ["Arc.exe"], app: "Arc" },
  {
    id: "firefox",
    name: "Firefox",
    family: "gecko",
    clients: ["Firefox", "FirefoxURL"],
    winExe: ["firefox.exe"],
    winInstall: ["Mozilla Firefox/firefox.exe", "Programs/Mozilla Firefox/firefox.exe"],
    app: "Firefox",
    macExe: "firefox",
    commands: ["firefox", "firefox-esr"],
  },
  {
    id: "librewolf",
    name: "LibreWolf",
    family: "gecko",
    clients: ["LibreWolf"],
    winExe: ["librewolf.exe"],
    commands: ["librewolf"],
  },
  {
    id: "waterfox",
    name: "Waterfox",
    family: "gecko",
    clients: ["Waterfox"],
    winExe: ["waterfox.exe"],
    commands: ["waterfox"],
  },
]

const envOf = (env: Env, name: string, windows: boolean) =>
  env[name] ??
  (windows
    ? Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
    : undefined)

// Do not stat UNC shares or drive-relative paths discovered in third-party settings.
const localPath = (value: string, windows: boolean): string | undefined => {
  if (Array.from(value).some((char) => (char.codePointAt(0) ?? 0) < 0x20)) return undefined
  if (windows)
    return /^[a-z]:[/\\]/i.test(value) && !value.includes('"') ? win32.normalize(value) : undefined
  return value.startsWith("/") ? posix.normalize(value) : undefined
}

const checkFile = (path: string, executable: boolean, windows: boolean) =>
  Effect.gen(function* () {
    const fs = yield* fileSystem
    const metadata = yield* Effect.tryPromise(() => fs.stat(path))
    if (!metadata.isFile() || (executable && metadata.size === 0)) return false
    if (executable && !windows) yield* Effect.try(() => fs.accessSync(path, constants.X_OK))
    return true
  }).pipe(Effect.orElseSucceed(() => false))

const oneFile = (paths: readonly string[], windows: boolean) =>
  Effect.findFirst([...new Set(paths)], (path) => checkFile(path, true, windows))

const profileRoot = (browser: Browser, env: Env, platform: string) => {
  const windows = platform === "win32"
  const home = envOf(env, windows ? "USERPROFILE" : "HOME", windows) ?? homeDirectory(env)
  if (browser.id === "firefox") {
    if (windows)
      return localPath(
        win32.join(
          envOf(env, "APPDATA", true) ?? win32.join(home, "AppData", "Roaming"),
          "Mozilla",
          "Firefox",
        ),
        true,
      )
    return localPath(
      posix.join(
        home,
        platform === "darwin" ? "Library/Application Support/Firefox" : ".mozilla/firefox",
      ),
      false,
    )
  }
  const profileEnv = windows
    ? {
        ...env,
        HOME: home,
        LOCALAPPDATA: envOf(env, "LOCALAPPDATA", true),
        APPDATA: envOf(env, "APPDATA", true),
      }
    : env
  const directory = browserDirectories(profileEnv, platform).find(
    ({ name }) => name === browser.name,
  )?.directory
  return directory === undefined
    ? undefined
    : localPath(
        !windows && process.platform === "win32" ? directory.replaceAll("\\", "/") : directory,
        windows,
      )
}

const compatibility = (
  browser: Browser,
  platform: string,
  profileDirectory: string | undefined,
): DetectedBrowser["browseCompatibility"] =>
  browser.family === "gecko"
    ? "unsupported"
    : (browser.id === "helium" && platform === "win32") || profileDirectory === undefined
      ? "unverified"
      : "supported"

const evidence = (
  browser: Browser,
  source: DetectedBrowser["source"],
  platform: string,
  profileDirectory: string | undefined,
  executable?: string,
): DetectedBrowser => ({
  id: browser.id,
  name: browser.name,
  family: browser.family ?? "chromium",
  source,
  browseCompatibility: compatibility(browser, platform, profileDirectory),
  ...(profileDirectory === undefined ? {} : { profileDirectory }),
  ...(executable === undefined ? {} : { executable }),
})

const knownPaths = (browser: Browser, env: Env, platform: string): readonly string[] => {
  const home = homeDirectory(env)
  if (platform === "win32") {
    const user = envOf(env, "USERPROFILE", true) ?? home
    const programRoots = [
      envOf(env, "LOCALAPPDATA", true) ?? win32.join(user, "AppData", "Local"),
      ...["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"].map((name) =>
        envOf(env, name, true),
      ),
    ]
    return programRoots.flatMap((root) =>
      root !== undefined && localPath(root, true) !== undefined
        ? (browser.winInstall ?? []).map((rest) => win32.join(root, rest))
        : [],
    )
  }
  if (platform === "darwin" && browser.app !== undefined) {
    const app = browser.app
    return ["/Applications", posix.join(home, "Applications")]
      .filter(posix.isAbsolute)
      .map((root) => posix.join(root, `${app}.app`, "Contents/MacOS", browser.macExe ?? app))
  }
  if (platform === "linux")
    return ["/usr/bin", "/usr/local/bin"].flatMap((root) =>
      (browser.commands ?? []).map((command) => posix.join(root, command)),
    )
  return []
}

const uniqueWinNames = (browser: Browser) =>
  (browser.winExe ?? []).filter(
    (exe) =>
      exe.toLowerCase() !== "launcher.exe" &&
      BROWSERS.filter((candidate) => candidate.winExe?.includes(exe)).length === 1,
  )
const pathsOnPath = (browser: Browser, env: Env, windows: boolean) => {
  const pathApi = windows ? win32 : posix
  const names = windows ? uniqueWinNames(browser) : (browser.commands ?? [])
  return (envOf(env, "PATH", windows) ?? "").split(pathApi.delimiter).flatMap((entry) => {
    const root = localPath(entry, windows)
    return root === undefined ? [] : names.map((exe) => pathApi.join(root, exe))
  })
}

const Clients = "SOFTWARE\\Clients\\StartMenuInternet"
const AppPaths = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths"
const hives = ["HKEY_CURRENT_USER", "HKEY_LOCAL_MACHINE"] as const
const RegistryValue = Schema.String.check(Schema.isPattern(/^\s*.+?\s+REG_(?:EXPAND_)?SZ\s+.+$/i))
const registryExecutable = (stdout: string, env: Env): string | undefined => {
  for (const line of stdout.split(/\r?\n/)) {
    if (!Schema.is(RegistryValue)(line)) continue
    const match = /\sREG_(EXPAND_)?SZ\s+(.+)$/i.exec(line)
    let command = match?.[2]?.trim()
    if (command === undefined) continue
    if (match?.[1] !== undefined)
      command = command.replaceAll(
        /%([^%]+)%/g,
        (raw, name: string) => envOf(env, name, true) ?? raw,
      )
    // Read the executable part only. The registered command and its arguments are never run.
    const parsed = /^(?:"([^"]+\.exe)"|([^"\r\n]+?\.exe))(?:\s|$)/i.exec(command)
    const exe = parsed?.[1] ?? parsed?.[2]
    if (exe !== undefined) return localPath(exe, true)
  }
  return undefined
}

const windowsRegistrations = Effect.fn("windowsRegistrations")(function* (env: Env) {
  const root = envOf(env, "SystemRoot", true) ?? envOf(env, "WINDIR", true)
  const local = root === undefined ? undefined : localPath(root, true)
  if (local === undefined) return new Map<string, string>()
  const reg = win32.join(local, "System32", "reg.exe")
  if (!(yield* checkFile(reg, true, true))) return new Map<string, string>()
  const shell = yield* Shell
  const views = ["/reg:64", "/reg:32"] as const
  const query = (key: string, view: string, value: boolean) =>
    shell
      .run(reg, ["query", key, ...(value ? ["/ve"] : []), view], { cwd: local })
      .pipe(Effect.map(({ exitCode, stdout }) => (exitCode === 0 ? stdout : "")))
  const registered = new Map<string, string>()
  const roots = hives.flatMap((hive) => views.map((view) => ({ hive, view })))
  const all = yield* Effect.forEach(
    roots,
    ({ hive, view }) =>
      query(`${hive}\\${Clients}`, view, false).pipe(Effect.map((text) => ({ hive, view, text }))),
    { concurrency: 4 },
  )
  for (const { hive, view, text } of all) {
    const prefix = `${hive}\\${Clients}\\`
    const children = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.toLowerCase().startsWith(prefix.toLowerCase()))
      .map((line) => line.slice(prefix.length))
      .filter((child) => /^[\w .-]{1,80}$/.test(child))
    const chosen = children.flatMap((client) => {
      const name = client.toLowerCase()
      const browser = BROWSERS.find(({ clients }) =>
        clients?.some((entry) => {
          const registeredName = entry.toLowerCase()
          if (name === registeredName) return true
          return (
            name.startsWith(registeredName + "-") &&
            /^[a-f\d]{6,}$/i.test(name.slice(registeredName.length + 1))
          )
        }),
      )
      return browser === undefined || registered.has(browser.id) ? [] : [{ client, browser }]
    })
    const verified = yield* Effect.forEach(
      chosen,
      ({ client, browser }) =>
        Effect.gen(function* () {
          const output = yield* query(`${prefix}${client}\\shell\\open\\command`, view, true)
          const path = registryExecutable(output, env)
          return path !== undefined &&
            browser.winExe?.some(
              (exe) => exe.toLowerCase() === win32.basename(path).toLowerCase(),
            ) &&
            (yield* checkFile(path, true, true))
            ? { id: browser.id, path }
            : undefined
        }),
      { concurrency: 4 },
    )
    for (const entry of verified)
      if (entry !== undefined && !registered.has(entry.id)) registered.set(entry.id, entry.path)
  }
  // App Paths is optional. Query only these explicit names, and never attribute the shared name
  // chrome.exe to one browser without its brand-specific installation directory.
  const missing = BROWSERS.filter((browser) => !registered.has(browser.id))
  const appNames = ["chrome.exe", "firefox.exe", "helium.exe"].filter((exe) =>
    missing.some(({ winExe }) => winExe?.includes(exe)),
  )
  const appResults = yield* Effect.forEach(
    roots.flatMap(({ hive, view }) => appNames.map((exe) => ({ hive, view, exe }))),
    ({ hive, view, exe }) =>
      query(`${hive}\\${AppPaths}\\${exe}`, view, true).pipe(
        Effect.map((stdout) => ({ exe, path: registryExecutable(stdout, env) })),
      ),
    { concurrency: 4 },
  )
  for (const { exe, path } of appResults) {
    if (
      path === undefined ||
      win32.basename(path).toLowerCase() !== exe ||
      !(yield* checkFile(path, true, true))
    )
      continue
    const browser = missing.find(
      (candidate) =>
        uniqueWinNames(candidate).includes(exe) ||
        candidate.winInstall?.some((suffix) =>
          path.toLowerCase().endsWith(`\\${win32.normalize(suffix).toLowerCase()}`),
        ),
    )
    if (browser !== undefined && !registered.has(browser.id)) registered.set(browser.id, path)
  }
  return registered
})

/**
 * Detect common and registered local browsers, without opening them or traversing installation or
 * profile trees.
 */
export const discoverBrowsers = Effect.fn("discoverBrowsers")(function* (
  env: Env,
  platform: string = process.platform,
): Effect.fn.Return<ReadonlyArray<DetectedBrowser>, never, Shell> {
  const windows = platform === "win32"
  const path = windows ? win32 : posix
  if (!windows && platform !== "linux" && platform !== "darwin") return []
  const registry = windows ? yield* windowsRegistrations(env) : new Map<string, string>()
  const browsers = yield* Effect.forEach(
    BROWSERS,
    (browser) =>
      Effect.gen(function* () {
        const profileDirectory = profileRoot(browser, env, platform)
        const registered = registry.get(browser.id)
        if (registered !== undefined)
          return evidence(browser, "registry", platform, profileDirectory, registered)
        const known = yield* oneFile(knownPaths(browser, env, platform), windows)
        if (known._tag === "Some")
          return evidence(browser, "known-path", platform, profileDirectory, known.value)
        const resolved = yield* oneFile(pathsOnPath(browser, env, windows), windows)
        if (resolved._tag === "Some")
          return evidence(browser, "path", platform, profileDirectory, resolved.value)
        if (profileDirectory === undefined) return undefined
        const markers =
          browser.family === "gecko" ? ["profiles.ini"] : ["Local State", "Default/Preferences"]
        for (const marker of markers)
          if (yield* checkFile(path.join(profileDirectory, marker), false, windows))
            return evidence(browser, "profile", platform, profileDirectory)
        return undefined
      }),
    { concurrency: 4 },
  )
  return browsers.filter((browser) => browser !== undefined)
})

/**
 * Check one manually selected local file without launching it. A generic filename never proves the
 * browser brand.
 */
export const checkBrowserExecutable = Effect.fn("checkBrowserExecutable")(function* (
  env: Env,
  absolutePath: string,
  platform: string = process.platform,
): Effect.fn.Return<DetectedBrowser | undefined> {
  const windows = platform === "win32"
  const clean = localPath(absolutePath, windows)
  if (
    clean === undefined ||
    (windows && !clean.toLowerCase().endsWith(".exe")) ||
    !(yield* checkFile(clean, true, windows))
  )
    return undefined
  const key = windows ? clean.toLowerCase() : clean
  const browser = BROWSERS.find((candidate) =>
    [...knownPaths(candidate, env, platform), ...pathsOnPath(candidate, env, windows)].some(
      (path) => (windows ? path.toLowerCase() : path) === key,
    ),
  )
  return browser === undefined
    ? ({
        id: "manual",
        name: "Manually selected browser",
        family: "unknown",
        executable: clean,
        source: "manual",
        browseCompatibility: "unverified",
      } satisfies DetectedBrowser)
    : evidence(browser, "manual", platform, profileRoot(browser, env, platform), clean)
})
