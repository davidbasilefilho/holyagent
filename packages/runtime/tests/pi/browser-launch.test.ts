import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { BROWSER_USE_MCP_SERVER, CHROMIUM_FIX } from "../../src/config/capabilities.ts"
import {
  BrowserLaunchFailed,
  type BrowserServerOptions,
  chromiumArguments,
  type LaunchHost,
  liveHost,
  parseDevToolsActivePort,
  type ProcessSpec,
  runBrowserServer,
  type Running,
  SERVER_ENVIRONMENT_ALLOWLIST,
  serverEnvironment,
  stopGroup,
} from "../../src/pi/browser-launch.ts"

const BASE = "/tmp/holyagent-browser-test"
/** The port the fake Chromium reports, which the launcher never chose. */
const PORT = 41_234
const failure = (reason: string) => new BrowserLaunchFailed({ reason })

interface Fakes {
  /** What the launcher did to the machine, in order. */
  readonly events: Array<string>
  readonly spawned: Array<ProcessSpec>
  readonly host: LaunchHost
}

/**
 * A machine that starts nothing: each process is a record in `events`. `chromium` and `server`
 * decide what the processes do (exit at once, never exit, or fail to start), `portAfter` how many
 * reads of `DevToolsActivePort` find nothing before Chromium reports its port, `notAnswering` how
 * many questions the DevTools endpoint gets wrong before it answers, and `stopMs` how long stopping
 * a process takes.
 */
const fakes = (
  behaviors: {
    readonly chromium?: Effect.Effect<number>
    readonly chromiumStart?: BrowserLaunchFailed
    readonly server?: Effect.Effect<number>
    readonly serverStart?: BrowserLaunchFailed
    readonly notAnswering?: number
    readonly interrupted?: Effect.Effect<number>
    readonly portAfter?: number
    readonly stopMs?: number
    readonly root?: boolean
  } = {},
): Fakes => {
  const events: Array<string> = []
  const spawned: Array<ProcessSpec> = []
  let asked = 0
  let read = 0
  const running = (name: string, exited: Effect.Effect<number>): Running => ({
    exited,
    stop: Effect.sleep(behaviors.stopMs ?? 0).pipe(
      Effect.andThen(Effect.sync(() => void events.push(`stop ${name}`))),
    ),
  })
  const host: LaunchHost = {
    spawn: (spec) =>
      Effect.suspend(() => {
        const name = spec.stdio === "ignore" ? "chromium" : "server"
        events.push(`spawn ${name}`)
        spawned.push(spec)
        const start = name === "chromium" ? behaviors.chromiumStart : behaviors.serverStart
        return start === undefined
          ? Effect.succeed(
              running(
                name,
                (name === "chromium" ? behaviors.chromium : behaviors.server) ?? Effect.never,
              ),
            )
          : Effect.fail(start)
      }),
    devToolsPort: (profile) =>
      Effect.sync(() => {
        read += 1
        if (read === 1) events.push(`read port in ${profile}`)
        return read > (behaviors.portAfter ?? 0) ? PORT : undefined
      }),
    answers: (url) =>
      Effect.sync(() => {
        events.push(`ask ${url}`)
        asked += 1
        return asked > (behaviors.notAnswering ?? 0)
      }),
    temporaryDirectory: (prefix) =>
      Effect.sync(() => {
        events.push(`create ${prefix}`)
        return BASE
      }),
    makeDirectory: (path) => Effect.sync(() => void events.push(`mkdir ${path}`)),
    removeDirectory: (path) => Effect.sync(() => void events.push(`remove ${path}`)),
    signals: Effect.acquireRelease(
      Effect.sync(() => void events.push("signals on")),
      () => Effect.sync(() => void events.push("signals off")),
    ).pipe(Effect.as(behaviors.interrupted ?? Effect.never)),
    root: behaviors.root ?? false,
  }
  return { events, spawned, host }
}

const made: Array<string> = []
afterEach(async () => {
  for (const path of made.splice(0)) await rm(path, { recursive: true, force: true })
})

const options = (overrides: Partial<BrowserServerOptions> = {}): BrowserServerOptions => ({
  env: { HOME: "/home/person", PATH: "/usr/bin", GONE: undefined },
  chromium: "/opt/pw-browsers/chromium",
  chromiumFix: CHROMIUM_FIX,
  server: BROWSER_USE_MCP_SERVER,
  readyTimeoutMs: 50,
  pollMs: 1,
  ...overrides,
})

