import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Data, Deferred, Effect, Option, type Scope } from "effect"

import { definedEnv, type Env } from "../setup/environment.ts"
import { killGroup } from "../state/tree.ts"

/** The Chromium or the server of the headless browser could not be started or kept running. */
export class BrowserLaunchFailed extends Data.TaggedError("BrowserLaunchFailed")<{
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return this.reason
  }
}

/** A process to start: its program, arguments, complete environment and what it does with stdio. */
export interface ProcessSpec {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  /** `inherit` gives the process this process's stdin, stdout and stderr; `ignore` discards them. */
  readonly stdio: "inherit" | "ignore"
}

/** A process the launcher started. */
export interface Running {
  /** The exit code, once the process has exited. */
  readonly exited: Effect.Effect<number>
  /** Ends the process and what it started, then waits for it to be gone; harmless once it exited. */
  readonly stop: Effect.Effect<void>
}

/**
 * What the launcher needs from the machine; {@link liveHost} is the real one and a test passes
 * fakes, so that no browser or server is ever started to test the launch and its cleanup.
 */
export interface LaunchHost {
  /** Starts a process. */
  readonly spawn: (spec: ProcessSpec) => Effect.Effect<Running, BrowserLaunchFailed>
  /**
   * The DevTools port Chromium reports in the `DevToolsActivePort` file of the profile folder, or
   * `undefined` while the file is missing or incomplete.
   */
  readonly devToolsPort: (profile: string) => Effect.Effect<number | undefined>
  /** Whether the DevTools endpoint at the URL answers. */
  readonly answers: (url: string) => Effect.Effect<boolean>
  /** Creates a new, empty directory in the system's temporary folder and returns its path. */
  readonly temporaryDirectory: (prefix: string) => Effect.Effect<string, BrowserLaunchFailed>
  /** Creates a directory inside a temporary one. */
  readonly makeDirectory: (path: string) => Effect.Effect<void, BrowserLaunchFailed>
  /** Removes a directory and everything in it; a directory that is gone is not an error. */
  readonly removeDirectory: (path: string) => Effect.Effect<void>
  /**
   * Handles `SIGINT`, `SIGTERM` and `SIGHUP` for as long as the scope is open, so that a signal
   * never ends the process on its own, and returns an effect that completes with the exit code to
   * end with once the first one has arrived. Later signals change nothing.
   */
  readonly signals: Effect.Effect<Effect.Effect<number>, never, Scope.Scope>
  /** Whether this process runs as root, where Chromium refuses to start with its sandbox on. */
  readonly root: boolean
}

/** What one run of the launcher starts and how it waits. */
export interface BrowserServerOptions {
  /** The environment the server inherits, before the launcher sets its own variables. */
  readonly env: Env
  /** The Chromium executable to start, or `undefined` when the machine has none. */
  readonly chromium: string | undefined
  /** How the person gets a Chromium, appended to the failure when there is none. */
  readonly chromiumFix: string
  /** The MCP server to run against the browser: its program and arguments. */
  readonly server: { readonly command: string; readonly args: ReadonlyArray<string> }
  /** The longest to wait for the DevTools endpoint to answer, in milliseconds. */
  readonly readyTimeoutMs?: number
  /** The pause between two questions to the DevTools endpoint, in milliseconds. */
  readonly pollMs?: number
}

/** The default of {@link BrowserServerOptions.readyTimeoutMs}. */
export const READY_TIMEOUT_MS = 20_000

/** The default of {@link BrowserServerOptions.pollMs}. */
export const POLL_MS = 100

/** How long a stopped process may take to exit before its process group is killed, in milliseconds. */
export const STOP_GRACE_MS = 3_000

/** The folders inside the temporary directory of a run, by purpose. */
const FOLDERS = { profile: "profile", config: "browser-use", harness: "harness" } as const

/**
 * The arguments that start Chromium headless with its DevTools endpoint on 127.0.0.1 only and a
 * profile in `profile`, a folder of the run. The port is 0, so Chromium binds one itself and writes
 * it to `DevToolsActivePort` in the profile: a port probed beforehand could be taken by another
 * process before Chromium binds it. With `sandbox` off, which only a root process needs (Chromium
 * refuses to run as root otherwise), `--no-sandbox` is added.
 */
export const chromiumArguments = (profile: string, sandbox: boolean): ReadonlyArray<string> => [
  "--headless=new",
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  ...(sandbox ? [] : ["--no-sandbox"]),
  "about:blank",
]

/**
 * The variables of the inherited environment that reach the browser-use server (`uvx` and the
 * Python it runs), matched without regard to case because Windows names are case-insensitive, and
 * every `LC_*`. Only what a process needs to run, find its programs, reach the network through the
 * person's proxy and certificates, and reuse uv's cache. Everything else stays behind: `UV_INDEX*`,
 * `UV_FIND_LINKS`, `PIP_*` and `PYTHONPATH` could redirect where the code of a server with browser
 * control comes from, and the provider API keys and tokens of the environment would otherwise reach
 * the Python that `browser_exec` runs.
 */
