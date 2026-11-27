import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import {
  CODEX_BROWSER_GUIDE,
  type CodexBrowserHandoffOptions,
  detectCodexBrowserHandoff,
  openCodexBrowserHandoff,
} from "../src/setup/codex-browser-handoff.ts"
import type { Env } from "../src/setup/environment.ts"
import { shellLive } from "../src/setup/shell.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

const linux = { platform: "linux", cwd: "/fixture/project" } as const
const windows = { platform: "win32", cwd: "C:\\Users\\fixture\\project" } as const
const linuxEnv = { HOME: "/fixture/home", DISPLAY: ":0" }
const windowsEnv = { USERPROFILE: "C:\\Users\\fixture", SystemRoot: "C:\\Windows" }
const chrome = {
  id: "chrome",
  name: "Google Chrome",
  family: "chromium",
  executable: "/usr/bin/google-chrome",
} as const
const edge = {
  id: "edge",
  name: "Microsoft Edge",
  family: "chromium",
  executable: "/usr/bin/microsoft-edge",
} as const

const linuxDesktop = () =>
  fakeShell({
    commands: ["chatgpt"],
    respond: (line) =>
      line.startsWith("/usr/bin/dpkg-query ") ? { stdout: "installed 26.1109.1905-1" } : undefined,
  })

const detect = (
  shell: ReturnType<typeof fakeShell>,
  browsers: Parameters<typeof detectCodexBrowserHandoff>[1] = [chrome],
  env: Env = linuxEnv,
  options: CodexBrowserHandoffOptions = linux,
) =>
  Effect.runPromise(
    detectCodexBrowserHandoff(env, browsers, options).pipe(Effect.provide(shell.layer)),
  )