const run = (machine: Fakes, overrides?: Partial<BrowserServerOptions>) =>
  Effect.runPromise(runBrowserServer(machine.host, options(overrides)).pipe(Effect.result))

describe("the Chromium arguments", () => {
  test("headless, with DevTools on a port Chromium picks itself, on 127.0.0.1 only, and a profile of the run", () => {
    expect(chromiumArguments(`${BASE}/profile`, true)).toEqual([
      "--headless=new",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${BASE}/profile`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "about:blank",
    ])
  })

  test("without the sandbox, which only a root process needs, --no-sandbox is added before the page", () => {
    const args = chromiumArguments(`${BASE}/profile`, false)
    expect(args.slice(-2)).toEqual(["--no-sandbox", "about:blank"])
  })
})

describe("the port Chromium reports", () => {
  test("is the first line of DevToolsActivePort, once that line is complete", () => {
    expect(parseDevToolsActivePort("43210\n/devtools/browser/abc-123")).toBe(43_210)
    expect(parseDevToolsActivePort("43210\n")).toBe(43_210)
    expect(parseDevToolsActivePort("4321")).toBeUndefined()
    expect(parseDevToolsActivePort("")).toBeUndefined()
    expect(parseDevToolsActivePort("not-a-port\n/x")).toBeUndefined()
    expect(parseDevToolsActivePort("0\n/x")).toBeUndefined()
    expect(parseDevToolsActivePort("70000\n/x")).toBeUndefined()
  })

  test("the real host reads it from the profile folder, and finds nothing while the file is missing", async () => {
    const profile = await mkdtemp(join(tmpdir(), "holyagent-browser-test-"))
    made.push(profile)
    expect(await Effect.runPromise(liveHost.devToolsPort(profile))).toBeUndefined()
    await Bun.write(join(profile, "DevToolsActivePort"), "43210\n/devtools/browser/x")
    expect(await Effect.runPromise(liveHost.devToolsPort(profile))).toBe(43_210)
  })
})

describe("the browser-use server's environment", () => {
  const folders = { config: `${BASE}/browser-use`, harness: `${BASE}/harness` }

  test("points the server at the browser, turns telemetry off and moves its config and state into the run's folders", () => {
    expect(serverEnvironment({ HOME: "/home/person" }, PORT, folders)).toEqual({
      HOME: "/home/person",
      BU_CDP_URL: `http://127.0.0.1:${PORT}`,
      BU_NAME: `holyagent-${PORT}`,
      ANONYMIZED_TELEMETRY: "0",
      BROWSER_USE_CONFIG_DIR: `${BASE}/browser-use`,
      BH_HOME: `${BASE}/harness`,
      BROWSER_HARNESS_HOME: `${BASE}/harness`,
    })
  })

  test("only the allowlisted variables of the inherited environment reach the server, the secrets and package-source overrides do not", () => {
    const env = serverEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/home/person",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        HTTPS_PROXY: "http://proxy:3128",
        https_proxy: "http://proxy:3128",
        NO_PROXY: "localhost",
        SSL_CERT_FILE: "/etc/ssl/ca.pem",
        REQUESTS_CA_BUNDLE: "/etc/ssl/ca.pem",
        UV_CACHE_DIR: "/home/person/.cache/uv",
        UV_INDEX: "https://evil.example/simple",
        UV_EXTRA_INDEX_URL: "https://evil.example/simple",
        UV_FIND_LINKS: "https://evil.example/links",
        PIP_INDEX_URL: "https://evil.example/simple",
        PYTHONPATH: "/tmp/evil",
        OPENAI_API_KEY: "sk-secret",
        ANTHROPIC_API_KEY: "sk-ant-secret",
      },
      PORT,
      folders,
    )
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/home/person",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NO_PROXY: "localhost",
      SSL_CERT_FILE: "/etc/ssl/ca.pem",
      REQUESTS_CA_BUNDLE: "/etc/ssl/ca.pem",
      UV_CACHE_DIR: "/home/person/.cache/uv",
      BU_CDP_URL: `http://127.0.0.1:${PORT}`,
    })
    for (const name of [
      "UV_INDEX",
      "UV_EXTRA_INDEX_URL",
      "UV_FIND_LINKS",
      "PIP_INDEX_URL",
      "PYTHONPATH",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
    ])
      expect(env).not.toHaveProperty(name)
  })

  test("names are matched without regard to case, as Windows spells them, and the list holds nothing that redirects a package source", () => {
    expect(
      serverEnvironment({ Path: "C:\\bin", SystemRoot: "C:\\Windows" }, PORT, folders),
    ).toMatchObject({
      Path: "C:\\bin",
      SystemRoot: "C:\\Windows",
    })
    expect(
      SERVER_ENVIRONMENT_ALLOWLIST.filter((name) =>
        /^(UV_(INDEX|EXTRA|FIND)|PIP_|PYTHON)/.test(name),
      ),
    ).toEqual([])
  })

  test("the person's own telemetry, config and DevTools variables never reach the server", () => {
    const env = serverEnvironment(
      {
        ANONYMIZED_TELEMETRY: "true",
        BROWSER_USE_CONFIG_DIR: "/home/person/.config/browseruse",
        BH_HOME: "/home/person/.config/browser-harness",
        BU_CDP_URL: "http://elsewhere:9222",
        UNSET: undefined,
      },
      PORT,
      folders,
    )
    expect(env["ANONYMIZED_TELEMETRY"]).toBe("0")
    expect(env["BROWSER_USE_CONFIG_DIR"]).toBe(folders.config)
    expect(env["BH_HOME"]).toBe(folders.harness)
    expect(env["BU_CDP_URL"]).toBe(`http://127.0.0.1:${PORT}`)
    expect(env).not.toHaveProperty("UNSET")
  })
})

