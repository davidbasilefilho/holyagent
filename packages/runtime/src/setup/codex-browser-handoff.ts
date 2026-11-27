import { posix, win32 } from "node:path"

import { Effect, Option, Schema } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import { type Env, firstNonEmpty, homeDirectory } from "./environment.ts"
import { hasDisplay, inCi } from "./form.ts"
import type { Report } from "./report.ts"
import { Shell } from "./shell.ts"

/** OpenAI's instructions for connecting an existing browser to the desktop app. */
export const CODEX_BROWSER_GUIDE = "https://learn.chatgpt.com/docs/chrome-extension"

const browserIds = ["chrome", "edge", "brave", "opera", "vivaldi"] as const
const desktopPlatforms = ["darwin", "win32", "linux"] as const
const decodeBrowser = Schema.decodeUnknownOption(Schema.Literals(browserIds))
const decodePlatform = Schema.decodeUnknownOption(Schema.Literals(desktopPlatforms))

/** Browser IDs documented for the desktop app extension. */
export type CodexBrowserId = (typeof browserIds)[number]

const labels: Record<CodexBrowserId, string> = {
  chrome: "Google Chrome",
  edge: "Microsoft Edge",
  brave: "Brave",
  opera: "Opera",
  vivaldi: "Vivaldi",
}

type Platform = (typeof desktopPlatforms)[number]

/** Installed desktop app evidence, separate from extension or workspace availability. */
export interface CodexDesktopEvidence {
  readonly platform: Platform
  readonly name: string
  readonly version?: string
}

/** A documented browser with an executable reported by local discovery. */
export interface CodexBrowserChoice {
  readonly id: CodexBrowserId
  readonly name: string
  readonly executable: string
}

/** A detected browser for which the official flow is not available. */
export interface CodexBrowserUnavailable {
  readonly id: string
  readonly name: string
  readonly reason: string
}

/** An optional handoff to OpenAI's setup guide, or why that action cannot be offered. */
export type CodexBrowserHandoff = {
  readonly unavailableBrowsers?: ReadonlyArray<CodexBrowserUnavailable>
} & (
  | {
      readonly status: "candidate"
      readonly desktop: CodexDesktopEvidence
      readonly browsers: ReadonlyArray<CodexBrowserChoice>
      readonly url: typeof CODEX_BROWSER_GUIDE
      readonly detail: string
      readonly steps: ReadonlyArray<string>
    }
  | {
      readonly status: "unavailable"
      readonly reason: string
      readonly desktop?: CodexDesktopEvidence
    }
)

/** The setup project and the platform on which the installed applications run. */
export interface CodexBrowserHandoffOptions {
  readonly cwd: string
  readonly platform?: NodeJS.Platform
}

type Discovered = { readonly id: string; readonly name?: string; readonly executable?: string }

const windowsDesktop =
  "Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop | " +
  "Where-Object PackageFamilyName -CEQ 'OpenAI.Codex_2p2nqsd0c76g0' | " +
  "Select-Object -First 1 | ForEach-Object { $_.Version.ToString() }"

const windowsDrivePath = /^[a-z]:[\\/]/i

const powershell = (env: Env) => {
  const root = firstNonEmpty(env["SystemRoot"], env["SYSTEMROOT"], env["WINDIR"])
  return root !== undefined && windowsDrivePath.test(root)
    ? win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : undefined
}

const powershellArgs = (command: string) =>
  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] as const

const versionText = Schema.decodeUnknownOption(
  Schema.String.check(Schema.isPattern(/^\d[\w.+:~-]{0,63}$/)),
)

const versionOf = (output: string): string | undefined =>
  Option.getOrUndefined(versionText(output.trim()))

const desktopEvidence = (
  platform: Platform,
  version: string | undefined,
): CodexDesktopEvidence => ({
  platform,
  name: "ChatGPT desktop app",
  ...(version === undefined ? {} : { version }),
})

