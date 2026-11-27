import { realpath, stat } from "node:fs/promises"
import { release } from "node:os"
import { isAbsolute, win32 } from "node:path"

import { Effect, Option, Schema } from "effect"

import {
  discoverBrowsers,
  isChromiumBrowser,
  systemDefaultBrowser,
} from "../../../core/src/setup/browser-discovery.ts"
import { cmdExeArguments, isBatchFile } from "../pi/bash/cmd.ts"
import { liveHost, stopGroup } from "../pi/browser-launch.ts"
import {
  browseRelaySafe,
  type BrowseRelayProbe,
  checkLocalBrowseRelay,
} from "./browse-local-relay.ts"
import { type BrowsePair, configureBrowse, planBrowse } from "./browse-setup.ts"
import {
  BROWSE_EXTENSION_IDS,
  BROWSE_EXTENSION_STORE,
  findBrowseProfiles,
  readBrowsePairing,
} from "./browse.ts"
import { readBrowserPreference } from "./browser-preferences.ts"
import { definedEnv, type Env, homeDirectory } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { type FormChoice, localGraphicalHostUnavailable } from "./form.ts"
import { hint, type Report } from "./report.ts"
import { findCommand, pathWithBunBin, Shell } from "./shell.ts"
import type { Terminal } from "./tui/session.ts"

const NAME = "OpenCode Browse"
const WAIT_SECONDS = 180
const INSTALL_WAIT_MS = 120_000
const PROFILE_CHECK_MS = 2_000
const BrowserId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/))
const isBrowserId = Schema.is(BrowserId)
const isKnownExtension = Schema.is(Schema.Literals(BROWSE_EXTENSION_IDS))

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
  const host = localGraphicalHostUnavailable(env, platform, kernel)
  if (host === "remote") return "desktop Browse is not opened in CI, SSH, WSL or a cloud session"
  if (host === "no-display") return "desktop Browse requires a local graphical session"
  return undefined
}

/** A fixed local browser executable and action from its current profile evidence. */
export type TerminalBrowsePlan = {
  readonly id: string
  readonly name: string
  readonly executable: string
  /** Recheck identity without resolving a wrapper name away when launching it. */
  readonly executableIdentity: string
} & (
  | { readonly next: "store"; readonly profile?: never; readonly extensionId?: never }
  | {
      readonly profile: string
      readonly extensionId?: string
      readonly next: "extension" | "disabled" | "pair"
    }
)

const safeProfile = (profile: string) =>
  profile !== "." && profile !== ".." && !/[\p{Cc}/\\]/u.test(profile) && profile.trim() === profile

const browserProfiles = (env: Env, browser: string, platform: string = process.platform) =>
  findBrowseProfiles(env, platform, true).pipe(
    Effect.map((profiles) => profiles.filter(({ browser: name }) => name === browser)),
  )