describe("running the server against a Chromium of its own", () => {
  test("starts Chromium with a fresh profile, takes the port it reports, waits for DevTools, runs the server, then undoes it all in reverse", async () => {
    const machine = fakes({ server: Effect.succeed(7), notAnswering: 2, portAfter: 3 })
    expect(await run(machine)).toMatchObject({ _tag: "Success", success: 7 })
    const url = `http://127.0.0.1:${PORT}/json/version`
    expect(machine.events).toEqual([
      "signals on",
      "create holyagent-browser-",
      `mkdir ${join(BASE, "profile")}`,
      `mkdir ${join(BASE, "browser-use")}`,
      `mkdir ${join(BASE, "harness")}`,
      "spawn chromium",
      `read port in ${join(BASE, "profile")}`,
      `ask ${url}`,
      `ask ${url}`,
      `ask ${url}`,
      "spawn server",
      "stop server",
      "stop chromium",
      `remove ${BASE}`,
      "signals off",
    ])
    const [chromium, server] = machine.spawned
    expect(chromium).toMatchObject({
      command: "/opt/pw-browsers/chromium",
      args: chromiumArguments(join(BASE, "profile"), true),
      stdio: "ignore",
    })
    expect(server).toMatchObject({
      command: "uvx",
      args: BROWSER_USE_MCP_SERVER.args,
      stdio: "inherit",
      env: {
        HOME: "/home/person",
        PATH: "/usr/bin",
        BU_CDP_URL: `http://127.0.0.1:${PORT}`,
        BU_NAME: `holyagent-${PORT}`,
        ANONYMIZED_TELEMETRY: "0",
        BROWSER_USE_CONFIG_DIR: join(BASE, "browser-use"),
        BH_HOME: join(BASE, "harness"),
      },
    })
    expect(server?.env).not.toHaveProperty("GONE")
  })

  test("the profile and the server's state are inside the one temporary directory that is removed", async () => {
    const machine = fakes({ server: Effect.succeed(0) })
    await run(machine)
    const [chromium, server] = machine.spawned
    expect(chromium?.args).toContain(`--user-data-dir=${join(BASE, "profile")}`)
    expect(server?.env["BROWSER_USE_CONFIG_DIR"]?.startsWith(`${BASE}/`)).toBe(true)
    expect(server?.env["BH_HOME"]?.startsWith(`${BASE}/`)).toBe(true)
    expect(machine.events.at(-2)).toBe(`remove ${BASE}`)
  })

  test("a root process starts Chromium without its sandbox, and any other with it", async () => {
    const root = fakes({ server: Effect.succeed(0), root: true })
    await run(root)
    expect(root.spawned[0]?.args).toContain("--no-sandbox")
    const user = fakes({ server: Effect.succeed(0) })
    await run(user)
    expect(user.spawned[0]?.args).not.toContain("--no-sandbox")
  })

  test("ends with the server's own exit code, and still cleans up after a failing server", async () => {
    const machine = fakes({ server: Effect.succeed(3) })
    expect(await run(machine)).toMatchObject({ _tag: "Success", success: 3 })
    expect(machine.events.slice(-4)).toEqual([
      "stop server",
      "stop chromium",
      `remove ${BASE}`,
      "signals off",
    ])
  })

  test("a termination signal ends the run with its code, and the server, Chromium and directory are cleaned up", async () => {
    const machine = fakes({ interrupted: Effect.succeed(143) })
    expect(await run(machine)).toMatchObject({ _tag: "Success", success: 143 })
    expect(machine.events.slice(-4)).toEqual([
      "stop server",
      "stop chromium",
      `remove ${BASE}`,
      "signals off",
    ])
  })

  test("Chromium exiting under a running server ends the run as a failure, with cleanup", async () => {
    const machine = fakes({ chromium: Effect.sleep(10).pipe(Effect.as(9)) })
    const result = await run(machine)
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "BrowserLaunchFailed" } })
    expect((result as { failure: BrowserLaunchFailed }).failure.message).toContain(
      "Chromium exited with code 9 while the server was running",
    )
    expect(machine.events.slice(-4)).toEqual([
      "stop server",
      "stop chromium",
      `remove ${BASE}`,
      "signals off",
    ])
  })
})