describe("official Codex desktop browser extension handoff", () => {
  test("Linux opens the official guide in a detected Chromium without confirming extension availability", async () => {
    const shell = linuxDesktop()
    const result = await detect(shell, [
      edge,
      { id: "chromium", name: "Chromium", family: "chromium", executable: "/usr/bin/chromium" },
      chrome,
      chrome,
    ])
    expect(result).toMatchObject({
      status: "candidate",
      desktop: { platform: "linux", name: "ChatGPT desktop app", version: "26.1109.1905-1" },
      browsers: [
        { id: "edge", executable: edge.executable },
        { id: "chromium", executable: "/usr/bin/chromium" },
        { id: "chrome", executable: chrome.executable },
      ],
      url: "https://learn.chatgpt.com/docs/chrome-extension",
      detail: expect.stringContaining("workspace settings"),
    })
    if (result.status !== "candidate") throw new Error("desktop with Chrome should be a candidate")
    const flow = result.steps.join("\n")
    for (const step of [
      "Settings > Computer Use",
      "plugin",
      "Install",
      "Manage",
      "@-mention",
      "profile",
    ])
      expect(flow).toContain(step)
    expect(shell.calls.map(({ command }) => command)).toEqual(["/usr/bin/dpkg-query"])
  })

  test("desktop presence remains visible when only an unsupported or profile-only browser is found", async () => {
    const result = await detect(linuxDesktop(), [
      { id: "firefox", name: "Firefox", family: "gecko", executable: "/usr/bin/firefox" },
      { id: "chrome", name: "Google Chrome", family: "chromium" },
      { ...chrome, executable: "chrome" },
    ])
    expect(result).toMatchObject({
      status: "unavailable",
      desktop: { platform: "linux", version: "26.1109.1905-1" },
      reason: expect.stringContaining("No installed Chromium browser"),
    })
  })

  test("Windows Helium and another Chromium derivative open the guide using their exact targets", async () => {
    const shell = fakeShell({
      commands: [],
      respond: (line) =>
        line.includes("Get-AppxPackage") ? { stdout: "26.1109.1905.0" } : { exitCode: 0 },
    })
    const detected = [
      {
        id: "chrome",
        name: "Google Chrome",
        family: "chromium",
        executable: "C:\\Chrome\\chrome.exe",
      },
      {
        id: "edge",
        name: "Microsoft Edge",
        family: "chromium",
        executable: "C:\\Edge\\msedge.exe",
      },
      {
        id: "helium",
        name: "Helium",
        family: "chromium",
        executable: "C:\\imput\\Helium\\Application\\chrome.exe",
      },
      {
        id: "registered-aurora",
        name: "Aurora Browser",
        family: "chromium",
        executable: "C:\\Aurora\\aurora.exe",
      },
      { id: "firefox", name: "Firefox", family: "gecko", executable: "C:\\Firefox\\firefox.exe" },
      {
        id: "iexplore",
        name: "Internet Explorer",
        family: "unknown",
        executable: "C:\\IE\\iexplore.exe",
      },
    ] as const
    const offer = await detect(shell, detected, windowsEnv, windows)
    expect(offer).toMatchObject({
      status: "candidate",
      browsers: detected.slice(0, 4).map(({ id, name, executable }) => ({ id, name, executable })),
    })
    expect(JSON.stringify(offer)).not.toMatch(/Firefox|Internet Explorer|unavailableBrowsers/)
    expect(shell.calls).toHaveLength(1)
    for (const id of ["helium", "registered-aurora", "firefox", "iexplore"] as const) {
      const result = await Effect.runPromise(
        openCodexBrowserHandoff(windowsEnv, offer, id, windows).pipe(Effect.provide(shell.layer)),
      )
      expect(result.ok).toBe(id === "helium" || id === "registered-aurora")
      if (result.ok) expect(result.lines.join("\\n")).toContain("Finish in ChatGPT desktop")
    }
    expect(shell.calls.slice(1).map(({ env }) => env)).toEqual([
      { HOLYAGENT_SETUP_BROWSER_EXE: detected[2]?.executable },
      { HOLYAGENT_SETUP_BROWSER_EXE: detected[3]?.executable },
    ])
    expect(shell.calls.slice(1).every(({ line }) => line.includes(CODEX_BROWSER_GUIDE))).toBe(true)
  })

  test("the CLI or a bare command named chatgpt is insufficient evidence", async () => {
    const cliOnly = fakeShell({ commands: ["codex"] })
    expect(await detect(cliOnly)).toEqual({
      status: "unavailable",
      reason: "No supported local ChatGPT desktop installation was detected.",
    })
    expect(cliOnly.calls).toEqual([])
    const bare = fakeShell({ commands: ["chatgpt"], respond: () => ({ exitCode: 1 }) })
    expect(await detect(bare)).toMatchObject({ status: "unavailable" })
    expect(bare.calls.map(({ command }) => command)).toEqual([
      "/usr/bin/dpkg-query",
      "/usr/bin/rpm",
      "/usr/bin/pacman",
    ])
  })

  test.each([
    ["RPM", "/usr/bin/rpm", "chatgpt 26.1109.1905-1"],
    ["Arch", "/usr/bin/pacman", "chatgpt 26.1109.1905-1\n"],
  ])("recognizes the official %s package query", async (_, command, stdout) => {
    const shell = fakeShell({
      commands: ["chatgpt"],
      respond: (line) => (line.startsWith(`${command} `) ? { stdout } : { exitCode: 1 }),
    })
    expect(await detect(shell)).toMatchObject({
      status: "candidate",
      desktop: { version: "26.1109.1905-1" },
    })
  })

  test.each([
    ["headless", { HOME: linuxEnv.HOME }],
    ["cloud", { ...linuxEnv, CODEX_CAAS_SESSION_ID: "fixture" }],
    ["WSL", { ...linuxEnv, WSL_DISTRO_NAME: "Ubuntu" }],
    ["SSH", { ...linuxEnv, SSH_CONNECTION: "fixture" }],
    ["hosted automation", { ...linuxEnv, CI: "true" }],
  ])("does not offer or probe the desktop in %s", async (_, env) => {
    const shell = linuxDesktop()
    expect(await detect(shell, [chrome], env)).toMatchObject({ status: "unavailable" })
    expect(shell.calls).toEqual([])
  })

  test("native CODEX_CI alone does not hide an actual local desktop candidate", async () => {
    expect(await detect(linuxDesktop(), [chrome], { ...linuxEnv, CODEX_CI: "1" })).toMatchObject({
      status: "candidate",
    })
  })

  test("reads current-user Windows app registration and ignores a remote executable", async () => {
    const shell = fakeShell({
      commands: [],
      respond: (line) =>
        line.includes("Get-AppxPackage") ? { stdout: "26.1109.1905.0\r\n" } : { exitCode: 1 },
    })
    const browsers = ["chrome", "edge", "brave", "opera", "vivaldi", "firefox"].map((id) => ({
      id,
      name: id,
      family: id === "firefox" ? ("gecko" as const) : ("chromium" as const),
      executable: `C:\\Installed Apps\\${id}.exe`,
    }))
    const remote = { ...chrome, executable: "\\\\server\\share\\chrome.exe" }
    const offer = await detect(shell, [remote, ...browsers], windowsEnv, windows)
    expect(offer).toMatchObject({
      status: "candidate",
      desktop: { platform: "win32", version: "26.1109.1905.0" },
    })
    if (offer.status !== "candidate") throw new Error("Windows registration was not read")
    expect(offer.browsers.map(({ id }) => id)).toEqual([
      "chrome",
      "edge",
      "brave",
      "opera",
      "vivaldi",
    ])
    expect(offer.browsers[0]?.executable).toBe("C:\\Installed Apps\\chrome.exe")
    expect(shell.calls).toHaveLength(1)
    expect(shell.calls[0]?.line).toContain("OpenAI.Codex_2p2nqsd0c76g0")
    expect(shell.calls[0]?.line).not.toContain("-AllUsers")
    const result = await Effect.runPromise(
      openCodexBrowserHandoff(windowsEnv, offer, "edge", windows).pipe(Effect.provide(shell.layer)),
    )
    expect(result).toMatchObject({ ok: false })
    const launch = shell.calls[1]
    expect(launch?.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(launch?.line).toContain(CODEX_BROWSER_GUIDE)
    expect(launch?.line).not.toContain("C:\\Installed Apps")
    expect(launch?.env).toEqual({ HOLYAGENT_SETUP_BROWSER_EXE: "C:\\Installed Apps\\edge.exe" })
  })

  test("distinguishes ChatGPT Classic on macOS from the app with the Codex bundle identity", async () => {
    const shell = fakeShell({
      commands: [],
      respond: (line) =>
        line.includes("CFBundleShortVersionString")
          ? { stdout: "26.1109.1905" }
          : { stdout: line.includes("/Codex.app/") ? "com.openai.codex" : "com.openai.chat" },
    })
    expect(await detect(shell, [edge], linuxEnv, { ...linux, platform: "darwin" })).toMatchObject({
      status: "candidate",
      desktop: { platform: "darwin", version: "26.1109.1905" },
      browsers: [{ id: "edge", name: "Microsoft Edge" }],
    })
    expect(shell.calls.map(({ command }) => command)).toEqual([
      "/usr/bin/plutil",
      "/usr/bin/plutil",
      "/usr/bin/plutil",
    ])
    expect(shell.calls[2]?.line).toContain("/Codex.app/Contents/Info.plist")
  })

  test("only an explicit offered selection opens the fixed official guide", async () => {
    const shell = linuxDesktop()
    const offer = await detect(shell)
    if (offer.status !== "candidate") throw new Error("candidate was not detected")
    const changedGuide = { ...offer, url: "https://unrelated.invalid/" } as unknown as typeof offer
    const open = (choice: "chrome" | "edge" | undefined, env: Env = linuxEnv) =>
      Effect.runPromise(
        openCodexBrowserHandoff(env, changedGuide, choice, linux).pipe(Effect.provide(shell.layer)),
      )
    expect(await open(undefined)).toEqual({ ok: true, lines: [] })
    expect((await open("edge")).ok).toBe(false)
    expect((await open("chrome", { ...linuxEnv, CODEX_CAAS_SESSION_ID: "fixture" })).ok).toBe(false)
    expect(shell.calls).toHaveLength(1)
    const result = await open("chrome")
    expect(result.ok).toBe(true)
    expect(result.lines.join("\n")).toContain("requested the setup guide")
    const launch = shell.calls[1]
    expect(launch?.command).toBe("/bin/sh")
    expect(launch?.args.slice(-2)).toEqual([chrome.executable, CODEX_BROWSER_GUIDE])
    expect(launch?.cwd).toBe(linuxEnv.HOME)
    expect(shell.calls).toHaveLength(2)
  })

  test.skipIf(process.platform === "win32")(
    "the POSIX Shell gives an opener at a path with spaces exactly the official URL argument",
    async () => {
      const fixture = await scratch("holyagent-codex-handoff-")
      try {
        const executable = join(fixture.directory, "fixture browser.sh")
        const log = join(fixture.directory, "arguments")
        const env = { HOME: fixture.directory, DISPLAY: ":0", FIXTURE_LOG: log }
        await writeFile(
          executable,
          '#!/bin/sh\nprintf "%s\\n" "$#" "$1" > "$FIXTURE_LOG.tmp"\n/bin/mv "$FIXTURE_LOG.tmp" "$FIXTURE_LOG"\n',
          { mode: 0o700 },
        )
        const offer = await detect(linuxDesktop(), [{ ...chrome, executable }], env)
        const result = await Effect.runPromise(
          openCodexBrowserHandoff(env, offer, "chrome", linux).pipe(Effect.provide(shellLive(env))),
        )
        expect(result.ok).toBe(true)
        for (let attempt = 0; attempt < 40 && !existsSync(log); attempt += 1) await Bun.sleep(10)
        expect(await readFile(log, "utf8")).toBe(`1\n${CODEX_BROWSER_GUIDE}\n`)
      } finally {
        await fixture.remove()
      }
    },
  )
})
