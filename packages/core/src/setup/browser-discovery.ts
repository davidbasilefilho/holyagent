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
  readonly source: "registry" | "desktop-entry" | "known-path" | "path" | "profile" | "manual"
  /** The exact desktop entry id when an XDG registration supplied the candidate. */
  readonly desktopEntry?: string
  /** An existing executable-shaped file; a profile alone never supplies this field. */
  readonly executable?: string
  /** The standard user-data root for this browser when known, not necessarily a configured profile. */
  readonly profileDirectory?: string
}

/** Shared eligibility for Chromium extension entry points, not proof of pairing or support. */
export const isChromiumBrowser = (browser: Pick<DetectedBrowser, "family">): boolean =>
  browser.family === "chromium"

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

const registryReader = Effect.fn("registryReader")(function* (env: Env) {
  const root = envOf(env, "SystemRoot", true) ?? envOf(env, "WINDIR", true)
  const local = root === undefined ? undefined : localPath(root, true)
  if (local === undefined) return undefined
  const reg = win32.join(local, "System32", "reg.exe")
  if (!(yield* checkFile(reg, true, true))) return undefined
  const shell = yield* Shell
  return (key: string, args: readonly string[]) =>
    shell
      .run(reg, ["query", key, ...args], { cwd: local })
      .pipe(Effect.map(({ exitCode, stdout }) => (exitCode === 0 ? stdout : "")))
})

const localNames = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* fileSystem
    return yield* Effect.try(() => fs.readdirSync(directory)).pipe(Effect.orElseSucceed(() => []))
  })

const identityKey = (name: string) =>
  name
    .toLowerCase()
    .replaceAll(/[^a-z\d]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)

const registeredBrowser = Effect.fn("registeredBrowser")(function* (
  key: string,
  name: string,
  executable: string,
  source: "registry" | "desktop-entry",
  platform: string,
): Effect.fn.Return<DetectedBrowser> {
  const windows = platform === "win32"
  const path = windows ? win32 : posix
  const folder = path.dirname(executable)
  const isFile = (file: string) => checkFile(file, false, windows)
  const isLibrary = (base: string) => isFile(path.join(folder, base))
  const gecko = yield* isLibrary(windows ? "xul.dll" : "libxul.so")
  const chromium = gecko
    ? false
    : yield* Effect.gen(function* () {
        if (windows) {
          if (yield* isLibrary("chrome.dll")) return true
          const versions = (yield* localNames(folder))
            .filter((entry) => /^\d+(?:\.\d+){2,4}$/.test(entry))
            .slice(0, 12)
          const version = yield* Effect.findFirst(versions, (entry) =>
            isFile(path.join(folder, entry, "chrome.dll")),
          )
          if (version._tag === "Some") return true
        }
        return (
          (yield* isLibrary("resources.pak")) &&
          ((yield* isLibrary("chrome_100_percent.pak")) || (yield* isLibrary("chrome-sandbox")))
        )
      })
  return {
    id: `${source === "registry" ? "registered" : "desktop"}-${identityKey(key)}`,
    name,
    executable,
    source,
    family: gecko ? "gecko" : chromium ? "chromium" : "unknown",
    browseCompatibility: gecko ? "unsupported" : "unverified",
  }
})

const windowsRegistrations = Effect.fn("windowsRegistrations")(function* (env: Env) {
  const read = yield* registryReader(env)
  const registered = new Map<string, string>()
  const extra: DetectedBrowser[] = []
  if (read === undefined) return { registered, extra }
  const views = ["/reg:64", "/reg:32"] as const
  const query = (key: string, view: string, value: boolean) =>
    read(key, [...(value ? ["/ve"] : []), view])
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
      .filter((child) => /^[\w .-]{1,80}$/.test(child) && identityKey(child) !== "")
      .slice(0, 48)
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
      return browser !== undefined && registered.has(browser.id) ? [] : [{ client, browser }]
    })
    const verified = yield* Effect.forEach(
      chosen,
      ({ client, browser }) =>
        Effect.gen(function* () {
          const output = yield* query(`${prefix}${client}\\shell\\open\\command`, view, true)
          const path = registryExecutable(output, env)
          if (path === undefined || !(yield* checkFile(path, true, true))) return undefined
          if (browser === undefined) {
            const display = yield* query(`${prefix}${client}`, view, true)
            const name =
              /^\s*\(Default\)\s+REG_SZ\s+([^\p{Cc}]{1,100})$/imu.exec(display)?.[1]?.trim() ||
              client
            return yield* registeredBrowser(client, name, path, "registry", "win32")
          }
          return browser.winExe?.some(
            (exe) => exe.toLowerCase() === win32.basename(path).toLowerCase(),
          )
            ? { id: browser.id, path }
            : undefined
        }),
      { concurrency: 4 },
    )
    for (const entry of verified) {
      if (entry === undefined) continue
      if ("path" in entry) {
        if (!registered.has(entry.id)) registered.set(entry.id, entry.path)
      } else if (!extra.some((browser) => browser.id === entry.id)) extra.push(entry)
    }
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
  return { registered, extra }
})