describe("a launch that fails leaves nothing behind", () => {
  const failed = async (machine: Fakes, overrides?: Partial<BrowserServerOptions>) => {
    const result = await run(machine, overrides)
    if (result._tag !== "Failure") throw new Error("the launch was expected to fail")
    expect(result.failure).toBeInstanceOf(BrowserLaunchFailed)
    return result.failure.message
  }

  test("no Chromium on the machine: the fix is in the error and nothing was created or started", async () => {
    const machine = fakes()
    const message = await failed(machine, { chromium: undefined })
    expect(message).toContain("no Chromium was found")
    expect(message).toContain("HOLYAGENT_CHROMIUM_PATH")
    expect(machine.events).toEqual(["signals on", "signals off"])
  })

  test("a Chromium that cannot start: the directory is removed and no server starts", async () => {
    const machine = fakes({
      chromiumStart: failure("cannot start /opt/pw-browsers/chromium: ENOENT"),
    })
    expect(await failed(machine)).toContain("ENOENT")
    expect(machine.events.slice(-2)).toEqual([`remove ${BASE}`, "signals off"])
    expect(machine.events).not.toContain("stop chromium")
    expect(machine.spawned.map(({ stdio }) => stdio)).toEqual(["ignore"])
  })

  test("DevTools that never answers: Chromium is stopped, the directory removed and no server starts", async () => {
    const machine = fakes({ notAnswering: Number.POSITIVE_INFINITY })
    expect(await failed(machine, { readyTimeoutMs: 20 })).toContain("did not answer within 20 ms")
    expect(machine.events.slice(-3)).toEqual(["stop chromium", `remove ${BASE}`, "signals off"])
    expect(machine.spawned.map(({ stdio }) => stdio)).toEqual(["ignore"])
  })

  test("a Chromium that exits before DevTools answers fails at once with its exit code", async () => {
    const machine = fakes({ chromium: Effect.succeed(9), notAnswering: Number.POSITIVE_INFINITY })
    expect(await failed(machine, { readyTimeoutMs: 5_000 })).toContain(
      "Chromium exited with code 9 before its DevTools endpoint answered",
    )
    expect(machine.events.slice(-3)).toEqual(["stop chromium", `remove ${BASE}`, "signals off"])
  })

  test("a server that cannot start (uvx missing): Chromium is stopped and the directory removed", async () => {
    const machine = fakes({ serverStart: failure("cannot start uvx: ENOENT") })
    expect(await failed(machine)).toContain("cannot start uvx")
    expect(machine.events.slice(-3)).toEqual(["stop chromium", `remove ${BASE}`, "signals off"])
    expect(machine.events).not.toContain("stop server")
  })

  test("a Chromium that never reports its port: it is stopped, the directory removed and no server starts", async () => {
    const machine = fakes({ portAfter: Number.POSITIVE_INFINITY })
    expect(await failed(machine, { readyTimeoutMs: 20 })).toContain("did not answer within 20 ms")
    expect(machine.events.slice(-3)).toEqual(["stop chromium", `remove ${BASE}`, "signals off"])
    expect(machine.events.filter((event) => event.startsWith("ask "))).toEqual([])
    expect(machine.spawned.map(({ stdio }) => stdio)).toEqual(["ignore"])
  })
})

