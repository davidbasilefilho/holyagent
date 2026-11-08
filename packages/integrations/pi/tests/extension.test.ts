import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import type { ExecResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { CONTEXT_BUDGET, SESSION_REMINDER } from "../../../runtime/src/cli/sessioncontext.ts"
import { defaultConfig } from "../../../runtime/src/config/schema.ts"
import {
  PI_ROOT_CORE,
  PI_ROOT_PLACEHOLDER,
  PI_SESSION_REMINDER,
} from "../../../runtime/src/hooks/pi-context.ts"
import { PI_PROJECT_FLAG } from "../../../runtime/src/hooks/pi-project.ts"
import {
  COMMAND_TIMEOUT_MS,
  CONTEXT_MESSAGE,
  createExtension,
  NOTICE_MESSAGE,
  ROLE_FLAG,
  SESSION_DEADLINE_MS,
} from "../src/extension.ts"
import { DIST_DIRECTORY, REPOSITORY } from "../src/files.ts"

const PACKAGE_ROOT = join(REPOSITORY, DIST_DIRECTORY)
const WRAPPER = join(PACKAGE_ROOT, "scripts", "holyagent")
const CONFIG = JSON.stringify(await Effect.runPromise(defaultConfig))
const DISABLED = JSON.stringify({
  ...(await Effect.runPromise(defaultConfig)),
  pi: { ...(await Effect.runPromise(defaultConfig)).pi, enable: false },
})

interface Call {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly signal: AbortSignal | undefined
}

type Outcome = Partial<Pick<ExecResult, "stdout" | "stderr" | "code" | "killed">>
type Responder = (call: Call, runtime: ReadonlyArray<string>) => Outcome | Promise<Outcome>

/** The holyagent subcommand a call runs through the wrapper, or undefined for another program. */
const subcommand = (call: Call): ReadonlyArray<string> | undefined =>
  call.command === "sh" && call.args[0] === WRAPPER && call.args[1] === PI_PROJECT_FLAG
    ? call.args.slice(3)
    : undefined

const STATUS =
  "intents[1]{id,revision,objective,running,unaccepted}:\n  intent-a,1,Ship the thing,0,0\n"
const RECONCILE =
  "running[1]{id,role,agent,startedAt}:\n  assignment-1,Worker.implementation,agent-1,null\n"

/** A project with state: the exit-0 answers a healthy install gives, overridden per command. */
const healthy =
  (directory: string, overrides: Readonly<Record<string, Outcome>> = {}): Responder =>
  (call, runtime) => {
    const given = overrides[runtime[0] === "state" ? "state mode" : (runtime[0] ?? call.command)]
    if (given !== undefined) return given
    if (call.command === "git") return { stdout: "/work/project\n" }
    switch (runtime[0]) {
      case "config":
        return { stdout: `${CONFIG}\n` }
      case "status":
        return { stdout: STATUS }
      case "reconcile":
        return { stdout: RECONCILE }
      case "state":
        return { stdout: `mode: work\nconfigured: true\ndirectory: ${directory}\n` }
      default:
        return { code: 2, stderr: "error: Usage: unexpected\n" }
    }
  }

const SESSION_CWD = "/work/project/src"
// What the extension makes of the session's folder, which differs on Windows where a root-relative
// path gets a drive.
const SESSION_PROJECT = resolve(SESSION_CWD)

/** A fake ExtensionAPI that records what the extension registers and runs. */
const fakeApi = (responder: Responder, value?: string | boolean, cwd = SESSION_CWD) => {
  const flags = new Map<string, { type: string; default?: string }>()
  const handlers = new Map<string, Array<(...args: Array<never>) => unknown>>()
  const calls: Array<Call> = []
  const sent: Array<unknown> = []
  const touched: Array<string> = []
  const api = {
    registerFlag: (name: string, options: { type: string; default?: string }) =>
      void flags.set(name, options),
    getFlag: (name: string) => value ?? flags.get(name)?.default,
    on: (event: string, handler: (...args: Array<never>) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => undefined
    },
    sendMessage: (message: unknown) => void sent.push(message),
    exec: async (
      command: string,
      args: Array<string>,
      options?: { cwd?: string; signal?: AbortSignal; timeout?: number },
    ): Promise<ExecResult> => {
      const call: Call = { command, args, cwd: options?.cwd, signal: options?.signal }
      calls.push(call)
      const outcome = await responder(call, subcommand(call) ?? [])
      return { stdout: "", stderr: "", code: 0, killed: false, truncated: false, ...outcome }
    },
  }
  // Only `cwd` of the context is read: any other member, the TUI's `ui` included, fails the test.
  const context = new Proxy(
    { cwd },
    {
      get: (target, key) => {
        if (key === "cwd") return target.cwd
        touched.push(String(key))
        throw new Error(`the extension used ctx.${String(key)}`)
      },
    },
  ) as unknown as ExtensionContext
  const emit = async (event: string, payload: object = {}): Promise<Array<unknown>> => {
    const results: Array<unknown> = []
    for (const handler of handlers.get(event) ?? [])
      results.push(await (handler as (e: object, c: ExtensionContext) => unknown)(payload, context))
    return results
  }
  return {
    pi: api as unknown as ExtensionAPI,
    flags,
    handlers,
    calls,
    sent,
    touched,
    emit,
  }
}

interface Delivered {
  readonly message?: { customType: string; content: string; display: boolean }
  readonly systemPrompt?: string
}

/** Starts the extension on a fake API, runs `start`, and returns what the next run is told. */
const run = async (
  responder: Responder,
  options: {
    flag?: string | boolean
    start?: object
    cwd?: string
    afterwards?: (api: ReturnType<typeof fakeApi>) => Promise<void>
  } = {},
) => {
  const api = fakeApi(responder, options.flag, options.cwd)
  createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
  await api.emit("session_start", options.start ?? { reason: "startup" })
  await options.afterwards?.(api)
  const delivered = (await api.emit("before_agent_start", { prompt: "hello" })).find(
    (result) => result !== undefined,
  ) as Delivered | undefined
  return { api, delivered }
}

const startedWith = (calls: ReadonlyArray<Call>) =>
  calls.map((call) => subcommand(call)?.join(" ")).filter((entry) => entry !== undefined)

describe("the factory", () => {
  test("registers the role flag and the four handlers and starts nothing", () => {
    const timers: Array<string> = []
    const originals = {
      setTimeout: globalThis.setTimeout,
      setInterval: globalThis.setInterval,
      setImmediate: globalThis.setImmediate,
    }
    for (const name of Object.keys(originals) as Array<keyof typeof originals>)
      Object.assign(globalThis, {
        [name]: (...args: Array<never>) => {
          timers.push(name)
          return (originals[name] as (...inner: Array<never>) => unknown)(...args)
        },
      })
    const api = fakeApi(healthy("/none"))
    try {
      expect(createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)).toBeUndefined()
    } finally {
      Object.assign(globalThis, originals)
    }
    expect(api.flags.get(ROLE_FLAG)).toMatchObject({ type: "string", default: "root" })
    expect([...api.handlers.keys()].toSorted()).toEqual([
      "before_agent_start",
      "session_compact",
      "session_shutdown",
      "session_start",
    ])
    expect(api.calls).toEqual([])
    expect(api.sent).toEqual([])
    expect(timers).toEqual([])
  })

  test("the built default export does the same", async () => {
    const loaded = (await import(join(PACKAGE_ROOT, "extensions", "holyagent.js"))) as {
      default: (pi: ExtensionAPI) => unknown
    }
    const api = fakeApi(healthy("/none"))
    expect(loaded.default(api.pi)).toBeUndefined()
    expect(api.flags.has(ROLE_FLAG)).toBe(true)
    expect(api.calls).toEqual([])
  })
})