const linuxRegistrations = Effect.fn("linuxRegistrations")(function* (env: Env) {
  const home = homeDirectory(env)
  const roots = [
    ...new Set([
      env.XDG_DATA_HOME ?? posix.join(home, ".local/share"),
      ...(env.XDG_DATA_DIRS ?? "/usr/local/share:/usr/share").split(":"),
    ]),
  ].flatMap((root) => {
    const local = localPath(root, false)
    return local === undefined ? [] : [posix.join(local, "applications")]
  })
  const fs = yield* fileSystem
  const shell = yield* Shell
  const seen = new Set<string>()
  const extra: DetectedBrowser[] = []
  for (const root of roots) {
    for (const entry of (yield* localNames(root))
      .filter((file) => /^[\w.-]{1,120}\.desktop$/.test(file))
      .slice(0, 500)) {
      if (seen.has(entry)) continue
      seen.add(entry)
      const file = posix.join(root, entry)
      const metadata = yield* Effect.tryPromise(() => fs.stat(file)).pipe(Effect.option)
      if (metadata._tag === "None" || !metadata.value.isFile() || metadata.value.size > 64 * 1024)
        continue
      const source = yield* Effect.tryPromise(() => fs.readFile(file, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      )
      const group = source.split(/^\[Desktop Entry\]\s*$/m)[1]?.split(/^\[/m)[0] ?? ""
      const values = (field: "Categories" | "MimeType") =>
        group
          .split(/\r?\n/)
          .find((line) => line.startsWith(`${field}=`))
          ?.slice(field.length + 1)
          .split(";") ?? []
      if (
        !/^Type=Application\s*$/m.test(group) ||
        /^Hidden=true\s*$/im.test(group) ||
        (!values("Categories").includes("WebBrowser") &&
          !values("MimeType").includes("x-scheme-handler/https"))
      )
        continue
      const name = /^Name=([^\p{Cc}]{1,100})$/mu.exec(group)?.[1]?.trim()
      const match = /^Exec=(?:"([^"\r\n]+)"|([^\s"=]+))/m.exec(group)
      const binary = match?.[1] ?? match?.[2]
      if (!name || binary === undefined) continue
      const path = localPath(binary, false)
      const located =
        path === undefined && /^[\w.-]+$/.test(binary)
          ? yield* shell.which(binary, { strict: { cwd: home } })
          : undefined
      const executable = path ?? (located?._tag === "Some" ? located.value : undefined)
      if (executable === undefined || !(yield* checkFile(executable, true, false))) continue
      // An env/flatpak/shell command is a wrapper, not enough evidence to identify the install.
      if (["env", "flatpak", "snap", "sh", "bash", "zsh"].includes(posix.basename(executable)))
        continue
      extra.push({
        ...(yield* registeredBrowser(
          entry.slice(0, -8),
          name,
          executable,
          "desktop-entry",
          "linux",
        )),
        desktopEntry: entry,
      })
    }
  }
  return extra
})

const macRegistrations = Effect.fn("macRegistrations")(function* (env: Env) {
  const home = homeDirectory(env)
  const extra: DetectedBrowser[] = []
  for (const root of ["/Applications", posix.join(home, "Applications")].filter(posix.isAbsolute)) {
    const bundles = (yield* localNames(root))
      .filter((name) => /^[^/\p{Cc}]{1,120}\.app$/u.test(name))
      .slice(0, 160)
    for (const bundle of bundles) {
      const name = bundle.slice(0, -4)
      if (identityKey(name) === "" || BROWSERS.some(({ app }) => app === name)) continue
      const contents = posix.join(root, bundle, "Contents")
      const resources = posix.join(contents, "Resources")
      const macos = posix.join(contents, "MacOS")
      const executables = (yield* localNames(macos)).filter((entry) =>
        /^[^/\p{Cc}]{1,120}$/u.test(entry),
      )
      const executable = posix.join(
        macos,
        executables.find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? name,
      )
      if (!(yield* checkFile(executable, true, false))) continue
      const gecko =
        (yield* checkFile(posix.join(macos, "XUL"), false, false)) &&
        (yield* checkFile(posix.join(resources, "browser", "omni.ja"), false, false))
      const frameworks = posix.join(contents, "Frameworks")
      const engine = gecko
        ? undefined
        : yield* Effect.findFirst(
            (yield* localNames(frameworks)).filter(
              (entry) =>
                /^[^/\p{Cc}]{1,120} Framework\.framework$/u.test(entry) &&
                entry !== "Electron Framework.framework",
            ),
            (entry) =>
              checkFile(
                posix.join(frameworks, entry, "Versions/Current/Helpers/chrome_crashpad_handler"),
                false,
                false,
              ),
          )
      if (gecko || engine?._tag === "Some")
        extra.push({
          id: `app-${identityKey(name)}`,
          name,
          executable,
          source: "known-path",
          family: gecko ? "gecko" : "chromium",
          browseCompatibility: gecko ? "unsupported" : "unverified",
        })
    }
  }
  return extra
})

