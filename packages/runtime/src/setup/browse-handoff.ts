import { realpath, stat } from "node:fs/promises"
import { release } from "node:os"
import { isAbsolute, join, win32 } from "node:path"

import { Effect, Option, Schema } from "effect"

import {
  discoverBrowsers,
  systemDefaultBrowser,
} from "../../../core/src/setup/browser-discovery.ts"
import { readJsonObjectSnapshot } from "../../../core/src/setup/json-file.ts"
import { inCloudSession } from "../../../core/src/vcs/identity.ts"
import { cmdExeArguments, isBatchFile } from "../pi/bash/cmd.ts"
import { liveHost, stopGroup } from "../pi/browser-launch.ts"
import { type BrowsePair, configureBrowse, planBrowse } from "./browse-setup.ts"
import {
  BROWSE_EXTENSION_IDS,
  BROWSE_EXTENSION_STORE,
  findBrowseProfiles,
  readBrowsePairing,
} from "./browse.ts"
import { readBrowserPreference } from "./browser-preferences.ts"
import { definedEnv, type Env, firstNonEmpty, homeDirectory } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { type FormChoice, hasDisplay, inCi } from "./form.ts"
import { hint, type Report } from "./report.ts"
import { findCommand, pathWithBunBin, Shell } from "./shell.ts"
import type { Terminal } from "./tui/session.ts"

const NAME = "OpenCode Browse"
const WAIT_SECONDS = 180
const BrowserId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/))
const isBrowserId = Schema.is(BrowserId)
const isKnownExtension = Schema.is(Schema.Literals(BROWSE_EXTENSION_IDS))
const remoteVariables = [
  "SSH_CLIENT",
  "SSH_CONNECTION",
  "SSH_TTY",
  "WSL_DISTRO_NAME",
  "WSL_INTEROP",
  "CODEX_CAAS_SESSION_ID",
] as const

const failure = (message: string) => new SetupFailure({ message })
const failed = (detail: string): Report => ({ ok: false, lines: [`! ${NAME}: ${detail}`] })
const pending = (detail: string): Report => ({ ok: true, lines: [hint(`${NAME}: ${detail}`)] })

/** The terminal, selected capability form and execution flags for a desktop handoff. */
export interface BrowseTerminalMode {
  readonly terminal: Terminal | undefined
  readonly form: FormChoice
  readonly dryRun: boolean
  readonly nonInteractive: boolean
}

/** Explain why desktop launch cannot run, independently of an explicit `--form normal`. */
export const terminalBrowseUnavailable = (
  env: Env,
  mode: BrowseTerminalMode,
  platform: string = process.platform,
  kernel: string = release(),
): string | undefined => {
  if (mode.dryRun) return "dry run does not open a browser or start pairing"
  if (mode.nonInteractive) return "--non-interactive never opens a browser or starts pairing"
  if (mode.form.form !== "normal") return "desktop Browse requires normal form"
  if (!mode.terminal?.stdin || !mode.terminal.stdout || env.TERM?.toLowerCase() === "dumb")
    return "desktop Browse requires an interactive terminal"
  if (
    inCi(env) ||
    inCloudSession(env) ||
    remoteVariables.some((name) => firstNonEmpty(env[name]) !== undefined) ||
    (platform === "linux" && /microsoft|wsl/i.test(kernel))
  )
    return "desktop Browse is not opened in CI, SSH, WSL or a cloud session"
  if (
    !["darwin", "linux", "win32"].includes(platform) ||
    !hasDisplay(env, platform) ||
    (platform === "linux" &&
      !firstNonEmpty(env.WAYLAND_DISPLAY) &&
      !/^(?:unix)?:\d+(?:\.\d+)?$/.test(env.DISPLAY ?? "")) ||
    (platform === "win32" && env.SESSIONNAME?.toLowerCase() === "services")
  )
    return "desktop Browse requires a local graphical session"
  return undefined
}