describe("session_start and session_shutdown", () => {
  test("session_start takes a stop signal for its commands and session_shutdown stops them, twice safely", async () => {
    const api = fakeApi(healthy("/missing"))
    createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
    await api.emit("session_start", { reason: "startup" })
    const signals = api.calls.map((call) => call.signal)
    expect(signals.length).toBeGreaterThan(0)
    expect(signals.every((signal) => signal !== undefined && !signal.aborted)).toBe(true)
    await api.emit("session_shutdown", { reason: "quit" })
    expect(signals.every((signal) => signal?.aborted === true)).toBe(true)
    await api.emit("session_shutdown", { reason: "quit" })
    await api.emit("session_shutdown", { reason: "reload" })
    expect(await api.emit("before_agent_start", { prompt: "x" })).toEqual([undefined])
    expect(await api.emit("session_compact", { reason: "manual" })).toEqual([undefined])
  })

  test("a shutdown with no start is a no-op", async () => {
    const api = fakeApi(healthy("/missing"))
    createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
    expect(await api.emit("session_shutdown", { reason: "quit" })).toEqual([undefined])
    expect(api.calls).toEqual([])
  })

  test("a new start releases the previous one", async () => {
    const api = fakeApi(healthy("/missing"))
    createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
    await api.emit("session_start", { reason: "startup" })
    const first = api.calls.map((call) => call.signal)
    await api.emit("session_start", { reason: "new" })
    expect(first.every((signal) => signal?.aborted === true)).toBe(true)
    expect(api.calls.at(-1)?.signal?.aborted).toBe(false)
  })

  test("every command is bounded in time", async () => {
    const { api } = await run(healthy("/missing"))
    expect(COMMAND_TIMEOUT_MS).toBeLessThan(10_000)
    expect(api.calls.length).toBeGreaterThan(0)
  })
})