/**
 * Detect common and registered local browsers without launching them or crawling profile trees. A
 * registry or desktop entry alone establishes no integration compatibility.
 */
export const discoverBrowsers = Effect.fn("discoverBrowsers")(function* (
  env: Env,
  platform: string = process.platform,
): Effect.fn.Return<ReadonlyArray<DetectedBrowser>, never, Shell> {
  const windows = platform === "win32"
  const path = windows ? win32 : posix
  if (!windows && platform !== "linux" && platform !== "darwin") return []
  const registry = windows ? yield* windowsRegistrations(env) : undefined
  const browsers = yield* Effect.forEach(
    BROWSERS,
    (browser) =>
      Effect.gen(function* () {
        const profileDirectory = profileRoot(browser, env, platform)
        const registered = registry?.registered.get(browser.id)
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
  const extra =
    registry?.extra ??
    (platform === "linux" ? yield* linuxRegistrations(env) : yield* macRegistrations(env))
  const found = browsers.filter((browser) => browser !== undefined)
  const identity = (file: string | undefined) => (windows ? file?.toLowerCase() : file)
  for (const browser of extra) {
    if (
      !found.some(
        (entry) =>
          entry.id === browser.id || identity(entry.executable) === identity(browser.executable),
      )
    )
      found.push(browser)
  }
  return found
})

const HTTPS_CHOICE =
  "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice"
const LINUX_BROWSER_IDS = new Map([
  ["google-chrome.desktop", "chrome"],
  ["com.google.Chrome.desktop", "chrome"],
  ["google-chrome-beta.desktop", "chrome-beta"],
  ["google-chrome-unstable.desktop", "chrome-unstable"],
  ["chromium.desktop", "chromium"],
  ["chromium-browser.desktop", "chromium"],
  ["org.chromium.Chromium.desktop", "chromium"],
  ["microsoft-edge.desktop", "edge"],
  ["microsoft-edge-stable.desktop", "edge"],
  ["brave-browser.desktop", "brave"],
  ["com.brave.Browser.desktop", "brave"],
  ["opera.desktop", "opera"],
  ["vivaldi-stable.desktop", "vivaldi"],
  ["helium.desktop", "helium"],
  ["net.imput.helium.desktop", "helium"],
])
const MAC_DEFAULT =
  '/** Read the LaunchServices handler without opening the URL. */\nObjC.import("AppKit");\nvar app = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.invalid/"));\nif (app) ObjC.unwrap(app.path);'

/** Match the OS default only to a detected Chromium executable. Never launch or change it. */
export const systemDefaultBrowser = Effect.fn("systemDefaultBrowser")(function* (
  env: Env,
  cwd: string,
  detected: ReadonlyArray<DetectedBrowser>,
  platform: string = process.platform,
): Effect.fn.Return<string | undefined, never, Shell> {
  // A stale profile can still appear in the menu. It cannot establish an installed OS default.
  const candidates = detected.filter(
    (browser) => browser.executable !== undefined && isChromiumBrowser(browser),
  )
  if (candidates.length === 0) return undefined
  if (platform === "win32") {
    const read = yield* registryReader(env)
    if (read === undefined) return undefined
    const choice = yield* read(HTTPS_CHOICE, ["/v", "ProgId"])
    const progId = /^\s*ProgId\s+REG_SZ\s+([\w.-]{1,128})\s*$/im.exec(choice)?.[1]
    if (progId === undefined) return undefined
    const command = yield* read(`HKEY_CLASSES_ROOT\\${progId}\\shell\\open\\command`, ["/ve"])
    const path = registryExecutable(command, env)?.toLowerCase()
    return path === undefined
      ? undefined
      : candidates.find(({ executable }) => executable?.toLowerCase() === path)?.id
  }
  const shell = yield* Shell
  if (platform === "linux") {
    const command = yield* shell.which("xdg-settings", { strict: { cwd } })
    if (command._tag === "None") return undefined
    const result = yield* shell.run(command.value, ["get", "default-web-browser"], { cwd })
    if (result.exitCode !== 0) return undefined
    const entry = result.stdout.trim()
    const registered = detected.find((candidate) => candidate.desktopEntry === entry)
    const id = registered?.id ?? LINUX_BROWSER_IDS.get(entry)
    return candidates.find((candidate) => candidate.id === id)?.id
  }
  if (platform === "darwin" && (yield* checkFile("/usr/bin/osascript", true, false))) {
    const result = yield* shell.run("/usr/bin/osascript", ["-l", "JavaScript", "-e", MAC_DEFAULT], {
      cwd,
    })
    if (result.exitCode !== 0) return undefined
    const app = localPath(result.stdout.trim(), false)
    if (app === undefined || !app.endsWith(".app")) return undefined
    return candidates.find(({ executable }) => executable?.startsWith(`${app}/Contents/MacOS/`))?.id
  }
  return undefined
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