/** A fixed local browser executable and action from its current profile evidence. */
export interface TerminalBrowsePlan {
  readonly id: string
  readonly name: string
  readonly executable: string
  /** Recheck identity without resolving a wrapper name away when launching it. */
  readonly executableIdentity: string
  readonly profile?: string
  readonly extensionId?: string
  readonly next: "extension" | "disabled" | "pair"
}

const safeProfile = (profile: string) =>
  profile !== "." && profile !== ".." && !/[\p{Cc}/\\]/u.test(profile) && profile.trim() === profile

/** Select one compatible executable and at most one profile, without opening anything. */
export const planTerminalBrowse = Effect.fn("planTerminalBrowse")(function* (
  env: Env,
  cwd: string,
  requested: string | undefined,
  platform: string = process.platform,
) {
  if (requested !== undefined && !isBrowserId(requested))
    return yield* failure("use a detected browser id with --browse-browser, for example chrome")
  const detected = yield* discoverBrowsers(env, platform)
  const compatible = detected.filter(
    ({ executable, browseCompatibility }) =>
      executable !== undefined && browseCompatibility === "supported",
  )
  const choices = compatible.map(({ id }) => id).join(", ") || "none detected"
  const saved = requested === undefined ? (yield* readBrowserPreference(env)).browsers : undefined
  if (requested === undefined && saved !== undefined && saved.length !== 1)
    return yield* failure(
      `saved browser selection is not a single browser; use --browse-browser (choices: ${choices})`,
    )
  const id =
    requested ??
    (saved === undefined ? yield* systemDefaultBrowser(env, cwd, compatible, platform) : saved[0])
  if (id === undefined)
    return yield* failure(
      `no compatible system default; use --browse-browser (choices: ${choices})`,
    )
  const browser = compatible.find((item) => item.id === id)
  if (browser?.executable === undefined)
    return yield* failure(
      `browser "${id}" has no compatible detected executable (choices: ${choices})`,
    )
  const { executable } = browser
  const inspect = (path: string) =>
    Effect.tryPromise({
      try: () => stat(path),
      catch: () => failure("the detected browser executable changed or is unavailable"),
    })
  const actual = yield* Effect.tryPromise({
    try: () => realpath(executable),
    catch: () => failure("the detected browser executable changed or is unavailable"),
  })
  const file = yield* inspect(actual)
  if (!file.isFile()) return yield* failure("the detected browser is not an executable file")
  const executableIdentity = JSON.stringify([
    actual,
    file.dev,
    file.ino,
    file.size,
    file.mtimeMs,
    file.ctimeMs,
  ])
  const profiles = (yield* findBrowseProfiles(env, platform, true)).filter(
    ({ browser: name }) => name === browser.name,
  )
  const enabled = profiles.filter(({ extension }) => extension === "enabled")
  const profile =
    enabled.length === 1 ? enabled[0] : profiles.length === 1 ? profiles[0] : undefined
  if (profile === undefined && profiles.length > 1)
    return yield* failure(
      `${browser.name} has multiple possible profiles. Open the extension's Options in the intended profile and pair manually.`,
    )
  if (profile !== undefined && (!safeProfile(profile.profile) || profile.profile === ""))
    return yield* failure("the detected profile cannot be opened safely; open it manually")
  if (profile?.extension === "enabled" && !isKnownExtension(profile.extensionId))
    return yield* failure(
      "the detected extension cannot be opened safely; use its Options manually",
    )
  return {
    id,
    name: browser.name,
    executable,
    executableIdentity,
    next:
      profile?.extension === "enabled"
        ? "pair"
        : profile?.extension === "disabled"
          ? "disabled"
          : "extension",
    ...(profile === undefined ? {} : { profile: profile.profile }),
    ...(profile?.extensionId === undefined ? {} : { extensionId: profile.extensionId }),
  } satisfies TerminalBrowsePlan
})

/** Only the already selected browser and the official pairing runner may be opened. */
export interface BrowseDesktopHost {
  readonly open: (
    command: string,
    args: ReadonlyArray<string>,
    options: { readonly cwd: string; readonly env: Env },
  ) => Effect.Effect<void, SetupFailure>
  readonly pair: BrowsePair
}