describe("the role flag", () => {
  const projects = async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-role-"))
    return { directory, done: () => rm(directory, { recursive: true, force: true }) }
  }

  test("defaults to the root: status only, no root rules", async () => {
    const { directory, done } = await projects()
    const { api, delivered } = await run(healthy(directory))
    expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(delivered?.message?.content).toContain("Ship the thing")
    expect(delivered?.message?.content).not.toContain(PI_ROOT_CORE.slice(0, 200))
    expect(api.flags.get(ROLE_FLAG)?.default).toBe("root")
    await done()
  })

  test("root and specialist get the status without the core; session adds the core", async () => {
    const { directory, done } = await projects()
    const core = PI_ROOT_CORE.split(PI_ROOT_PLACEHOLDER)[0] ?? ""
    const text = async (flag: string) =>
      (await run(healthy(directory), { flag })).delivered?.message?.content ?? ""
    const [root, specialist, session] = [
      await text("root"),
      await text("specialist"),
      await text("session"),
    ]
    for (const body of [root, specialist, session]) expect(body).toContain("Ship the thing")
    expect(root).not.toContain(core)
    expect(specialist).not.toContain(core)
    expect(session).toContain(core)
    expect(session).toContain(`${PACKAGE_ROOT}/scripts/holyagent`)
    expect(session).not.toContain(PI_ROOT_PLACEHOLDER)
    // The reminder restates root rules: the root and the session role end with the Pi block, the
    // specialist with none, and nobody gets the Claude block.
    expect(root.endsWith(PI_SESSION_REMINDER)).toBe(true)
    expect(session.endsWith(PI_SESSION_REMINDER)).toBe(true)
    expect(specialist).not.toContain(PI_SESSION_REMINDER)
    for (const body of [root, specialist, session]) expect(body).not.toContain(SESSION_REMINDER)
    await done()
  })

  test("an unknown value fails closed with a message and runs no status call", async () => {
    for (const flag of ["wizard", "", true]) {
      const { api, delivered } = await run(healthy("/missing"), { flag })
      expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
      expect(delivered?.message?.display).toBe(true)
      expect(delivered?.message?.content).toContain(`--${ROLE_FLAG}`)
      expect(delivered?.message?.content).toContain("root, specialist, session")
      expect(startedWith(api.calls)).not.toContain("status")
    }
  })
})