// Registration and package metadata are local read-only evidence. The separately distributed
// Codex CLI and the older ChatGPT Classic macOS bundle are not evidence for the desktop app.
const detectDesktop = Effect.fn("detectCodexDesktop")(function* (
  env: Env,
  platform: Platform,
  cwd: string,
) {
  const shell = yield* Shell
  const home = homeDirectory(env)
  const input = { cwd: home }
  if (platform === "win32") {
    const command = powershell(env)
    if (command === undefined) return
    const result = yield* shell.run(command, powershellArgs(windowsDesktop), input)
    const version = versionOf(result.stdout)
    return result.exitCode === 0 && version !== undefined
      ? desktopEvidence(platform, version)
      : undefined
  }
  if (platform === "darwin") {
    for (const directory of ["/Applications", posix.join(home, "Applications")]) {
      for (const app of ["ChatGPT.app", "Codex.app"]) {
        const plist = posix.join(directory, app, "Contents", "Info.plist")
        const read = (key: string) =>
          shell.run("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", plist], input)
        const id = yield* read("CFBundleIdentifier")
        if (id.exitCode !== 0 || id.stdout.trim() !== "com.openai.codex") continue
        const version = yield* read("CFBundleShortVersionString")
        return desktopEvidence(
          platform,
          version.exitCode === 0 ? versionOf(version.stdout) : undefined,
        )
      }
    }
    return
  }
  // The official Linux packages install the `chatgpt` app. A command name or a browser profile
  // alone cannot distinguish those packages from a CLI-only or unofficial installation.
  const app = yield* shell.which("chatgpt", { strict: { cwd, platform } })
  if (Option.isNone(app)) return
  for (const [command, args, installed] of [
    ["/usr/bin/dpkg-query", ["-W", "-f=${db:Status-Status} ${Version}", "chatgpt"], "installed "],
    ["/usr/bin/rpm", ["-q", "--qf", "chatgpt %{VERSION}-%{RELEASE}", "chatgpt"], "chatgpt "],
    ["/usr/bin/pacman", ["-Q", "chatgpt"], "chatgpt "],
  ] as const) {
    const result = yield* shell.run(command, args, input)
    if (result.exitCode === 0 && result.stdout.startsWith(installed))
      return desktopEvidence(platform, versionOf(result.stdout.slice(installed.length)))
  }
})

const nonlocal = (env: Env, platform: Platform): string | undefined => {
  if (
    inCi(env) ||
    inCloudSession(env) ||
    firstNonEmpty(env["CODEX_CAAS_SESSION_ID"], env["SSH_CONNECTION"], env["SSH_TTY"]) !== undefined
  )
    return "The extension needs a local ChatGPT desktop session."
  if (
    platform === "linux" &&
    firstNonEmpty(env["WSL_DISTRO_NAME"], env["WSL_INTEROP"]) !== undefined
  )
    return "Use the native desktop outside WSL to connect your browser."
  return hasDisplay(env, platform) ? undefined : "No local desktop display was detected."
}

const browserPath = (executable: string | undefined, platform: Platform): executable is string =>
  executable !== undefined &&
  (platform === "win32"
    ? windowsDrivePath.test(executable) && executable.toLowerCase().endsWith(".exe")
    : posix.isAbsolute(executable))

const steps = [
  "Update the ChatGPT desktop app. Find your browser in Settings > Computer Use, under More browsers if needed.",
  "Follow any plugin prompt. Use Install to open the extension store and review the permission prompts there.",
  "Check for Manage in Computer Use. In a new Work or Codex chat, @-mention the browser using the profile where you installed the extension.",
] as const