// The browser needs the desktop session and its own profile, not credentials in the invoking
// terminal. Paths and session environment are the same as those discovery used.
const browserEnvironment = (env: Env) =>
  definedEnv(
    Object.fromEntries(
      Object.entries(env).filter(([name]) =>
        /^(?:HOME|USERPROFILE|USER|USERNAME|LOGNAME|PATH|SHELL|SYSTEMROOT|WINDIR|PROGRAMFILES(?:\(X86\))?|PROGRAMDATA|LOCALAPPDATA|APPDATA|TMP(?:DIR)?|TEMP|LANG(?:UAGE)?|LC_.*|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|DBUS_SESSION_BUS_ADDRESS|XDG_.*|GTK_.*|QT_.*|SESSIONNAME)$/i.test(
          name,
        ),
      ),
    ),
  )

const livePair: BrowsePair = (command, args, { cwd, env }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const signal = yield* liveHost.signals
      const path = pathWithBunBin(env, { home: homeDirectory(env), bunInstall: env.BUN_INSTALL })
      const resolved = Option.getOrUndefined(findCommand(env, command, { includeBunBin: true }))
      if (resolved === undefined || !isAbsolute(resolved)) return 127
      const pairArgs = [...args, "--wait-seconds", String(WAIT_SECONDS)]
      const batch =
        process.platform === "win32" && isBatchFile(resolved)
          ? cmdExeArguments(resolved, pairArgs)
          : undefined
      if (batch?.ok === false) return 127
      const windowsRoot = Object.entries(env).find(
        ([name, value]) => /^(systemroot|windir)$/i.test(name) && value !== undefined,
      )?.[1]
      const application =
        batch?.ok !== true
          ? resolved
          : windowsRoot !== undefined && /^[a-z]:[/\\]/i.test(windowsRoot)
            ? win32.join(windowsRoot, "System32", "cmd.exe")
            : undefined
      if (application === undefined) return 127
      const child = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.spawn({
              cmd: [application, ...(batch?.ok === true ? batch.args : pairArgs)],
              cwd,
              env: definedEnv({ ...env, [path.key]: path.value }),
              stdin: "ignore",
              stdout: "inherit",
              stderr: "inherit",
              detached: true,
            }),
          catch: () => failure("could not start the pinned Browse pairing command"),
        }),
        (child) => (child.exitCode === null ? stopGroup(child) : Effect.void),
      )
      return yield* Effect.raceFirst(
        Effect.promise(() => child.exited).pipe(
          Effect.timeoutOption((WAIT_SECONDS + 30) * 1000),
          Effect.map(Option.getOrElse(() => 124)),
        ),
        signal,
      )
    }),
  ).pipe(Effect.orElseSucceed(() => 127))

/** Launches no browser through a shell or default handler, and never inherits browser stdin. */
export const liveBrowseDesktop: BrowseDesktopHost = {
  open: (command, args, { cwd, env }) =>
    Effect.gen(function* () {
      const child = yield* Effect.try({
        try: () =>
          Bun.spawn({
            cmd: [command, ...args],
            cwd,
            env: browserEnvironment(env),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            detached: true,
          }),
        catch: () => failure("could not start the selected browser"),
      })
      child.unref()
      const early = yield* Effect.promise(() => child.exited).pipe(Effect.timeoutOption(250))
      if (Option.isSome(early) && early.value !== 0)
        return yield* failure("the selected browser quit before opening Browse")
    }),
  pair: livePair,
}

const label = (plan: TerminalBrowsePlan) =>
  plan.profile === undefined ? plan.name : `${plan.name}, ${plan.profile}`