describe("what runs and when", () => {
  const withState = async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-state-"))
    return { directory, done: () => rm(directory, { recursive: true, force: true }) }
  }

  for (const reason of ["startup", "reload", "new", "resume", "fork"] as const) {
    test(`session_start (${reason}) runs status, and reconcile only after a resume`, async () => {
      const { directory, done } = await withState()
      const { api, delivered } = await run(healthy(directory), { start: { reason } })
      const commands = startedWith(api.calls)
      expect(commands).toContain("status")
      expect(commands.includes("reconcile")).toBe(reason === "resume")
      expect(delivered?.message?.content).toContain("holyagent status:")
      expect(delivered?.message?.content?.includes("holyagent reconcile:")).toBe(
        reason === "resume",
      )
      await done()
    })
  }

  test("session_compact runs status and reconcile and delivers a new message", async () => {
    const { directory, done } = await withState()
    const { api, delivered } = await run(healthy(directory), {
      afterwards: async (inner) => {
        // The start's message is read by the first run; compaction brings the next.
        await inner.emit("before_agent_start", { prompt: "first" })
        inner.calls.length = 0
        await inner.emit("session_compact", { reason: "threshold" })
      },
    })
    const commands = startedWith(api.calls)
    expect(commands).toContain("status")
    expect(commands).toContain("reconcile")
    expect(delivered?.message?.content).toContain("holyagent reconcile:")
    await done()
  })

  test("the result is a message on the next run, delivered once, never a system prompt or a send", async () => {
    const { directory, done } = await withState()
    const { api, delivered } = await run(healthy(directory))
    expect(Object.keys(delivered ?? {})).toEqual(["message"])
    expect(delivered?.systemPrompt).toBeUndefined()
    expect(delivered?.message?.display).toBe(false)
    expect(api.sent).toEqual([])
    expect(await api.emit("before_agent_start", { prompt: "again" })).toEqual([undefined])
    await done()
  })

  test("the wrapper is the only way to the runtime: sh with the package's scripts/holyagent", async () => {
    const { directory, done } = await withState()
    const { api } = await run(healthy(directory), { start: { reason: "resume" } })
    for (const call of api.calls) {
      if (call.command === "git") continue
      expect({
        command: call.command,
        script: call.args[0],
        project: call.args.slice(1, 3),
      }).toEqual({
        command: "sh",
        script: WRAPPER,
        project: [PI_PROJECT_FLAG, SESSION_PROJECT],
      })
    }
    const commands = startedWith(api.calls)
    for (const expected of ["config /work/project/.holyagent", "status", "reconcile", "state mode"])
      expect(commands).toContain(expected)
    await done()
  })
})

describe("the context", () => {
  test("stays within the budget for every role, however much state there is", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-budget-"))
    const rows = Array.from(
      { length: 400 },
      (_, at) => `  intent-${at},${at},${"objective ".repeat(60).trim()},3,4`,
    )
    const status = `intents[400]{id,revision,objective,running,unaccepted}:\n${rows.join("\n")}\n`
    const running = Array.from(
      { length: 200 },
      (_, at) => `  assignment-${at},Worker.implementation,agent-${at},null`,
    )
    const reconcile = `running[200]{id,role,agent,startedAt}:\n${running.join("\n")}\n`
    for (const flag of ["root", "specialist", "session"]) {
      const { delivered } = await run(
        healthy(directory, { status: { stdout: status }, reconcile: { stdout: reconcile } }),
        { flag, start: { reason: "resume" } },
      )
      expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
      expect(delivered?.message?.content.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
      expect(delivered?.message?.content.length).toBeGreaterThan(1000)
    }
    await rm(directory, { recursive: true, force: true })
  })

  test("is empty without a .holyagent folder, except the core of a session role", async () => {
    const missing = join(tmpdir(), "holyagent-pi-no-such-folder", ".holyagent")
    for (const flag of ["root", "specialist"]) {
      const { delivered } = await run(healthy(missing), { flag })
      expect(delivered).toBeUndefined()
    }
    const { delivered } = await run(healthy(missing), { flag: "session" })
    expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(delivered?.message?.content).toContain("You are the root")
    expect(delivered?.message?.content).not.toContain("holyagent status:")
    expect(delivered?.message?.content.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
  })
})

describe("failing closed", () => {
  const oneLine = (text: string | undefined) => text !== undefined && !text.includes("\n")

  for (const [name, outcome] of [
    ["a non-zero exit", { code: 127, stderr: "error: BunMissing: Bun was not found.\n" }],
    ["a timeout", { killed: true, code: 143 }],
    ["output that is not TOON", { stdout: "[unclosed" }],
  ] as const) {
    test(`a failing status call (${name}) adds one notice line and never throws into pi`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-fail-"))
      const { delivered } = await run(healthy(directory, { status: outcome }))
      expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
      expect(delivered?.message?.content).toStartWith("holyagent: ")
      expect(delivered?.message?.content).toContain("status")
      expect(oneLine(delivered?.message?.content)).toBe(true)
      expect(delivered?.message?.content).not.toContain("Ship the thing")
      await rm(directory, { recursive: true, force: true })
    })
  }

  test("a rejected exec is a notice too, and a later compaction still works", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-reject-"))
    const healthyAnswer = healthy(directory)
    let broken = true
    const { delivered, api } = await run((call, runtime) => {
      if (broken && runtime[0] === "status") throw new Error("spawn sh ENOENT")
      return healthyAnswer(call, runtime)
    }, {})
    expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered?.message?.content).toContain("spawn sh ENOENT")
    broken = false
    await api.emit("session_compact", { reason: "manual" })
    const again = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(again.message?.customType).toBe(CONTEXT_MESSAGE)
    await rm(directory, { recursive: true, force: true })
  })

  test("a notice is short even when the failure is long", async () => {
    const { delivered } = await run(
      healthy("/missing", { status: { code: 4, stderr: `error: StateIo: ${"x".repeat(5000)}\n` } }),
    )
    expect(delivered?.message?.content.length).toBeLessThan(500)
  })

  test("the handlers read nothing of the context but its working directory", async () => {
    const { api } = await run(healthy("/missing"))
    expect(api.touched).toEqual([])
  })
})