export const SERVER_ENVIRONMENT_ALLOWLIST: ReadonlyArray<string> = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "TZ",
  "TERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  "UV_CACHE_DIR",
  "UV_NATIVE_TLS",
  // Windows needs these to start a process and to find its profile and programs.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
]

const ALLOWED_NAMES: ReadonlySet<string> = new Set(SERVER_ENVIRONMENT_ALLOWLIST)

const reachesServer = (name: string) => {
  const upper = name.toUpperCase()
  return ALLOWED_NAMES.has(upper) || upper.startsWith("LC_")
}

/**
 * The environment of the browser-use server: the part of the inherited one that
 * {@link SERVER_ENVIRONMENT_ALLOWLIST} lets through, then the DevTools URL of the browser it
 * attaches to, a name for its session, telemetry off, and its config and state in `config` and
 * `harness`, folders of the run, so nothing is written to the user's own.
 */
export const serverEnvironment = (
  inherited: Env,
  port: number,
  folders: { readonly config: string; readonly harness: string },
): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(definedEnv(inherited)).filter(([name]) => reachesServer(name)),
  ),
  BU_CDP_URL: `http://127.0.0.1:${port}`,
  BU_NAME: `holyagent-${port}`,
  ANONYMIZED_TELEMETRY: "0",
  BROWSER_USE_CONFIG_DIR: folders.config,
  BH_HOME: folders.harness,
  BROWSER_HARNESS_HOME: folders.harness,
})

/**
 * The port in the text of a `DevToolsActivePort` file: its first line, which Chromium ends with a
 * newline, so a half-written line is not taken. `undefined` when there is no complete, valid port.
 */
export const parseDevToolsActivePort = (text: string): number | undefined => {
  const [line, rest] = text.split("\n")
  if (line === undefined || rest === undefined) return undefined
  const port = Number(line.trim())
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined
}

const failed = (reason: string) => new BrowserLaunchFailed({ reason })

// Waits until Chromium has reported its DevTools port and that port answers, for at most
// `timeoutMs`, and returns the port. It fails early when Chromium exits first (a bad executable or
// a profile it cannot use).
const awaitDevTools = (
  host: LaunchHost,
  chromium: Running,
  profile: string,
  timeoutMs: number,
  pollMs: number,
) => {
  const again = (poll: Effect.Effect<number>) => Effect.sleep(pollMs).pipe(Effect.andThen(poll))
  const poll: Effect.Effect<number> = Effect.suspend(() =>
    host
      .devToolsPort(profile)
      .pipe(
        Effect.flatMap((port) =>
          port === undefined
            ? again(poll)
            : host
                .answers(`http://127.0.0.1:${port}/json/version`)
                .pipe(Effect.flatMap((ok) => (ok ? Effect.succeed(port) : again(poll)))),
        ),
      ),
  )
  const answered = poll.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.succeed(result.value)
        : Effect.fail(failed(`the DevTools endpoint did not answer within ${timeoutMs} ms`)),
    ),
  )
  const exitedFirst = chromium.exited.pipe(
    Effect.flatMap((code) =>
      Effect.fail(
        failed(`Chromium exited with code ${code} before its DevTools endpoint answered`),
      ),
    ),
  )
  return Effect.raceFirst(answered, exitedFirst)
}

// The run itself: every step that succeeded is undone when the scope closes, in reverse order.
const launch = (host: LaunchHost, options: BrowserServerOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { chromium: executable } = options
      if (executable === undefined)
        return yield* failed(`no Chromium was found; ${options.chromiumFix}`)
      const base = yield* Effect.acquireRelease(
        host.temporaryDirectory("holyagent-browser-"),
        (path) => host.removeDirectory(path),
      )
      const folders = {
        profile: join(base, FOLDERS.profile),
        config: join(base, FOLDERS.config),
        harness: join(base, FOLDERS.harness),
      }
      for (const folder of Object.values(folders)) yield* host.makeDirectory(folder)
      const inherited = definedEnv(options.env)
      const chromium = yield* Effect.acquireRelease(
        host.spawn({
          command: executable,
          args: chromiumArguments(folders.profile, !host.root),
          env: inherited,
          stdio: "ignore",
        }),
        (running) => running.stop,
      )
      const port = yield* awaitDevTools(
        host,
        chromium,
        folders.profile,
        options.readyTimeoutMs ?? READY_TIMEOUT_MS,
        options.pollMs ?? POLL_MS,
      )
      const server = yield* Effect.acquireRelease(
        host.spawn({
          command: options.server.command,
          args: options.server.args,
          env: serverEnvironment(inherited, port, folders),
          stdio: "inherit",
        }),
        (running) => running.stop,
      )
      const browserLost = chromium.exited.pipe(
        Effect.flatMap((code) =>
          Effect.fail(failed(`Chromium exited with code ${code} while the server was running`)),
        ),
      )
      return yield* Effect.raceFirst(server.exited, browserLost)
    }),
  )

