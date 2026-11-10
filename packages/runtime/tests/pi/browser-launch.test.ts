import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
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
  type ProcessSpec,
  runBrowserServer,
  type Running,
  serverEnvironment,
} from "../../src/pi/browser-launch.ts"

const BASE = "/tmp/holyagent-browser-test"
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
 * decide what the processes do (exit at once, never exit, or fail to start), `answers` how many
 * questions the DevTools endpoint gets wrong before it answers.
 */
const fakes = (
  behaviors: {
    readonly chromium?: Effect.Effect<number>
    readonly chromiumStart?: BrowserLaunchFailed
    readonly server?: Effect.Effect<number>
    readonly serverStart?: BrowserLaunchFailed
    readonly notAnswering?: number
    readonly interrupted?: Effect.Effect<number>
    readonly portFails?: boolean
    readonly root?: boolean
  } = {},
): Fakes => {
  const events: Array<string> = []
  const spawned: Array<ProcessSpec> = []
  let asked = 0
  const running = (name: string, exited: Effect.Effect<number>): Running => ({
    exited,
    stop: Effect.sync(() => void events.push(`stop ${name}`)),
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
    freePort: Effect.suspend(() => {
      events.push("port")
      return behaviors.portFails === true ? Effect.fail(failure("no port")) : Effect.succeed(PORT)
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
    interrupted: behaviors.interrupted ?? Effect.never,
    root: behaviors.root ?? false,
  }
  return { events, spawned, host }
}

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
  test("headless, with DevTools on the given port of 127.0.0.1 only and a profile of the run", () => {
    expect(chromiumArguments(PORT, `${BASE}/profile`, true)).toEqual([
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${BASE}/profile`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "about:blank",
    ])
  })

  test("without the sandbox, which only a root process needs, --no-sandbox is added before the page", () => {
    const args = chromiumArguments(PORT, `${BASE}/profile`, false)
    expect(args.slice(-2)).toEqual(["--no-sandbox", "about:blank"])
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
  test("starts Chromium on a free port with a fresh profile, waits for DevTools, runs the server, then undoes it all in reverse", async () => {
    const machine = fakes({ server: Effect.succeed(7), notAnswering: 2 })
    expect(await run(machine)).toMatchObject({ _tag: "Success", success: 7 })
    const url = `http://127.0.0.1:${PORT}/json/version`
    expect(machine.events).toEqual([
      "create holyagent-browser-",
      `mkdir ${join(BASE, "profile")}`,
      `mkdir ${join(BASE, "browser-use")}`,
      `mkdir ${join(BASE, "harness")}`,
      "port",
      "spawn chromium",
      `ask ${url}`,
      `ask ${url}`,
      `ask ${url}`,
      "spawn server",
      "stop server",
      "stop chromium",
      `remove ${BASE}`,
    ])
    const [chromium, server] = machine.spawned
    expect(chromium).toMatchObject({
      command: "/opt/pw-browsers/chromium",
      args: chromiumArguments(PORT, join(BASE, "profile"), true),
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
    expect(machine.events.at(-1)).toBe(`remove ${BASE}`)
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
    expect(machine.events.slice(-3)).toEqual(["stop server", "stop chromium", `remove ${BASE}`])
  })

  test("a termination signal ends the run with its code, and the server, Chromium and directory are cleaned up", async () => {
    const machine = fakes({ interrupted: Effect.succeed(143) })
    expect(await run(machine)).toMatchObject({ _tag: "Success", success: 143 })
    expect(machine.events.slice(-3)).toEqual(["stop server", "stop chromium", `remove ${BASE}`])
  })

  test("Chromium exiting under a running server ends the run as a failure, with cleanup", async () => {
    const machine = fakes({ chromium: Effect.sleep(10).pipe(Effect.as(9)) })
    const result = await run(machine)
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "BrowserLaunchFailed" } })
    expect((result as { failure: BrowserLaunchFailed }).failure.message).toContain(
      "Chromium exited with code 9 while the server was running",
    )
    expect(machine.events.slice(-3)).toEqual(["stop server", "stop chromium", `remove ${BASE}`])
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
    expect(machine.events).toEqual([])
  })

  test("a Chromium that cannot start: the directory is removed and no server starts", async () => {
    const machine = fakes({
      chromiumStart: failure("cannot start /opt/pw-browsers/chromium: ENOENT"),
    })
    expect(await failed(machine)).toContain("ENOENT")
    expect(machine.events.at(-1)).toBe(`remove ${BASE}`)
    expect(machine.events).not.toContain("stop chromium")
    expect(machine.spawned.map(({ stdio }) => stdio)).toEqual(["ignore"])
  })

  test("DevTools that never answers: Chromium is stopped, the directory removed and no server starts", async () => {
    const machine = fakes({ notAnswering: Number.POSITIVE_INFINITY })
    expect(await failed(machine, { readyTimeoutMs: 20 })).toContain("did not answer within 20 ms")
    expect(machine.events.slice(-2)).toEqual(["stop chromium", `remove ${BASE}`])
    expect(machine.spawned.map(({ stdio }) => stdio)).toEqual(["ignore"])
  })

  test("a Chromium that exits before DevTools answers fails at once with its exit code", async () => {
    const machine = fakes({ chromium: Effect.succeed(9), notAnswering: Number.POSITIVE_INFINITY })
    expect(await failed(machine, { readyTimeoutMs: 5_000 })).toContain(
      "Chromium exited with code 9 before its DevTools endpoint answered",
    )
    expect(machine.events.slice(-2)).toEqual(["stop chromium", `remove ${BASE}`])
  })

  test("a server that cannot start (uvx missing): Chromium is stopped and the directory removed", async () => {
    const machine = fakes({ serverStart: failure("cannot start uvx: ENOENT") })
    expect(await failed(machine)).toContain("cannot start uvx")
    expect(machine.events.slice(-2)).toEqual(["stop chromium", `remove ${BASE}`])
    expect(machine.events).not.toContain("stop server")
  })

  test("no free port: the directory is removed before anything starts", async () => {
    const machine = fakes({ portFails: true })
    expect(await failed(machine)).toBe("no port")
    expect(machine.events.at(-1)).toBe(`remove ${BASE}`)
    expect(machine.spawned).toEqual([])
  })
})

describe("the real machine", () => {
  const made: Array<string> = []
  afterEach(async () => {
    for (const path of made.splice(0)) await rm(path, { recursive: true, force: true })
  })

  test("a free port is one nothing listens on, on 127.0.0.1", async () => {
    const port = await Effect.runPromise(liveHost.freePort)
    expect(port).toBeGreaterThan(0)
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") })
    try {
      expect(server.port).toBe(port)
    } finally {
      await server.stop(true)
    }
  })

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
})