describe("a termination signal at any point of the run", () => {
  const SIGNAL_NAMES = ["SIGINT", "SIGTERM", "SIGHUP"] as const
  const listeners = () => SIGNAL_NAMES.map((name) => process.listenerCount(name))
  const raise = (name: (typeof SIGNAL_NAMES)[number], after: number) =>
    void setTimeout(() => void process.emit(name, name), after)

  test("while Chromium is still starting: Chromium is stopped, the directory removed, and no server starts", async () => {
    const machine = fakes({
      notAnswering: Number.POSITIVE_INFINITY,
      interrupted: Effect.sleep(15).pipe(Effect.as(143)),
    })
    expect(await run(machine, { readyTimeoutMs: 5_000 })).toMatchObject({
      _tag: "Success",
      success: 143,
    })
    expect(machine.events.slice(-3)).toEqual(["stop chromium", `remove ${BASE}`, "signals off"])
    expect(machine.events.at(0)).toBe("signals on")
    expect(machine.events).not.toContain("spawn server")
  })

  test("the handlers are the process's own signal handlers, installed for the whole run and removed after it", async () => {
    const before = listeners()
    const host = {
      ...fakes({ notAnswering: Number.POSITIVE_INFINITY }).host,
      signals: liveHost.signals,
    }
    const running = Effect.runPromise(
      runBrowserServer(host, options({ readyTimeoutMs: 5_000 })).pipe(Effect.result),
    )
    // The run is in its startup poll: the handlers are installed already.
    await Bun.sleep(10)
    expect(listeners().map((count, index) => count - (before[index] ?? 0))).toEqual([1, 1, 1])
    raise("SIGTERM", 0)
    expect(await running).toMatchObject({ _tag: "Success", success: 143 })
    expect(listeners()).toEqual(before)
  })

  test("a signal during startup and more of them during cleanup do not cut the cleanup short", async () => {
    const before = listeners()
    const machine = fakes({ notAnswering: Number.POSITIVE_INFINITY, stopMs: 120 })
    const host = { ...machine.host, signals: liveHost.signals }
    const running = Effect.runPromise(
      runBrowserServer(host, options({ readyTimeoutMs: 5_000 })).pipe(Effect.result),
    )
    raise("SIGTERM", 20)
    // Chromium takes 120 ms to stop: at 70 ms the run is being cleaned up, with its handlers in place.
    await Bun.sleep(70)
    expect(machine.events).not.toContain("stop chromium")
    expect(listeners().map((count, index) => count - (before[index] ?? 0))).toEqual([1, 1, 1])
    for (const name of SIGNAL_NAMES) process.emit(name, name)
    expect(await running).toMatchObject({ _tag: "Success", success: 143 })
    expect(machine.events.slice(-2)).toEqual(["stop chromium", `remove ${BASE}`])
    expect(listeners()).toEqual(before)
  })

  test("each signal ends with its own conventional code", async () => {
    for (const [name, code] of [
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const) {
      const host = {
        ...fakes({ notAnswering: Number.POSITIVE_INFINITY }).host,
        signals: liveHost.signals,
      }
      const running = Effect.runPromise(
        runBrowserServer(host, options({ readyTimeoutMs: 5_000 })).pipe(Effect.result),
      )
      raise(name, 15)
      expect(await running).toMatchObject({ _tag: "Success", success: code })
    }
  })
})

describe("the real machine", () => {
  test("a temporary directory is created empty, filled, and removed with everything in it", async () => {
    const path = await Effect.runPromise(liveHost.temporaryDirectory("holyagent-browser-test-"))
    made.push(path)
    expect(path.startsWith(tmpdir())).toBe(true)
    await Effect.runPromise(liveHost.makeDirectory(join(path, "profile")))
    expect(existsSync(join(path, "profile"))).toBe(true)
    await Effect.runPromise(liveHost.removeDirectory(path))
    expect(existsSync(path)).toBe(false)
    // A directory that is gone is not an error.
    await Effect.runPromise(liveHost.removeDirectory(path))
  })

  test("a directory that cannot be created is a launch failure that names it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "holyagent-browser-test-"))
    made.push(parent)
    const error = await Effect.runPromise(Effect.flip(liveHost.makeDirectory(join(parent, "a\0b"))))
    expect(error).toBeInstanceOf(BrowserLaunchFailed)
  })

  test("the DevTools endpoint answers when its URL answers with success, and not otherwise", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname === "/json/version"
          ? new Response("{}")
          : new Response("", { status: 404 }),
    })
    try {
      const base = `http://127.0.0.1:${server.port}`
      expect(await Effect.runPromise(liveHost.answers(`${base}/json/version`))).toBe(true)
      expect(await Effect.runPromise(liveHost.answers(`${base}/other`))).toBe(false)
    } finally {
      await server.stop(true)
    }
    expect(await Effect.runPromise(liveHost.answers(`http://127.0.0.1:${PORT}/json/version`))).toBe(
      false,
    )
  })

  test("a program that does not exist is a launch failure, not a crash", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        liveHost.spawn({
          command: "/holyagent/no/such/program",
          args: [],
          env: {},
          stdio: "ignore",
        }),
      ),
    )
    expect(error).toBeInstanceOf(BrowserLaunchFailed)
    expect(error.message).toContain("cannot start /holyagent/no/such/program")
  })
  describe("stopping a process group", () => {
    const posix = process.platform === "win32" ? test.skip : test
    const helper = async (script: string) => {
      const directory = await mkdtemp(join(tmpdir(), "holyagent-browser-test-"))
      made.push(directory)
      const pidFile = join(directory, "helper.pid")
      const running = await Effect.runPromise(
        liveHost.spawn({
          command: "sh",
          args: ["-c", script.replace("PIDFILE", pidFile)],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          stdio: "ignore",
        }),
      )
      return { running, pidFile }
    }
    // A process is gone when it no longer exists or is a zombie that only waits to be reaped.
    const gone = async (pid: number) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const alive = Effect.runSync(
          Effect.try(() => process.kill(pid, 0)).pipe(
            Effect.match({ onFailure: () => false, onSuccess: () => true }),
          ),
        )
        if (!alive) return true
        const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "")
        if (/\) Z /.test(state)) return true
        await Bun.sleep(20)
      }
      return false
    }
    const pidOf = async (pidFile: string) => {
      for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt += 1) await Bun.sleep(20)
      return Number((await readFile(pidFile, "utf8")).trim())
    }

    posix("ends the leader and the helpers in its group", async () => {
      const { running, pidFile } = await helper("sleep 60 & echo $! > PIDFILE; wait")
      const pid = await pidOf(pidFile)
      await Effect.runPromise(running.stop)
      expect(await Effect.runPromise(running.exited)).not.toBe(0)
      expect(await gone(pid)).toBe(true)
    })

    posix(
      "still signals the group after the leader exited, which kills a helper that ignores SIGTERM",
      async () => {
        const { running, pidFile } = await helper(
          "(trap '' TERM; sleep 60) & echo $! > PIDFILE; exit 0",
        )
        const pid = await pidOf(pidFile)
        expect(await Effect.runPromise(running.exited)).toBe(0)
        const started = performance.now()
        await Effect.runPromise(running.stop)
        expect(performance.now() - started).toBeLessThan(2_000)
        expect(await gone(pid)).toBe(true)
      },
    )

    posix("stopping a process that is already gone is harmless", async () => {
      const { running } = await helper("exit 0")
      await Effect.runPromise(running.exited)
      await Effect.runPromise(running.stop)
      await Effect.runPromise(running.stop)
    })

    test("signals nothing for a pid that is no child's", async () => {
      const kill = spyOn(process, "kill")
      try {
        for (const pid of [0, 1, Number.NaN])
          await Effect.runPromise(
            stopGroup({ pid, kill: () => {}, exited: Promise.resolve(0) }, "linux"),
          )
        expect(kill).not.toHaveBeenCalled()
      } finally {
        kill.mockRestore()
      }
    })

    test("on Windows the whole tree is killed at once, without asking first or waiting out the grace", async () => {
      const killed: Array<unknown> = []
      const kill = spyOn(process, "kill")
      const started = performance.now()
      try {
        await Effect.runPromise(
          stopGroup(
            {
              pid: 999_999,
              kill: (signal) => void killed.push(signal),
              exited: Promise.resolve(0),
            },
            "win32",
          ),
        )
        expect(kill).not.toHaveBeenCalled()
      } finally {
        kill.mockRestore()
      }
      expect(killed).toEqual(["SIGKILL"])
      expect(performance.now() - started).toBeLessThan(2_000)
    })
  })
})