describe("the config", () => {
  test("pi.enable false adds nothing and runs no status call", async () => {
    for (const flag of ["root", "specialist", "session"]) {
      const { api, delivered } = await run(
        healthy("/missing", { config: { stdout: `${DISABLED}\n` } }),
        {
          flag,
        },
      )
      expect(delivered).toBeUndefined()
      expect(startedWith(api.calls)).not.toContain("status")
      expect(startedWith(api.calls)).not.toContain("reconcile")
      expect(api.sent).toEqual([])
    }
  })

  test("an invalid config stops with the loader's message, which names the field", async () => {
    const message =
      '/work/project/.holyagent/config.json is not a valid HolyAgent config: Unexpected key at ["pi"]["enabel"]'
    const { api, delivered } = await run(
      healthy("/missing", {
        config: { code: 4, stderr: `error: ConfigInvalid: ${message}\nhint: Fix the field.\n` },
      }),
    )
    expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered?.message?.content).toContain(message)
    expect(delivered?.message?.content).not.toContain("hint:")
    expect(startedWith(api.calls)).not.toContain("status")
  })

  test("a config with an unknown key is refused when decoded", async () => {
    const { delivered } = await run(
      healthy("/missing", { config: { stdout: `${JSON.stringify({ pi: {}, extra: 1 })}\n` } }),
    )
    expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
  })
})

