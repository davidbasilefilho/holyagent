import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Data, Effect, Option } from "effect"

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
  /** A TCP port nothing listens on, on 127.0.0.1. */
  readonly freePort: Effect.Effect<number, BrowserLaunchFailed>
  /** Whether the DevTools endpoint at the URL answers. */
  readonly answers: (url: string) => Effect.Effect<boolean>
  /** Creates a new, empty directory in the system's temporary folder and returns its path. */
  readonly temporaryDirectory: (prefix: string) => Effect.Effect<string, BrowserLaunchFailed>
  /** Creates a directory inside a temporary one. */
  readonly makeDirectory: (path: string) => Effect.Effect<void, BrowserLaunchFailed>
  /** Removes a directory and everything in it; a directory that is gone is not an error. */
  readonly removeDirectory: (path: string) => Effect.Effect<void>
  /** Completes with the exit code to end with when a termination signal arrives. */
  readonly interrupted: Effect.Effect<number>
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
 * The arguments that start Chromium headless with its DevTools endpoint on `port` of 127.0.0.1 only
 * and a profile in `profile`, a folder of the run. With `sandbox` off, which only a root process
 * needs (Chromium refuses to run as root otherwise), `--no-sandbox` is added.
 */
export const chromiumArguments = (
  port: number,
  profile: string,
  sandbox: boolean,
): ReadonlyArray<string> => [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-dev-shm-usage",
  ...(sandbox ? [] : ["--no-sandbox"]),
  "about:blank",
]

/**
 * The environment of the browser-use server: the inherited one, then the DevTools URL of the
 * browser it attaches to, a name for its session, telemetry off, and its config and state in
 * `config` and `harness`, folders of the run, so nothing is written to the user's own.
 */
export const serverEnvironment = (
  inherited: Env,
  port: number,
  folders: { readonly config: string; readonly harness: string },
): Record<string, string> => ({
  ...definedEnv(inherited),
  BU_CDP_URL: `http://127.0.0.1:${port}`,
  BU_NAME: `holyagent-${port}`,
  ANONYMIZED_TELEMETRY: "0",
  BROWSER_USE_CONFIG_DIR: folders.config,
  BH_HOME: folders.harness,
  BROWSER_HARNESS_HOME: folders.harness,
})

const failed = (reason: string) => new BrowserLaunchFailed({ reason })

// Waits until the DevTools endpoint answers, for at most `timeoutMs`, and fails early when Chromium
// exits first (a bad executable or a profile it cannot use).
const awaitDevTools = (
  host: LaunchHost,
  chromium: Running,
  url: string,
  timeoutMs: number,
  pollMs: number,
) => {
  const poll: Effect.Effect<void> = Effect.suspend(() =>
    host
      .answers(url)
      .pipe(
        Effect.flatMap((ok) =>
          ok ? Effect.void : Effect.sleep(pollMs).pipe(Effect.andThen(poll)),
        ),
      ),
  )
  const answered = poll.pipe(
    Effect.timeoutOption(timeoutMs),
    Effect.flatMap((result) =>
      Option.isSome(result)
        ? Effect.void
        : Effect.fail(failed(`the DevTools endpoint ${url} did not answer within ${timeoutMs} ms`)),
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

/**
 * Runs the browser-use MCP server against a headless Chromium it starts, and returns the server's
 * exit code. In order: a temporary directory for the run (the profile, browser-use's config and its
 * state); a free port; Chromium, headless, with its DevTools endpoint on that port of 127.0.0.1 and
 * a fresh profile; a wait until the endpoint answers; then the server with `BU_CDP_URL` and the
 * variables of {@link serverEnvironment}, on this process's stdio. The run ends when the server
 * exits, when Chromium exits under it, or when a termination signal arrives. Every step that
 * succeeded is undone in reverse order whatever ends the run, a failed start included: the server
 * is stopped, then Chromium, and the temporary directory is removed.
 */
export const runBrowserServer = (host: LaunchHost, options: BrowserServerOptions) =>
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
      const port = yield* host.freePort
      const inherited = definedEnv(options.env)
      const chromium = yield* Effect.acquireRelease(
        host.spawn({
          command: executable,
          args: chromiumArguments(port, folders.profile, !host.root),
          env: inherited,
          stdio: "ignore",
        }),
        (running) => running.stop,
      )
      yield* awaitDevTools(
        host,
        chromium,
        `http://127.0.0.1:${port}/json/version`,
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
      return yield* Effect.raceFirst(Effect.raceFirst(server.exited, host.interrupted), browserLost)
    }),
  )

const SIGNALS = [
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
] as const

const reason = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

// Ends a process group: asks it to end, waits up to the grace, then kills what is left. A process
// that is already gone is left alone, since its pid may belong to an unrelated group by now.
const stopGroup = (child: Bun.Subprocess) =>
  Effect.gen(function* () {
    if (child.exitCode !== null) return
    yield* Effect.try(() =>
      process.platform === "win32" ? child.kill() : process.kill(-child.pid, "SIGTERM"),
    ).pipe(Effect.ignore)
    const done = yield* Effect.promise(() => child.exited).pipe(Effect.timeoutOption(STOP_GRACE_MS))
    if (Option.isNone(done) && child.exitCode === null) yield* killGroup(child)
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
  freePort: Effect.try({
    try: () => {
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
      const { port } = probe
      probe.stop(true)
      return port
    },
    catch: (cause) => failed(`cannot find a free port: ${reason(cause)}`),
  }),
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
  interrupted: Effect.callback<number>((resume) => {
    const handlers = SIGNALS.map(([name, code]) => {
      const handler = () => resume(Effect.succeed(code))
      process.once(name, handler)
      return [name, handler] as const
    })
    return Effect.sync(() => {
      for (const [name, handler] of handlers) process.off(name, handler)
    })
  }),
  root: process.getuid?.() === 0,
}
