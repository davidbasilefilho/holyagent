import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"
import { join, win32 } from "node:path"

import { Effect, Layer } from "effect"

import { FileSystem, nodeFileSystem } from "../../core/src/ports/filesystem.ts"
import { BROWSE_EXTENSION_IDS, findBrowseProfiles } from "../../core/src/setup/browse.ts"
import {
  checkBrowserExecutable,
  discoverBrowsers,
  isChromiumBrowser,
  systemDefaultBrowser,
} from "../../core/src/setup/browser-discovery.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

const WIN = {
  USERPROFILE: "C:\\Users\\Fixture",
  LOCALAPPDATA: "C:\\Users\\Fixture\\AppData\\Local",
  APPDATA: "C:\\Users\\Fixture\\AppData\\Roaming",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  SystemRoot: "C:\\Windows",
  Path: "C:\\Windows\\System32;C:\\portable;relative",
} as const
const REG = "C:\\Windows\\System32\\reg.exe"
const CHROME = `${WIN.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`
const HELIUM = `${WIN.LOCALAPPDATA}\\imput\\Helium\\Application\\chrome.exe`
const HELIUM_PROFILE = `${WIN.LOCALAPPDATA}\\imput\\Helium\\User Data`
const FIREFOX = `${WIN["ProgramFiles(x86)"]}\\Mozilla Firefox\\firefox.exe`
const HKCU = "HKEY_CURRENT_USER\\SOFTWARE\\Clients\\StartMenuInternet"
const HKLM = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet"
const APP_PATHS = "HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths"

let home: string
let remove: () => Promise<void>
let files: Map<string, string>
let reads: string[]
let directories: Map<string, string[]>

beforeEach(async () => {
  const made = await scratch("holyagent-browser-discovery-")
  home = made.directory
  remove = made.remove
  files = new Map()
  reads = []
  directories = new Map()
})
afterEach(() => remove())

const key = (file: string) => (/^[a-z]:/i.test(file) ? win32.normalize(file).toLowerCase() : file)
const fixturePath = (file: string) => {
  reads.push(file)
  return files.get(key(file)) ?? join(home, "missing")
}

const filesystem = () =>
  Layer.succeed(
    FileSystem,
    FileSystem.of({
      ...nodeFileSystem,
      stat: ((file: string) =>
        nodeFileSystem.stat(fixturePath(file))) as typeof nodeFileSystem.stat,
      readFile: ((file: string, encoding?: string) =>
        encoding === "utf8"
          ? nodeFileSystem.readFile(fixturePath(file), "utf8")
          : nodeFileSystem.readFile(fixturePath(file))) as typeof nodeFileSystem.readFile,
      accessSync: (file, mode) => nodeFileSystem.accessSync(fixturePath(String(file)), mode),
      readdirSync: ((dir: string) =>
        directories.get(key(dir)) ?? []) as typeof nodeFileSystem.readdirSync,
    }),
  )

const touch = async (file: string, contents = "fixture", mode = 0o755) => {
  const materialized = join(home, String(files.size + 1))
  await writeFile(materialized, contents, { mode })
  files.set(key(file), materialized)
}

const lookup = (shell = fakeShell({ commands: [] })) =>
  Effect.runPromise(
    discoverBrowsers(WIN, "win32").pipe(Effect.provide(shell.layer), Effect.provide(filesystem())),
  )