describe("with the built package and a real project", () => {
  /** Runs a command for real, as Pi's exec does: no shell, with the signal and a timeout. */
  const realExec =
    (home: string): Responder =>
    async (call) => {
      const child = Bun.spawn([call.command, ...call.args], {
        ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
        env: { ...process.env, HOLYAGENT_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, code }
    }

  const project = async () => {
    const root = await mkdtemp(join(tmpdir(), "holyagent-pi-real-"))
    const proc = (args: Array<string>) =>
      Bun.spawn(args, { cwd: root, stdout: "ignore", stderr: "ignore" }).exited
    await proc(["git", "init", "-q", "."])
    await proc(["git", "config", "holyagent.stateMode", "work"])
    return {
      root,
      home: join(root, "home"),
      proc,
      done: () => rm(root, { recursive: true, force: true }),
    }
  }

  const real = async (cwd: string, home: string) => (await run(realExec(home), { cwd })).delivered

  test("a project with an Intent gets its status; one without a .holyagent folder gets nothing", async () => {
    const { root, home, done } = await project()
    expect(await real(root, home)).toBeUndefined()
    const created = Bun.spawn(
      [
        "sh",
        WRAPPER,
        "intent",
        "create",
        "--input",
        JSON.stringify({ objective: "Real objective" }),
      ],
      {
        cwd: root,
        env: { ...process.env, HOLYAGENT_HOME: home },
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    expect(await created.exited).toBe(0)
    const delivered = await real(root, home)
    expect(delivered?.message?.content).toContain("Real objective")
    expect(delivered?.message?.content.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
    await done()
  })

  test("a bad .holyagent/config.json is reported with the field it names", async () => {
    const { root, home, done } = await project()
    await mkdir(join(root, ".holyagent"), { recursive: true })
    await Bun.write(
      join(root, ".holyagent", "config.json"),
      JSON.stringify({ pi: { enabel: true } }),
    )
    const delivered = await real(root, home)
    expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered?.message?.content).toContain("config.json")
    expect(delivered?.message?.content).toContain("enabel")
    await done()
  })

  test("pi.enable false in the project's config adds nothing", async () => {
    const { root, home, done } = await project()
    await mkdir(join(root, ".holyagent"), { recursive: true })
    await Bun.write(
      join(root, ".holyagent", "config.json"),
      JSON.stringify({ pi: { enable: false } }),
    )
    expect(await real(root, home)).toBeUndefined()
    await done()
  })
})

/**
 * Two promises that hold a command and tell the test where it is: `entered` settles when the
 * command reaches the gate, and `promise` holds it until the test calls `open`. The tests wait for
 * `entered` instead of for time.
 */
const gate = () => {
  let open = () => {}
  let enter = () => {}
  const promise = new Promise<void>((release) => void (open = release))
  const entered = new Promise<void>((reached) => void (enter = reached))
  return { promise, open, entered, enter }
}

/**
 * Answers once the gate opens, or as a stopped command when the signal aborts first. The gate's
 * `entered` settles as the command arrives.
 */
const gated = (
  hold: ReturnType<typeof gate>,
  answer: Outcome,
  signal?: AbortSignal,
): Promise<Outcome> =>
  new Promise((settle) => {
    hold.enter()
    const stop = () => settle({ killed: true, code: 143 })
    if (signal?.aborted) return stop()
    signal?.addEventListener("abort", stop, { once: true })
    void hold.promise.then(() => settle(answer))
  })

describe("order and time", () => {
  const state = async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-order-"))
    return { directory, done: () => rm(directory, { recursive: true, force: true }) }
  }

  test("status finishes before reconcile starts", async () => {
    const { directory, done } = await state()
    const hold = gate()
    const inner = healthy(directory)
    const api = fakeApi((call, runtime) =>
      runtime[0] === "status" ? gated(hold, { stdout: STATUS }, call.signal) : inner(call, runtime),
    )
    createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
    const started = api.emit("session_start", { reason: "resume" })
    await hold.entered
    expect(startedWith(api.calls)).toContain("status")
    expect(startedWith(api.calls)).not.toContain("reconcile")
    hold.open()
    await started
    const commands = startedWith(api.calls)
    expect(commands.indexOf("reconcile")).toBeGreaterThan(commands.indexOf("status"))
    await done()
  })

  test("the config and the state folder are asked together, before status", async () => {
    const { directory, done } = await state()
    const hold = gate()
    const folderAsked = gate()
    const inner = healthy(directory)
    const api = fakeApi((call, runtime) => {
      if (runtime[0] === "state") folderAsked.enter()
      return runtime[0] === "config"
        ? gated(hold, { stdout: `${CONFIG}\n` }, call.signal)
        : inner(call, runtime)
    })
    createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    // The config is held, and the state folder is asked while it is.
    await Promise.all([hold.entered, folderAsked.entered])
    expect(startedWith(api.calls)).toContain("state mode")
    expect(startedWith(api.calls)).not.toContain("status")
    hold.open()
    await started
    expect(startedWith(api.calls)).toContain("status")
    await done()
  })

  test("the whole collection has one deadline of the Claude hook's ten seconds", async () => {
    expect(SESSION_DEADLINE_MS).toBe(10_000)
    expect(COMMAND_TIMEOUT_MS).toBeLessThan(SESSION_DEADLINE_MS)
    const { directory, done } = await state()
    // Every command answers in time on its own; together they run past the deadline.
    const inner = healthy(directory)
    const api = fakeApi(async (call, runtime) => {
      await Bun.sleep(60)
      return inner(call, runtime)
    })
    createExtension({ packageRoot: PACKAGE_ROOT, deadlineMs: 150 })(api.pi)
    const began = performance.now()
    await api.emit("session_start", { reason: "resume" })
    expect(performance.now() - began).toBeLessThan(1_500)
    const delivered = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(delivered.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered.message?.content).toContain("longer than")
    // The command in flight at the deadline is stopped, and none starts after it.
    expect(api.calls.at(-1)?.signal?.aborted).toBe(true)
    const count = api.calls.length
    await Bun.sleep(150)
    expect(api.calls.length).toBe(count)
    await done()
  })

  test("a compaction aborts the gather still pending and delivers its own result", async () => {
    const { directory, done } = await state()
    const hold = gate()
    const inner = healthy(directory)
    let first = true
    const api = fakeApi((call, runtime) => {
      if (runtime[0] !== "status" || !first) return inner(call, runtime)
      first = false
      return gated(hold, { stdout: STATUS }, call.signal)
    })
    createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    const older = api.calls.filter((call) => subcommand(call)?.[0] === "status")[0]?.signal
    expect(older?.aborted).toBe(false)
    await api.emit("session_compact", { reason: "threshold" })
    expect(older?.aborted).toBe(true)
    await started
    const delivered = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(delivered.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(delivered.message?.content).toContain("holyagent reconcile:")
    // The aborted gather asked for nothing more.
    expect(startedWith(api.calls).filter((entry) => entry === "reconcile")).toHaveLength(1)
    await done()
  })

  test("a shutdown drops the result of the gather it stopped", async () => {
    const { directory, done } = await state()
    const hold = gate()
    const inner = healthy(directory)
    const api = fakeApi((call, runtime) =>
      runtime[0] === "status" ? gated(hold, { stdout: STATUS }, call.signal) : inner(call, runtime),
    )
    createExtension({ packageRoot: PACKAGE_ROOT })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    await api.emit("session_shutdown", { reason: "quit" })
    await started
    expect(await api.emit("before_agent_start", { prompt: "x" })).toEqual([undefined])
    await done()
  })
})

describe("where programs start", () => {
  test("git and sh run in the package's folder, never the project's, and the project is an argument", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-cwd-"))
    const project = SESSION_PROJECT
    const { api } = await run(healthy(directory), { start: { reason: "resume" }, cwd: SESSION_CWD })
    expect(api.calls.length).toBeGreaterThan(4)
    for (const call of api.calls) {
      expect(call.cwd).toBe(PACKAGE_ROOT)
      expect(call.cwd).not.toBe(project)
    }
    const git = api.calls.filter((call) => call.command === "git")
    expect(git.map((call) => call.args)).toEqual([["-C", project, "rev-parse", "--show-toplevel"]])
    for (const call of api.calls.filter((entry) => entry.command === "sh"))
      expect(call.args.slice(0, 3)).toEqual([WRAPPER, PI_PROJECT_FLAG, project])
    await rm(directory, { recursive: true, force: true })
  })

  test("a relative session folder is made absolute, so it cannot resolve against the package's folder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-relative-"))
    const relative = join("relative", "project")
    const { api } = await run(healthy(directory), { start: { reason: "resume" }, cwd: relative })
    const project = resolve(relative)
    expect(isAbsolute(project)).toBe(true)
    const git = api.calls.filter((call) => call.command === "git")
    expect(git.map((call) => call.args)).toEqual([["-C", project, "rev-parse", "--show-toplevel"]])
    const wrapped = api.calls.filter((call) => call.command === "sh")
    expect(wrapped.length).toBeGreaterThan(3)
    for (const call of wrapped)
      expect(call.args.slice(0, 3)).toEqual([WRAPPER, PI_PROJECT_FLAG, project])
    await rm(directory, { recursive: true, force: true })
  })
})