/** Select a Chromium executable and, if its profile can be checked, a safe next step. */
export const planTerminalBrowse = Effect.fn("planTerminalBrowse")(function* (
  env: Env,
  cwd: string,
  requested: string | undefined,
  platform: string = process.platform,
  pinnedProfile?: string,
): Effect.fn.Return<TerminalBrowsePlan, SetupFailure, Shell> {
  if (requested !== undefined && !isBrowserId(requested))
    return yield* failure("use a detected browser id with --browse-browser, for example chrome")
  const detected = yield* discoverBrowsers(env, platform)
  const compatible = detected.filter(
    (browser) => browser.executable !== undefined && isChromiumBrowser(browser),
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
  const target = { id, name: browser.name, executable, executableIdentity }
  if (browser.profileDirectory === undefined) {
    if (pinnedProfile !== undefined) return yield* failure("the selected browser profile changed")
    return { ...target, next: "store" } satisfies TerminalBrowsePlan
  }
  const profiles = yield* browserProfiles(env, browser.name, platform)
  const enabled = profiles.filter(({ extension }) => extension === "enabled")
  const profile =
    pinnedProfile !== undefined
      ? profiles.find(({ profile: name }) => name === pinnedProfile)
      : enabled.length === 1
        ? enabled[0]
        : profiles.length === 1
          ? profiles[0]
          : undefined
  if (pinnedProfile === undefined && profile === undefined && profiles.length > 1)
    return yield* failure(
      `${browser.name} has multiple possible profiles. Open the extension's Options in the intended profile and pair manually.`,
    )
  // When there are no existing profiles, open the standard Default profile explicitly and wait
  // only for installation there. A different profile appearing later is not authorization.
  const profileName = profile?.profile ?? pinnedProfile ?? "Default"
  if (!safeProfile(profileName) || profileName === "")
    return yield* failure("the detected profile cannot be opened safely; open it manually")
  if (profile?.extension === "enabled" && !isKnownExtension(profile.extensionId))
    return yield* failure(
      "the detected extension cannot be opened safely; use its Options manually",
    )
  return {
    ...target,
    profile: profileName,
    next:
      profile?.extension === "enabled"
        ? "pair"
        : profile?.extension === "disabled"
          ? "disabled"
          : "extension",
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
  /** A read-only compatibility check before the native pairing command. */
  readonly probeRelay?: BrowseRelayProbe
  /** Interrupt waiting for the user's installation without closing their browser. */
  readonly signals?: typeof liveHost.signals
}

/** Time budget for the local profile check, injectable by tests without a real desktop. */
export interface BrowseHandoffOptions {
  readonly timeoutMs?: number
  readonly intervalMs?: number
  /** A legacy explicit flag may reopen verified Options without starting another pairing. */
  readonly reopenPaired?: boolean
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
  probeRelay: browseRelaySafe,
  signals: liveHost.signals,
}

const label = (plan: TerminalBrowsePlan) =>
  plan.profile === undefined ? plan.name : `${plan.name}, ${plan.profile}`

const waitForInstall = (
  env: Env,
  target: Exclude<TerminalBrowsePlan, { next: "store" }>,
  host: BrowseDesktopHost,
  wait: BrowseHandoffOptions,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* host.signals ?? Effect.succeed(Effect.never)
      const check = Effect.gen(function* () {
        while (true) {
          const installed = (yield* browserProfiles(env, target.name)).find(
            ({ profile, extension }) => profile === target.profile && extension === "enabled",
          )
          if (isKnownExtension(installed?.extensionId)) return installed.extensionId
          yield* Effect.sleep(wait.intervalMs ?? PROFILE_CHECK_MS)
        }
      })
      return yield* Effect.raceFirst(
        check.pipe(Effect.timeoutOption(wait.timeoutMs ?? INSTALL_WAIT_MS)),
        received.pipe(Effect.as("cancelled" as const)),
      )
    }),
  )

/** Open a verified store/Options destination after successful Pi setup and recheck before pairing. */
export const runTerminalBrowse = Effect.fn("runTerminalBrowse")(function* (
  env: Env,
  cwd: string,
  packageRoot: string | undefined,
  requested: string | undefined,
  expected: TerminalBrowsePlan,
  notify: (line: string) => Effect.Effect<void>,
  host: BrowseDesktopHost = liveBrowseDesktop,
  wait: BrowseHandoffOptions = {},
) {
  const shell = yield* Shell
  const checkLocalRelay = checkLocalBrowseRelay(
    env,
    host.probeRelay ?? (() => Effect.succeed(true)),
  )
  const check = (snapshot: TerminalBrowsePlan, pin: boolean) =>
    Effect.gen(function* () {
      const current = yield* planTerminalBrowse(
        env,
        cwd,
        requested,
        process.platform,
        pin ? snapshot.profile : undefined,
      )
      if (JSON.stringify(current) !== JSON.stringify(snapshot))
        return yield* failure("the browser or selected profile changed; run setup again")
    })
  const profile = label(expected)
  const kept = `existing pairings were kept. Setup did not verify a connection for ${profile}.`
  const open = (url: string) =>
    host.open(
      expected.executable,
      expected.profile === undefined ? [url] : [`--profile-directory=${expected.profile}`, url],
      {
        cwd: homeDirectory(env),
        env,
      },
    )
  const report = yield* Effect.gen(function* () {
    yield* check(expected, false)
    if (expected.next === "disabled")
      return pending(
        `extension is disabled in ${profile}. Enable it in the browser and rerun setup.`,
      )
    if (expected.next !== "store") yield* checkLocalRelay
    if (!wait.reopenPaired && (yield* readBrowsePairing(env)).state === "paired")
      return pending(kept)
    if (expected.next === "store") {
      yield* open(BROWSE_EXTENSION_STORE)
      return pending(
        `opened the official store in ${profile}. Choose the profile and complete extension installation and pairing manually. Setup did not verify a connection.`,
      )
    }
    const ready = yield* Effect.gen(function* () {
      if (expected.next !== "extension") return expected
      yield* open(BROWSE_EXTENSION_STORE)
      yield* notify(
        `${NAME}: add the official extension in ${profile}. Setup will wait for it, then pair. Ctrl+C stops waiting.`,
      )
      const installed = yield* waitForInstall(env, expected, host, wait)
      if (installed === "cancelled") return undefined
      if (Option.isNone(installed)) return null
      return { ...expected, next: "pair", extensionId: installed.value } as const
    })
    if (ready === undefined)
      return pending(
        `stopped waiting for installation in ${profile}. Pairing did not start. Rerun setup when ready.`,
      )
    if (ready === null)
      return pending(
        `installation and pairing are pending in ${profile}. Setup did not confirm the extension. Add it in that profile, then rerun setup.`,
      )
    yield* check(ready, true)
    if (!isKnownExtension(ready.extensionId)) return yield* failure("unsupported extension")
    const options = `chrome-extension://${ready.extensionId}/settings.html`
    yield* checkLocalRelay
    const pairing = yield* readBrowsePairing(env)
    if (pairing.state === "paired") {
      if (!wait.reopenPaired) return pending(kept)
      yield* open(options)
      return pending(`opened extension Options in ${profile}; ${kept}`)
    }
    const plan = yield* planBrowse(env, packageRoot)
    if (plan.action === undefined || plan.next !== "pair")
      return yield* failure(`automatic pairing is not available. ${plan.state}`)
    let handoffFailure: string | undefined
    const pair: BrowsePair = (command, args, processOptions) =>
      Effect.gen(function* () {
        yield* check(ready, true)
        yield* checkLocalRelay
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
    Effect.timeoutOption(
      (WAIT_SECONDS + 55) * 1000 +
        (expected.next === "extension" ? (wait.timeoutMs ?? INSTALL_WAIT_MS) : 0),
    ),
    Effect.map(Option.getOrElse(() => failed("handoff timed out; pairing was not confirmed"))),
    Effect.catchTag("SetupFailure", ({ message }) => Effect.succeed(failed(message))),
  )
  return report
})