/** Finds candidates without launching an app, opening a page, or checking the user's account. */
export const detectCodexBrowserHandoff = Effect.fn("detectCodexBrowserHandoff")(function* (
  env: Env,
  browsers: ReadonlyArray<Discovered>,
  options: CodexBrowserHandoffOptions,
): Effect.fn.Return<CodexBrowserHandoff, never, Shell> {
  const platform = Option.getOrUndefined(decodePlatform(options.platform ?? process.platform))
  if (platform === undefined)
    return {
      status: "unavailable",
      reason: "The local desktop app was not verified on this platform.",
    }
  const reason = nonlocal(env, platform)
  if (reason !== undefined) return { status: "unavailable", reason }
  const desktop = yield* detectDesktop(env, platform, options.cwd)
  if (desktop === undefined)
    return {
      status: "unavailable",
      reason: "No supported local ChatGPT desktop installation was detected.",
    }
  const choices: Array<CodexBrowserChoice> = []
  const unavailable = new Map<string, CodexBrowserUnavailable>()
  for (const browser of browsers) {
    const id = Option.getOrUndefined(decodeBrowser(browser.id))
    if (choices.some((choice) => choice.id === id)) continue
    const unsupported =
      id === undefined
        ? "OpenAI does not document extension support for this browser."
        : platform === "linux" && id !== "chrome"
          ? "The Linux preview documents browser actions in Chrome only."
          : undefined
    if (
      id === undefined ||
      unsupported !== undefined ||
      !browserPath(browser.executable, platform)
    ) {
      unavailable.set(browser.id, {
        id: browser.id,
        name: browser.name ?? (id === undefined ? browser.id : labels[id]),
        reason: unsupported ?? "No local executable could be verified.",
      })
      continue
    }
    choices.push({ id, name: labels[id], executable: browser.executable })
    unavailable.delete(id)
  }
  const unavailableBrowsers =
    unavailable.size === 0 ? {} : { unavailableBrowsers: [...unavailable.values()] }
  if (choices.length === 0)
    return {
      status: "unavailable",
      desktop,
      ...unavailableBrowsers,
      reason:
        platform === "linux"
          ? "No local Google Chrome installation was detected. The Linux preview documents Chrome browser actions."
          : "No documented local browser installation was detected.",
    }
  return {
    status: "candidate",
    desktop,
    browsers: choices,
    ...unavailableBrowsers,
    url: CODEX_BROWSER_GUIDE,
    detail:
      "Confirm availability in the desktop app. Browser support depends on rollout and your workspace settings.",
    steps,
  }
})

const detachedGuide = 'test -x "$1" || exit 126; "$1" "$2" </dev/null >/dev/null 2>&1 &'
const windowsGuide = `Start-Process -FilePath $env:HOLYAGENT_SETUP_BROWSER_EXE -ArgumentList '${CODEX_BROWSER_GUIDE}' -ErrorAction Stop`

/** Requests the official setup page only after a browser from the current offer is chosen. */
export const openCodexBrowserHandoff = Effect.fn("openCodexBrowserHandoff")(function* (
  env: Env,
  offer: CodexBrowserHandoff,
  selected: CodexBrowserId | undefined,
  options: CodexBrowserHandoffOptions,
): Effect.fn.Return<Report, never, Shell> {
  if (selected === undefined) return { ok: true, lines: [] }
  const platform = options.platform ?? process.platform
  if (
    offer.status !== "candidate" ||
    offer.desktop.platform !== platform ||
    nonlocal(env, platform) !== undefined
  )
    return { ok: false, lines: ["! browser extension: the local desktop handoff is unavailable"] }
  const target = offer.browsers.find((browser) => browser.id === selected)
  if (target === undefined || !browserPath(target.executable, platform))
    return { ok: false, lines: ["! browser extension: choose a detected browser"] }
  const shell = yield* Shell
  const cwd = homeDirectory(env)
  const command = platform === "win32" ? powershell(env) : "/bin/sh"
  if (command === undefined)
    return { ok: false, lines: [`! browser extension: open ${CODEX_BROWSER_GUIDE} manually`] }
  const result =
    platform === "win32"
      ? yield* shell.run(command, powershellArgs(windowsGuide), {
          cwd,
          env: { HOLYAGENT_SETUP_BROWSER_EXE: target.executable },
        })
      : yield* shell.run(
          command,
          ["-c", detachedGuide, "holyagent-browser", target.executable, CODEX_BROWSER_GUIDE],
          { cwd },
        )
  return result.exitCode === 0
    ? {
        ok: true,
        lines: [
          `= browser extension: requested the setup guide in ${target.name}. Finish in ChatGPT desktop.`,
        ],
      }
    : {
        ok: false,
        lines: [
          `! browser extension: could not open the setup guide (exit ${result.exitCode}). Open ${CODEX_BROWSER_GUIDE} manually.`,
        ],
      }
})