describe("a git failure that does not say the project is not a repository", () => {
  const failing =
    (outcome: Outcome): Responder =>
    (call, runtime) =>
      call.command === "git" ? outcome : healthy("/unused")(call, runtime)

  const cases: ReadonlyArray<readonly [string, Outcome, string]> = [
    ["a timeout", { killed: true, code: 143 }, "timed out"],
    [
      "dubious ownership",
      { code: 128, stderr: "fatal: detected dubious ownership in repository at '/work/project'\n" },
      "dubious ownership",
    ],
    ["a failure without a message", { code: 1 }, "exit 1"],
  ]

  for (const [name, outcome, reason] of cases)
    test(`${name} fails closed as the notice and the project is not taken for non-git`, async () => {
      const { api, delivered } = await run(failing(outcome))
      expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
      expect(delivered?.message?.display).toBe(true)
      expect(delivered?.message?.content).toContain("git rev-parse --show-toplevel")
      expect(delivered?.message?.content).toContain(reason)
      // Nothing else ran: no command guessed at a config or state folder.
      expect(startedWith(api.calls)).toEqual([])
    })
})

describe("a project that is not a git repository", () => {
  const notGit: Responder = (call, runtime) =>
    call.command === "git"
      ? {
          code: 128,
          stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        }
      : healthy("/unused")(call, runtime)

  test("its state folder is .holyagent of the project and state mode is not asked", async () => {
    const project = await mkdtemp(join(tmpdir(), "holyagent-pi-plain-mock-"))
    await mkdir(join(project, ".holyagent"))
    const { api, delivered } = await run(notGit, { cwd: project })
    const commands = startedWith(api.calls)
    expect(commands).toContain(`config ${join(project, ".holyagent")}`)
    expect(commands).toContain("status")
    expect(commands).not.toContain("state mode")
    expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(delivered?.message?.content).toContain("Ship the thing")
    await rm(project, { recursive: true, force: true })
  })

  test("without a .holyagent folder it gets nothing, except the core of a session role", async () => {
    const project = await mkdtemp(join(tmpdir(), "holyagent-pi-plain-mock-"))
    expect((await run(notGit, { cwd: project })).delivered).toBeUndefined()
    const { delivered } = await run(notGit, { cwd: project, flag: "session" })
    expect(delivered?.message?.content).toContain("You are the root")
    expect(delivered?.message?.content).not.toContain("holyagent status:")
    await rm(project, { recursive: true, force: true })
  })
})