/**
 * Runs the browser-use MCP server against a headless Chromium it starts, and returns the server's
 * exit code. In order: a temporary directory for the run (the profile, browser-use's config and its
 * state); Chromium, headless, with its DevTools endpoint on a port of 127.0.0.1 that Chromium picks
 * and reports in the profile, and a fresh profile; a wait until that port answers; then the server
 * with `BU_CDP_URL` and the variables of {@link serverEnvironment}, on this process's stdio. The
 * run ends when the server exits, when Chromium exits under it, or when a termination signal
 * arrives. Every step that succeeded is undone in reverse order whatever ends the run, a failed
 * start included: the server is stopped, then Chromium, and the temporary directory is removed. The
 * signal handlers are installed before the first step and stay until the last undo is done, so a
 * signal at any point, a repeated one during cleanup included, ends the run through its cleanup and
 * never around it.
 */
export const runBrowserServer = (host: LaunchHost, options: BrowserServerOptions) =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* host.signals
      return yield* Effect.raceFirst(launch(host, options), received)
    }),
  )

const SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

// Asks the process group the child leads to end. Nothing is signalled when the pid is not a real
// child's: a pid of 0 or 1 would make the negative one reach every process the user may signal. A
// group that is already empty answers ESRCH, which is ignored.
const terminateGroup = (child: Pick<Bun.Subprocess, "pid">) =>
  Effect.try(() => {
    if (Number.isInteger(child.pid) && child.pid > 1) process.kill(-child.pid, "SIGTERM")
  }).pipe(Effect.ignore)

/**
 * Ends the process group a child leads and waits for the child to be gone. On Unix the group is
 * asked to end, given {@link STOP_GRACE_MS} for the child to exit, then killed, and the group is
 * signalled even when the child exited already: the helpers it started (Chromium's renderers, a
 * server's workers) stay in the group and outlive their leader. Once the leader is reaped its pid
 * could in principle belong to an unrelated group, but a group id is not reused while any member
 * lives, and an empty group only answers ESRCH, so the signal is the safer side of that risk. On
 * Windows, which has no group signals, `taskkill /T /F` ends the whole tree at once, since waiting
 * out a grace for a process with no signal to ask it gives it nothing. `platform` is a parameter so
 * a test can stand in for either system.
 */
export const stopGroup = (
  child: Pick<Bun.Subprocess, "pid" | "kill" | "exited">,
  platform: string = process.platform,
) =>
  Effect.gen(function* () {
    const exit = Effect.promise(() => child.exited).pipe(Effect.timeoutOption(STOP_GRACE_MS))
    if (platform === "win32") {
      yield* killGroup(child, platform)
      yield* exit
      return
    }
    yield* terminateGroup(child)
    yield* exit
    yield* killGroup(child, platform)
  })

/**
 * The real machine for {@link runBrowserServer}. A process leads a process group of its own
 * (`detached`), so that stopping it also ends the helpers it started; the Bun Shell cannot kill a
 * process, so these long-running ones use `Bun.spawn`.
 */
export const liveHost: LaunchHost = {
  spawn: (spec) =>
    Effect.try({
      try: () => {
        const child = Bun.spawn({
          cmd: [spec.command, ...spec.args],
          env: { ...spec.env },
          stdin: spec.stdio === "inherit" ? "inherit" : "ignore",
          stdout: spec.stdio === "inherit" ? "inherit" : "ignore",
          stderr: spec.stdio === "inherit" ? "inherit" : "ignore",
          detached: true,
        })
        return {
          exited: Effect.promise(() => child.exited),
          stop: stopGroup(child),
        } satisfies Running
      },
      catch: (cause) => failed(`cannot start ${spec.command}: ${reason(cause)}`),
    }),
  devToolsPort: (profile) =>
    Effect.tryPromise(() => Bun.file(join(profile, "DevToolsActivePort")).text()).pipe(
      Effect.map(parseDevToolsActivePort),
      Effect.orElseSucceed(() => undefined),
    ),
  answers: (url) =>
    Effect.tryPromise(() => fetch(url, { signal: AbortSignal.timeout(1_000) })).pipe(
      Effect.map((response) => response.ok),
      Effect.orElseSucceed(() => false),
    ),
  temporaryDirectory: (prefix) =>
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), prefix)),
      catch: (cause) => failed(`cannot create a temporary directory: ${reason(cause)}`),
    }),
  makeDirectory: (path) =>
    Effect.tryPromise({
      try: () => mkdir(path, { recursive: true }),
      catch: (cause) => failed(`cannot create ${path}: ${reason(cause)}`),
    }).pipe(Effect.asVoid),
  removeDirectory: (path) =>
    Effect.tryPromise(() => rm(path, { recursive: true, force: true, maxRetries: 5 })).pipe(
      Effect.ignore,
    ),
  signals: Effect.acquireRelease(
    Effect.sync(() => {
      const received = Deferred.makeUnsafe<number>()
      const handlers = SIGNALS.map(([name, code]) => {
        const handler = () => void Deferred.doneUnsafe(received, Effect.succeed(code))
        process.on(name, handler)
        return [name, handler] as const
      })
      return { received, handlers }
    }),
    ({ handlers }) =>
      Effect.sync(() => {
        for (const [name, handler] of handlers) process.off(name, handler)
      }),
  ).pipe(Effect.map(({ received }) => Deferred.await(received))),
  root: process.getuid?.() === 0,
}