describe("read-only discovery of installed browsers", () => {
  test("Windows stable Chrome, Helium's branded chrome.exe, and Firefox are separate detections", async () => {
    await touch(HELIUM)
    await touch(CHROME)
    await touch(FIREFOX)
    const shell = fakeShell({ commands: [] })
    const found = await lookup(shell)
    expect(found).toEqual([
      {
        id: "chrome",
        name: "Google Chrome",
        family: "chromium",
        browseCompatibility: "supported",
        source: "known-path",
        executable: CHROME,
        profileDirectory: `${WIN.LOCALAPPDATA}\\Google\\Chrome\\User Data`,
      },
      {
        id: "helium",
        name: "Helium",
        family: "chromium",
        browseCompatibility: "unverified",
        source: "known-path",
        executable: HELIUM,
        profileDirectory: HELIUM_PROFILE,
      },
      {
        id: "firefox",
        name: "Firefox",
        family: "gecko",
        browseCompatibility: "unsupported",
        source: "known-path",
        executable: FIREFOX,
        profileDirectory: `${WIN.APPDATA}\\Mozilla\\Firefox`,
      },
    ])
    expect(shell.calls).toEqual([])
  })

  test("Helium OEM/system install is not confused with a generic portable chrome.exe", async () => {
    const executable = `${WIN.ProgramFiles}\\imput\\Helium\\Application\\chrome.exe`
    await touch(executable)
    await touch("C:\\portable\\chrome.exe")
    expect(await lookup()).toMatchObject([{ id: "helium", executable, source: "known-path" }])
    expect((await lookup()).find(({ id }) => id === "chrome")).toBeUndefined()
  })

  test("Helium browser profile and extension alone do not prove an installed executable or pairing", async () => {
    await touch(
      `${HELIUM_PROFILE}\\Local State`,
      JSON.stringify({ profile: { info_cache: { "Profile 2": { name: "Work" } } } }),
    )
    await touch(
      `${HELIUM_PROFILE}\\Profile 2\\Secure Preferences`,
      JSON.stringify({ extensions: { settings: { [BROWSE_EXTENSION_IDS[0] ?? ""]: {} } } }),
    )
    const found = await lookup()
    expect(found).toEqual([
      {
        id: "helium",
        name: "Helium",
        source: "profile",
        family: "chromium",
        browseCompatibility: "unverified",
        profileDirectory: HELIUM_PROFILE,
      },
    ])
    expect(
      await Effect.runPromise(findBrowseProfiles(WIN, "win32").pipe(Effect.provide(filesystem()))),
    ).toMatchObject([{ browser: "Helium", profile: "Profile 2", extension: "enabled" }])
  })

  test("registered Windows custom browsers use only the fixed system registry reader", async () => {
    const customHelium = `${WIN.LOCALAPPDATA}\\Custom Helium\\chrome.exe`
    const customFirefox = "D:\\Browsers\\Firefox Custom\\firefox.exe"
    await touch(REG)
    await touch(customHelium)
    await touch(customFirefox)
    const shell = fakeShell({
      commands: [],
      respond: (line) => {
        if (line.endsWith(`${HKCU} /reg:64`))
          return {
            stdout: `${HKCU}\r\n${HKCU}\\Helium\r\n${HKCU}\\Brave\r\n${HKCU}\\Unknown Client\r\n`,
          }
        if (line.endsWith(`${HKLM} /reg:32`))
          return { stdout: `${HKLM}\\Firefox-5A371F28ABCDEF12\r\n` }
        if (line.includes("\\Helium\\shell\\open\\command"))
          return {
            stdout:
              '    (Default)    REG_EXPAND_SZ    "%LOCALAPPDATA%\\Custom Helium\\chrome.exe" -- "%1"\r\n',
          }
        if (line.includes("\\Firefox-5A371F28ABCDEF12\\shell\\open\\command"))
          return { stdout: `    (Default)    REG_SZ    ${customFirefox} -osint -url "%1"\r\n` }
        if (line.includes("\\Brave\\shell\\open\\command"))
          return { stdout: '    (Default)    REG_SZ    "\\\\untrusted.test\\share\\brave.exe"\r\n' }
        return { exitCode: 1 }
      },
    })
    expect(await lookup(shell)).toMatchObject([
      {
        id: "helium",
        executable: customHelium,
        source: "registry",
        browseCompatibility: "unverified",
      },
      {
        id: "firefox",
        executable: customFirefox,
        source: "registry",
        browseCompatibility: "unsupported",
      },
    ])
    expect(shell.calls.every(({ command, args }) => command === REG && args[0] === "query")).toBe(
      true,
    )
    expect(
      shell.lines().some((line) => line.includes("Unknown Client\\shell\\open\\command")),
    ).toBe(true)
    expect(reads.some((file) => file.startsWith("\\\\"))).toBe(false)
  })

  test("an unknown Windows registered derivative is detected from installed Chromium engine files without claiming compatibility", async () => {
    const root = "D:\\Fixture\\Aurora\\Application"
    const binary = `${root}\\aurora.exe`
    await touch(REG)
    await touch(binary)
    directories.set(key(root), ["120.0.0.1", "other"])
    await touch(`${root}\\120.0.0.1\\chrome.dll`)
    await touch(FIREFOX)
    await touch(HELIUM)
    const internetExplorer = "D:\\Windows\\Internet Explorer\\iexplore.exe"
    await touch(internetExplorer)
    const shell = fakeShell({
      commands: [],
      respond: (line) => {
        if (line.endsWith(`${HKCU} /reg:64`))
          return { stdout: `${HKCU}\\New Vendor Client\r\n${HKCU}\\Internet Explorer\r\n` }
        if (line.includes("New Vendor Client\\shell\\open\\command"))
          return { stdout: `  (Default)  REG_SZ  "${binary}" -- "%1"\r\n` }
        if (line.endsWith(`${HKCU}\\New Vendor Client /ve /reg:64`))
          return { stdout: "  (Default)  REG_SZ  Aurora Browser\n" }
        if (line.includes("Internet Explorer\\shell\\open\\command"))
          return { stdout: `  (Default)  REG_SZ  "${internetExplorer}" "%1"\r\n` }
        return { exitCode: 1 }
      },
    })
    const found = await lookup(shell)
    expect(found).toMatchObject([
      { id: "helium", executable: HELIUM, family: "chromium" },
      { id: "firefox", executable: FIREFOX, family: "gecko", browseCompatibility: "unsupported" },
      {
        id: "registered-new-vendor-client",
        name: "Aurora Browser",
        executable: binary,
        family: "chromium",
        browseCompatibility: "unverified",
      },
      { name: "Internet Explorer", executable: internetExplorer, family: "unknown" },
    ])
    expect(found.filter(isChromiumBrowser).map(({ name }) => name)).toEqual([
      "Helium",
      "Aurora Browser",
    ])
    expect(shell.calls.every(({ command }) => command === REG)).toBe(true)
  })

  test("an unknown desktop entry is found without executing its command, and a non-browser is ignored", async () => {
    const data = "/fixture/data/applications"
    const bin = "/fixture/vendor/aurora"
    directories.set(data, ["aurora.desktop", "editor.desktop", "firefox.desktop"])
    await touch(bin)
    await touch("/fixture/vendor/resources.pak")
    await touch("/fixture/vendor/chrome-sandbox")
    await touch("/fixture/bin/firefox")
    await touch(
      `${data}/aurora.desktop`,
      `[Desktop Entry]\nType=Application\nName=Aurora Browser\nCategories=WebBrowser;Network;\nExec=${bin} %U\n`,
    )
    await touch(
      `${data}/editor.desktop`,
      `[Desktop Entry]\nType=Application\nName=Not a browser\nCategories=Editor;\nExec=${bin} %U\n`,
    )
    await touch(
      `${data}/firefox.desktop`,
      "[Desktop Entry]\nType=Application\nName=Firefox\nMimeType=x-scheme-handler/https;\nExec=/fixture/bin/firefox %U\n",
    )
    const shell = fakeShell({ commands: [] })
    const found = await Effect.runPromise(
      discoverBrowsers(
        { HOME: "/fixture", XDG_DATA_HOME: "/fixture/data", PATH: "/fixture/bin" },
        "linux",
      ).pipe(Effect.provide(shell.layer), Effect.provide(filesystem())),
    )
    expect(found).toMatchObject([
      { id: "firefox", family: "gecko", browseCompatibility: "unsupported" },
      {
        id: "desktop-aurora",
        name: "Aurora Browser",
        executable: bin,
        family: "chromium",
        browseCompatibility: "unverified",
      },
    ])
    expect(shell.calls).toEqual([])
  })

  test("Windows default resolves only by exact installed compatible executable, never launches its command", async () => {
    await touch(REG)
    await touch(CHROME)
    await touch(HELIUM)
    await touch(FIREFOX)
    const detect = async (registered: string) => {
      const shell = fakeShell({
        commands: [],
        respond: (line) => {
          if (line.includes("\\https\\UserChoice /v ProgId"))
            return { stdout: "    ProgId    REG_SZ    Fixture.URL\r\n" }
          if (line.includes("HKEY_CLASSES_ROOT\\Fixture.URL\\shell\\open\\command"))
            return { stdout: `    (Default)    REG_SZ    "${registered}" "%1"\r\n` }
          return { exitCode: 1 }
        },
      })
      const found = await lookup(shell)
      const chosen = await Effect.runPromise(
        systemDefaultBrowser(WIN, WIN.USERPROFILE, found, "win32").pipe(
          Effect.provide(shell.layer),
          Effect.provide(filesystem()),
        ),
      )
      expect(shell.calls.every(({ command, args }) => command === REG && args[0] === "query")).toBe(
        true,
      )
      return chosen
    }
    expect(await detect(CHROME.toLowerCase())).toBe("chrome")
    expect(await detect(HELIUM)).toBe("helium")
    expect(await detect(FIREFOX)).toBeUndefined()
    expect(await detect("C:\\fixture\\missing\\chrome.exe")).toBeUndefined()
  })

  test("App Paths cannot misattribute a generic chrome.exe or a removed browser to Chrome", async () => {
    await touch(REG)
    await touch("D:\\other\\chrome.exe")
    await touch(HELIUM)
    const shell = fakeShell({
      commands: [],
      respond: (line) => {
        if (line.endsWith(`${APP_PATHS}\\chrome.exe /ve /reg:64`))
          return { stdout: "    (Default)    REG_SZ    D:\\other\\chrome.exe\r\n" }
        if (line.endsWith(`${APP_PATHS}\\chrome.exe /ve /reg:32`))
          return { stdout: `    (Default)    REG_SZ    ${HELIUM}\r\n` }
        if (line.endsWith(`${APP_PATHS}\\firefox.exe /ve /reg:64`))
          return { stdout: "    (Default)    REG_SZ    D:\\missing\\firefox.exe\r\n" }
        return { exitCode: 1 }
      },
    })
    expect(await lookup(shell)).toMatchObject([
      { id: "helium", source: "registry", executable: HELIUM },
    ])
  })

  test("limited PATH and standard macOS bundle lookup distinguish Chromium and Gecko", async () => {
    await touch("/fixture/bin/helium")
    await touch("/fixture/bin/librewolf")
    await touch("/Applications/Firefox.app/Contents/MacOS/firefox")
    const shell = fakeShell({ commands: [] })
    const read = (platform: string) =>
      Effect.runPromise(
        discoverBrowsers({ HOME: "/fixture", PATH: "/fixture/bin:relative" }, platform).pipe(
          Effect.provide(shell.layer),
          Effect.provide(filesystem()),
        ),
      )
    expect(await read("linux")).toMatchObject([
      {
        id: "helium",
        source: "path",
        executable: "/fixture/bin/helium",
        browseCompatibility: "supported",
      },
      { id: "librewolf", source: "path", family: "gecko", browseCompatibility: "unsupported" },
    ])
    expect(await read("darwin")).toMatchObject([
      { id: "helium", source: "path", browseCompatibility: "supported" },
      { id: "firefox", source: "known-path", family: "gecko", browseCompatibility: "unsupported" },
      { id: "librewolf", source: "path", family: "gecko", browseCompatibility: "unsupported" },
    ])
    expect(shell.calls).toEqual([])
  })

  test("macOS recognizes a vendor Chromium bundle but selects the verified LaunchServices default only when supported", async () => {
    directories.set("/Applications", [
      "Aurora Browser.app",
      "Google Chrome.app",
      "Desktop Client.app",
    ])
    directories.set("/Applications/Aurora Browser.app/Contents/Frameworks", [
      "Aurora Browser Framework.framework",
    ])
    directories.set("/Applications/Desktop Client.app/Contents/Frameworks", [
      "Electron Framework.framework",
    ])
    await touch("/Applications/Aurora Browser.app/Contents/MacOS/Aurora Browser")
    await touch(
      "/Applications/Aurora Browser.app/Contents/Frameworks/Aurora Browser Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler",
    )
    await touch("/Applications/Desktop Client.app/Contents/MacOS/Desktop Client")
    await touch(
      "/Applications/Desktop Client.app/Contents/Frameworks/Electron Framework.framework/Versions/Current/Helpers/chrome_crashpad_handler",
    )
    await touch("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    await touch("/usr/bin/osascript")
    const env = { HOME: "/fixture" }
    const shell = fakeShell({ commands: [] })
    const found = await Effect.runPromise(
      discoverBrowsers(env, "darwin").pipe(
        Effect.provide(shell.layer),
        Effect.provide(filesystem()),
      ),
    )
    expect(found).toMatchObject([
      { id: "chrome", family: "chromium", browseCompatibility: "supported" },
      { id: "app-aurora-browser", family: "chromium", browseCompatibility: "unverified" },
    ])
    expect(shell.calls).toEqual([])
    const query = async (name: string) => {
      const shell = fakeShell({
        commands: [],
        respond: () => ({ stdout: `/Applications/${name}.app\n` }),
      })
      const selected = await Effect.runPromise(
        systemDefaultBrowser(env, "/fixture", found, "darwin").pipe(
          Effect.provide(shell.layer),
          Effect.provide(filesystem()),
        ),
      )
      expect(shell.calls).toHaveLength(1)
      expect(shell.calls[0]).toMatchObject({
        command: "/usr/bin/osascript",
        args: ["-l", "JavaScript", "-e", expect.stringContaining("URLForApplicationToOpenURL")],
      })
      return selected
    }
    expect(await query("Google Chrome")).toBe("chrome")
    expect(await query("Aurora Browser")).toBe("app-aurora-browser")
  })

  test("portable manual choice checks one absolute executable and cannot claim Browse support", async () => {
    const portable = "D:\\Portable Helium\\chrome.exe"
    await touch(portable)
    await touch(HELIUM)
    await touch("D:\\launch.cmd")
    const check = (path: string) =>
      Effect.runPromise(
        checkBrowserExecutable(WIN, path, "win32").pipe(Effect.provide(filesystem())),
      )
    expect(await check(portable)).toMatchObject({
      id: "manual",
      source: "manual",
      family: "unknown",
      executable: portable,
      browseCompatibility: "unverified",
    })
    expect(reads).toEqual([portable])
    expect(await check(HELIUM)).toMatchObject({
      id: "helium",
      source: "manual",
      browseCompatibility: "unverified",
    })
    for (const file of [
      "relative.exe",
      "D:relative.exe",
      "D:\\launch.cmd",
      "\\\\untrusted.test\\foo.exe",
      "D:\\not-installed.exe",
    ])
      expect(await check(file)).toBeUndefined()
    expect(reads.filter((file) => file.startsWith("\\\\"))).toEqual([])
  })
})