describe("with the built package and a project that is not a git repository", () => {
  const realExec =
    (home: string): Responder =>
    async (call) => {
      const child = Bun.spawn([call.command, ...call.args], {
        ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
        env: { ...process.env, HOLYAGENT_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, code }
    }

  const plain = async () => {
    const root = await mkdtemp(join(tmpdir(), "holyagent-pi-plain-"))
    const outside = Bun.spawn(["git", "-C", root, "rev-parse", "--show-toplevel"], {
      stdout: "ignore",
      stderr: "ignore",
    })
    // The folder must not sit inside a repository, or the test would not be about one.
    expect(await outside.exited).not.toBe(0)
    return {
      root,
      home: join(root, "home"),
      done: () => rm(root, { recursive: true, force: true }),
    }
  }

  const createIntent = async (root: string, home: string) => {
    const created = Bun.spawn(
      [
        "sh",
        WRAPPER,
        PI_PROJECT_FLAG,
        root,
        "intent",
        "create",
        "--input",
        JSON.stringify({ objective: "Plain objective" }),
      ],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, HOLYAGENT_HOME: home },
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    expect(await created.exited).toBe(0)
  }

  const real = async (cwd: string, home: string, flag?: string) =>
    (await run(realExec(home), { cwd, ...(flag === undefined ? {} : { flag }) })).delivered

  test("a project with a .holyagent folder gets its status", async () => {
    const { root, home, done } = await plain()
    expect(await real(root, home)).toBeUndefined()
    await createIntent(root, home)
    const delivered = await real(root, home)
    expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(delivered?.message?.content).toContain("Plain objective")
    expect(delivered?.message?.content.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
    await done()
  })

  test("a session role gets the core and the status", async () => {
    const { root, home, done } = await plain()
    await createIntent(root, home)
    const delivered = await real(root, home, "session")
    expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(delivered?.message?.content).toContain("You are the root")
    expect(delivered?.message?.content).toContain("Plain objective")
    await done()
  })

  test("a session role without a .holyagent folder still gets the core", async () => {
    const { root, home, done } = await plain()
    const delivered = await real(root, home, "session")
    expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(delivered?.message?.content).toContain("You are the root")
    expect(delivered?.message?.content).not.toContain("holyagent status:")
    await done()
  })

  test("the wrapper fails as a state error for a project folder that does not exist", async () => {
    const child = Bun.spawn(
      ["sh", WRAPPER, PI_PROJECT_FLAG, join(tmpdir(), "holyagent-pi-no-such-project"), "status"],
      { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    )
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(code).toBe(4)
    expect(stderr).toContain("error: StateIo")
  })
})