const checkLocalRelay = Effect.fn("checkBrowseDesktopRelay")(function* (env: Env) {
  const custom = firstNonEmpty(env.OPENCODE_BROWSER_HOME)
  if (custom !== undefined && !isAbsolute(custom))
    return yield* failure("OPENCODE_BROWSER_HOME must be absolute for automatic pairing")
  const config = firstNonEmpty(env.XDG_CONFIG_HOME)
  const root =
    custom ??
    join(
      config !== undefined && isAbsolute(config) ? config : join(homeDirectory(env), ".config"),
      "browse",
    )
  const { value } = yield* readJsonObjectSnapshot(join(root, "config.json"))
  const hostname = value.hostname
  if (
    hostname !== undefined &&
    (typeof hostname !== "string" ||
      !["127.0.0.1", "::1", "[::1]", "localhost"].includes(hostname.trim().toLowerCase()))
  )
    return yield* failure(
      "the existing Browse relay is configured for remote access. Use Browse's own instructions instead of this local handoff",
    )
})

/** Open a verified store/Options destination after successful Pi setup and recheck before pairing. */
export const runTerminalBrowse = Effect.fn("runTerminalBrowse")(function* (
  env: Env,
  cwd: string,
  packageRoot: string | undefined,
  requested: string | undefined,
  expected: TerminalBrowsePlan,
  notify: (line: string) => Effect.Effect<void>,
  host: BrowseDesktopHost = liveBrowseDesktop,
) {
  const shell = yield* Shell
  const check = Effect.gen(function* () {
    const current = yield* planTerminalBrowse(env, cwd, requested)
    if (JSON.stringify(current) !== JSON.stringify(expected))
      return yield* failure("the browser or selected profile changed; run setup again")
  })
  const profile = label(expected)
  const open = (url: string) =>
    host.open(
      expected.executable,
      [...(expected.profile === undefined ? [] : [`--profile-directory=${expected.profile}`]), url],
      {
        cwd: homeDirectory(env),
        env,
      },
    )
  const report = yield* Effect.gen(function* () {
    yield* check
    if (expected.next === "disabled")
      return pending(
        `extension is disabled in ${profile}. Enable it in the browser and rerun setup.`,
      )
    if (expected.next === "extension") {
      yield* open(BROWSE_EXTENSION_STORE)
      return pending(
        `opened the official extension store in ${profile}. Installation and pairing are pending. Add the extension, then rerun setup.`,
      )
    }
    if (!isKnownExtension(expected.extensionId)) return yield* failure("unsupported extension")
    const options = `chrome-extension://${expected.extensionId}/settings.html`
    yield* checkLocalRelay(env)
    const pairing = yield* readBrowsePairing(env)
    if (pairing.state === "paired") {
      yield* open(options)
      return pending(
        `opened extension Options in ${profile}. Existing pairings were kept. Setup did not verify a connection for this profile.`,
      )
    }
    const plan = yield* planBrowse(env, packageRoot)
    if (plan.action === undefined || plan.next !== "pair")
      return yield* failure(`automatic pairing is not available. ${plan.state}`)
    let handoffFailure: string | undefined
    const pair: BrowsePair = (command, args, processOptions) =>
      Effect.gen(function* () {
        yield* check
        yield* checkLocalRelay(env)
        if ((yield* readBrowsePairing(env)).state !== "unpaired")
          return yield* failure("pairing state changed; existing pairings were kept")
        yield* open(options)
        return yield* host.pair(command, args, processOptions)
      }).pipe(
        Effect.provideService(Shell, shell),
        Effect.catchTag("SetupFailure", ({ message }) => {
          handoffFailure = message
          return Effect.succeed(125)
        }),
      )
    const result = yield* configureBrowse(
      env,
      { ...plan, targets: [{ next: "pair", target: profile }] },
      pair,
      notify,
    )
    if (handoffFailure !== undefined) return failed(handoffFailure)
    return result.ok
      ? {
          ...result,
          lines: [
            ...result.lines,
            hint(`${NAME}: Browse confirms code redemption, not which local profile received it.`),
          ],
        }
      : result
  }).pipe(
    Effect.timeoutOption((WAIT_SECONDS + 55) * 1000),
    Effect.map(Option.getOrElse(() => failed("handoff timed out; pairing was not confirmed"))),
    Effect.catchTag("SetupFailure", ({ message }) => Effect.succeed(failed(message))),
  )
  return report
})
