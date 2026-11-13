import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { chmod, mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, posix, resolve, win32 } from "node:path"

import type {
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  ToolRendererResolver,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent"
import { Effect, Exit, Schema } from "effect"

import { PLUGIN_NAMESPACE } from "../../../runtime/src/cli/assignment.ts"
import { HOST_VARIABLE, WORKFLOWS_VARIABLE } from "../../../runtime/src/cli/config.ts"
import { CONTEXT_BUDGET, SESSION_REMINDER } from "../../../runtime/src/cli/sessioncontext.ts"
import { CLAUDE_SPECIALISTS } from "../../../runtime/src/cli/workflow-check.ts"
import { Config, defaultConfig } from "../../../runtime/src/config/schema.ts"
import { toPosix } from "../../../runtime/src/domain/paths.ts"
import {
  parseOutput,
  PI_ROOT_CORE,
  PI_ROOT_PLACEHOLDER,
  PI_SESSION_REMINDER,
} from "../../../runtime/src/hooks/pi-context.ts"
import { PI_PROJECT_FLAG } from "../../../runtime/src/hooks/pi-project.ts"
import { cmdExeArguments } from "../../../runtime/src/pi/bash/cmd.ts"
import { providerEnv, routedModels } from "../../../runtime/src/pi/provider.ts"
import { PI_ROOT_PROMPT, PI_ROOT_PROMPTS } from "../../../runtime/src/pi/root-prompt.ts"
import { toolArgs } from "../../../runtime/src/pi/tools.ts"
import { PROCESS_TIMEOUT_MS } from "../../../runtime/tests/fixtures.ts"
import {
  AGENT_TOOL,
  applyEnvironment,
  type BunSearch,
  CACHE_RETENTION_ENV,
  childAgent,
  CMD_NOT_FOUND,
  COMMAND_TIMEOUT_MS,
  CONTEXT_MESSAGE,
  type CoreServices,
  createExtension as actualCreateExtension,
  CUT_OFF_REPORT,
  EMPTY_REPORT,
  type ExtensionOptions,
  failedFinalMessage,
  fillPackageRoot,
  findBun,
  HOST_ENV,
  hostEnvironment,
  memoizeLast,
  NOTICE_MESSAGE,
  refuseExcludedTool,
  refuseNonSpecialist,
  refuseNonSpecialistWorkflow,
  ROLE_FLAG,
  runtimeArgs,
  sanitizeWorkflowName,
  SESSION_DEADLINE_MS,
  WORKFLOW_TOOL,
  workflowCallLine,
  workflowRenderers,
  WORKFLOWS_ENV,
} from "../src/extension.ts"
import { familyAgentPrompt, promptBody } from "../src/families.ts"
import { DIST_DIRECTORY, REPOSITORY } from "../src/files.ts"
import { AGENT_TYPES, SCREEN_SPECIALIST_NAMES, SPECIALIST_NAMES } from "../src/specialists.ts"
import { removeTemporary } from "./temp-folder.ts"

// The original lifecycle tests use a deterministic in-memory host, not a real CLI process.
// They supply a semantic core port so lifecycle and policy regressions remain testable after the
// production extension switched to direct Node core calls. Real direct integration is tested in
// native-direct.test.ts.
const createExtension =
  (options: ExtensionOptions = {}) =>
  (pi: ExtensionAPI) => {
    let cached: string | undefined
    const runtime = (project: string, signal: AbortSignal, ...words: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const platform = options.platform ?? process.platform
        const path = options.platformPath ?? (platform === "win32" ? win32 : posix)
        const root = options.packageRoot ?? PACKAGE_ROOT
        const argv = [...runtimeArgs(root, path), PI_PROJECT_FLAG, project, ...words]
        const search = options.bunSearch ?? {}
        const launch = (program: string) =>
          platform === "win32" && /\.cmd$/i.test(program)
            ? cmdExeArguments(program, argv)
            : { ok: true as const, args: argv }
        const failed = (reason: string) =>
          new Error(`\`holyagent ${words.join(" ")}\` failed: ${reason}`)
        const attempt = (looked: boolean): Effect.Effect<ExecResult, Error> =>
          Effect.suspend(() => {
            if (cached === undefined || !launch(cached).ok) {
              const found = findBun(platform, path, search, (program) => {
                const choice = launch(program)
                return choice.ok ? undefined : choice.reason
              })
              if (!found.found) return Effect.fail(failed(found.looked))
              cached = found.program
            }
            const program = cached
            const cmd = launch(program)
            if (!cmd.ok) return Effect.fail(failed(cmd.reason))
            const shim = platform === "win32" && /\.cmd$/i.test(program)
            const action = Effect.acquireUseRelease(
              Effect.sync(() => {
                const stop = new AbortController()
                const settled = pi
                  .exec(shim ? "cmd.exe" : program, [...cmd.args], {
                    cwd: root,
                    signal: AbortSignal.any([signal, stop.signal]),
                    timeout: COMMAND_TIMEOUT_MS,
                  })
                  .then(
                    (result) => Effect.succeed(result),
                    (error) => Effect.fail(failed(String(error))),
                  )
                return { stop, settled }
              }),
              ({ settled }) =>
                Effect.callback<ExecResult, Error>((resume) => {
                  void settled.then((answer) => resume(answer))
                  const abort = () => resume(Effect.fail(failed("it was stopped")))
                  if (signal.aborted) abort()
                  signal.addEventListener("abort", abort, { once: true })
                  return Effect.sync(() => signal.removeEventListener("abort", abort))
                }),
              ({ stop, settled }, exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : Effect.sync(() => stop.abort()).pipe(
                      Effect.andThen(Effect.promise(() => settled)),
                      Effect.timeoutOption(options.graceMs ?? 2_000),
                      Effect.asVoid,
                    ),
            )
            const retry = () => {
              cached = undefined
              return attempt(true)
            }
            const gone = () =>
              !looked && !signal.aborted && search.exists !== undefined && !search.exists(program)
            return action.pipe(
              Effect.matchEffect({
                onFailure: (error) => (gone() ? retry() : Effect.fail(error)),
                onSuccess: (result) =>
                  (result.code !== 0 || result.killed) && gone() ? retry() : Effect.succeed(result),
              }),
            )
          })
        const result = yield* attempt(false)
        if (result.code !== 0 || result.killed) {
          const first = result.stderr
            .split("\n")
            .map((line) => line.trim())
            .find(Boolean)
          const reason = result.killed
            ? "it timed out or was stopped"
            : first === undefined
              ? `exit ${result.code}`
              : first.replace(/^error: /, "")
          return yield* Effect.fail(failed(reason))
        }
        return result.stdout
      })
    const coreServices: CoreServices = {
      config: (project, folders, signal) =>
        runtime(project, signal, "config", ...folders).pipe(
          Effect.flatMap((text) =>
            Schema.decodeUnknownEffect(Schema.fromJsonString(Config), {
              onExcessProperty: "error",
            })(text),
          ),
        ),
      directory: (project, top, git, signal) =>
        git
          ? runtime(project, signal, "state", "mode").pipe(
              Effect.flatMap((text) => parseOutput("state mode", text)),
              Effect.map((value) => value["directory"]),
            )
          : Effect.succeed(join(top, ".holyagent")),
      status: (project, signal) =>
        runtime(project, signal, "status").pipe(
          Effect.flatMap((text) => parseOutput("status", text)),
        ),
      reconcile: (project, signal) =>
        runtime(project, signal, "reconcile").pipe(
          Effect.flatMap((text) => parseOutput("reconcile", text)),
        ),
    }
    return actualCreateExtension({ ...options, coreServices })(pi)
  }

const PACKAGE_ROOT = join(REPOSITORY, DIST_DIRECTORY)
// The model reads the wrapper's path with `/` only, drive letter included on Windows.
const WRAPPER = toPosix(join(PACKAGE_ROOT, "scripts", "holyagent"))
// What the extension starts Bun with: the bundled CLI, never the `sh` wrapper.
const RUNTIME = runtimeArgs(PACKAGE_ROOT)
// A machine with Bun on its PATH, and a Windows one: the program the extension starts is the
// full path it found, never a bare `bun`. The extension joins what it finds with the test
// process's own path module (a `\` on Windows), so the stub's path is joined the same way.
const BUN = join("/stub/bin", "bun")
const BUN_SEARCH: BunSearch = {
  env: { PATH: "/stub/bin" },
  exists: (path) => path === BUN,
  executable: () => true,
}
const WINDOWS_BUN = "C:\\stub\\bin\\bun.exe"
const WINDOWS_SEARCH: BunSearch = {
  env: { Path: "C:\\stub\\bin" },
  exists: (path) => path === WINDOWS_BUN,
}
const DEFAULTS = await Effect.runPromise(defaultConfig)
const CONFIG = JSON.stringify(DEFAULTS)
const DISABLED = JSON.stringify({
  ...(await Effect.runPromise(defaultConfig)),
  pi: { ...(await Effect.runPromise(defaultConfig)).pi, enable: false },
})

/** What `pi --list-models` prints for a catalog that lists every model of the default routes. */
const CATALOG = [
  "provider     model   context  max-out  thinking  images",
  ...routedModels(DEFAULTS).map(
    ({ provider, model }) => `${provider}  ${model}  256K  32K  yes  no`,
  ),
].join("\n")

/** The answers of the `pi` probes of a provider that is logged in and lists every route's model. */
const readyPi: PiProbe = (args) =>
  args[0] === "auth" ? { code: 0 } : { code: 0, stdout: `${CATALOG}\n` }

type PiProbe = (args: ReadonlyArray<string>, signal?: AbortSignal) => Outcome | Promise<Outcome>

interface Call {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly signal: AbortSignal | undefined
}

type Outcome = Partial<Pick<ExecResult, "stdout" | "stderr" | "code" | "killed">>
type Responder = (call: Call, runtime: ReadonlyArray<string>) => Outcome | Promise<Outcome>

/** The holyagent subcommand a call runs through the bundled CLI, or undefined for another program. */
const subcommand = (call: Call): ReadonlyArray<string> | undefined =>
  (call.command === BUN || call.command === WINDOWS_BUN) &&
  call.args[0] === "--no-env-file" &&
  call.args[RUNTIME.length] === PI_PROJECT_FLAG
    ? call.args.slice(RUNTIME.length + 2)
    : undefined

/** The arguments of a `pi` probe: a plain call, or the one `cmd.exe` makes on Windows. */
const probeArgs = (call: Call): ReadonlyArray<string> | undefined =>
  call.command === "pi"
    ? call.args
    : call.command === "cmd.exe" && call.args.slice(0, 5).join(" ") === "/d /s /c call pi"
      ? call.args.slice(5)
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
const fakeApi = (
  responder: Responder,
  value?: string | boolean,
  cwd = SESSION_CWD,
  session: {
    readonly name?: string
    readonly activeTools?: ReadonlyArray<string>
    /** Every registered tool; the active ones by default. */
    readonly allTools?: ReadonlyArray<string>
    /**
     * What the `pi` probes (`pi auth check`, `pi --list-models`) answer; a ready provider by
     * default.
     */
    readonly pi?: PiProbe
    /** Makes `setActiveTools` throw this. */
    readonly toolsFail?: Error
    /** Makes the first `setActiveTools` throw this; later calls succeed. */
    readonly toolsFailOnce?: Error
    /** The context's run mode; read only by a session under T3 Code, so absent for any other. */
    readonly mode?: ExtensionContext["mode"]
    /** The context's `ui`, likewise only for a session that uses it. */
    readonly ui?: object
    /** The context's active model; none by default. */
    readonly model?: { readonly provider: string }
    /** Other members of the context a test gives (a session manager, a model registry). */
    readonly members?: Readonly<Record<string, unknown>>
    /** Makes `registerMcpServer` throw this. */
    readonly mcpFail?: Error
  } = {},
) => {
  const flags = new Map<string, { type: string; default?: string }>()
  const handlers = new Map<string, Array<(...args: Array<never>) => unknown>>()
  const calls: Array<Call> = []
  const sent: Array<unknown> = []
  // The tool lists the extension passed to setActiveTools, in order.
  const toolSets: Array<ReadonlyArray<string>> = []
  // The test's own list when it gives one, so a change it makes mid-session reaches the extension.
  const active = (session.activeTools ?? []) as Array<string>
  const touched: Array<string> = []
  let failedOnce = false
  const renderers: Array<ToolRendererResolver> = []
  // The tools the extension registered (only `apply_patch`, inactive).
  const tools: Array<{ readonly name: string }> = []
  // The MCP servers the extension registered, by name, with the config it gave.
  const mcpServers: Array<{ readonly name: string; readonly config: unknown }> = []
  // The commands started and not yet settled: a process that is still running.
  const running = { count: 0 }
  const api = {
    registerFlag: (name: string, options: { type: string; default?: string }) =>
      void flags.set(name, options),
    getFlag: (name: string) => value ?? flags.get(name)?.default,
    registerToolRenderer: (resolver: ToolRendererResolver) => void renderers.push(resolver),
    registerTool: (tool: { readonly name: string }) => void tools.push(tool),
    registerCommand: () => undefined,
    registerMcpServer: (name: string, config: unknown) => {
      if (session.mcpFail !== undefined) throw session.mcpFail
      mcpServers.push({ name, config })
    },
    getSessionName: () => session.name,
    getActiveTools: () => [...active],
    getAllTools: () => (session.allTools ?? active).map((name) => ({ name })),
    setActiveTools: (names: ReadonlyArray<string>) => {
      if (session.toolsFail !== undefined) throw session.toolsFail
      if (session.toolsFailOnce !== undefined && !failedOnce) {
        failedOnce = true
        throw session.toolsFailOnce
      }
      toolSets.push(names)
      active.splice(0, active.length, ...names)
    },
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
      running.count += 1
      try {
        const probe = probeArgs(call)
        const outcome =
          probe !== undefined
            ? await (session.pi ?? readyPi)(probe, options?.signal)
            : await responder(call, subcommand(call) ?? [])
        return { stdout: "", stderr: "", code: 0, killed: false, truncated: false, ...outcome }
      } finally {
        running.count -= 1
      }
    },
  }
  // Only `cwd` of the context is read, and `mode` and `ui` when the test gives them: any other
  // member fails the test.
  const context = new Proxy(
    { cwd },
    {
      get: (target, key) => {
        if (key === "cwd") return target.cwd
        if (key === "mode" && session.mode !== undefined) return session.mode
        if (key === "ui" && session.ui !== undefined) return session.ui
        // The auto-review gate reads the active model's provider on every tool call; the model is
        // absent unless a test gives one, which keeps the gate inert.
        if (key === "model") return session.model
        if (typeof key === "string" && session.members !== undefined && key in session.members)
          return session.members[key]
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
    renderers,
    tools,
    mcpServers,
    calls,
    sent,
    toolSets,
    touched,
    running,
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
    /** The session's name: a child of the package has `<agent>#<id>`. */
    sessionName?: string
    activeTools?: ReadonlyArray<string>
    allTools?: ReadonlyArray<string>
    pi?: PiProbe
    toolsFail?: Error
    toolsFailOnce?: Error
    mode?: ExtensionContext["mode"]
    ui?: object
    model?: { readonly provider: string }
    members?: Readonly<Record<string, unknown>>
    mcpFail?: Error
    deadlineMs?: number
    /** Starts the session and stops there, so no run takes what the start produced. */
    startOnly?: boolean
    /** The environment the extension writes to; a fresh empty one by default. */
    env?: Record<string, string | undefined>
    systemPrompt?: string
    packageRoot?: string
    platformPath?: ExtensionOptions["platformPath"]
    platform?: ExtensionOptions["platform"]
    /** Where Bun is: on the PATH of a POSIX machine, or of a Windows one with `platform` win32. */
    bunSearch?: BunSearch
  } = {},
) => {
  const api = fakeApi(responder, options.flag, options.cwd, {
    ...(options.sessionName === undefined ? {} : { name: options.sessionName }),
    ...(options.activeTools === undefined ? {} : { activeTools: options.activeTools }),
    ...(options.allTools === undefined ? {} : { allTools: options.allTools }),
    ...(options.pi === undefined ? {} : { pi: options.pi }),
    ...(options.toolsFail === undefined ? {} : { toolsFail: options.toolsFail }),
    ...(options.toolsFailOnce === undefined ? {} : { toolsFailOnce: options.toolsFailOnce }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.ui === undefined ? {} : { ui: options.ui }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.members === undefined ? {} : { members: options.members }),
    ...(options.mcpFail === undefined ? {} : { mcpFail: options.mcpFail }),
  })
  const env = options.env ?? {}
  createExtension({
    packageRoot: options.packageRoot ?? PACKAGE_ROOT,
    env,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.platformPath === undefined ? {} : { platformPath: options.platformPath }),
    // A POSIX machine unless a test says otherwise, whatever the platform the tests run on.
    platform: options.platform ?? "linux",
    bunSearch: options.bunSearch ?? (options.platform === "win32" ? WINDOWS_SEARCH : BUN_SEARCH),
  })(api.pi)
  await api.emit("session_start", options.start ?? { reason: "startup" })
  await options.afterwards?.(api)
  if (options.startOnly === true) return { api, delivered: undefined, env }
  const results = await api.emit("before_agent_start", {
    prompt: "hello",
    systemPrompt: options.systemPrompt ?? "the system prompt",
  })
  const delivered = results.find((result) => result !== undefined) as Delivered | undefined
  return { api, delivered, env }
}

/**
 * The command line Node builds from an argv on Windows when it spawns without a shell and without
 * `windowsVerbatimArguments`, as Pi's `exec` does: a word with a space, a tab or a quote is wrapped
 * in quotes (a quote inside is escaped as `\"`), any other word is left bare.
 */
const nodeCommandLine = (args: ReadonlyArray<string>): string =>
  args.map((word) => (/[ \t"]/.test(word) ? `"${word.replace(/"/g, '\\"')}"` : word)).join(" ")

const startedWith = (calls: ReadonlyArray<Call>) =>
  calls.map((call) => subcommand(call)?.join(" ")).filter((entry) => entry !== undefined)

describe("the factory", () => {
  test("registers the role flag and the handlers and starts nothing", () => {
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
      expect(
        createExtension({
          packageRoot: PACKAGE_ROOT,
          env: {},
          platform: "linux",
          bunSearch: BUN_SEARCH,
        })(api.pi),
      ).toBeUndefined()
    } finally {
      Object.assign(globalThis, originals)
    }
    expect(api.flags.get(ROLE_FLAG)).toMatchObject({ type: "string", default: "root" })
    expect([...api.handlers.keys()].toSorted()).toEqual([
      "agent_start",
      "before_agent_start",
      "before_provider_request",
      "message_end",
      "provider_stream_event",
      "session_compact",
      "session_shutdown",
      "session_start",
      "session_tree",
      "tool_call",
    ])
    // The Codex module's one tool is registered inactive, so no other provider has it.
    expect(api.tools.map((tool) => tool.name)).toEqual(["apply_patch"])
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
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
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
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    expect(await api.emit("session_shutdown", { reason: "quit" })).toEqual([undefined])
    expect(api.calls).toEqual([])
  })

  test("a new start releases the previous one", async () => {
    const api = fakeApi(healthy("/missing"))
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
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
    return { directory, done: () => removeTemporary(directory) }
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
    expect(session).toContain(WRAPPER)
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
    return { directory, done: () => removeTemporary(directory) }
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

  test("the status is a message on the next run, delivered once and never sent; the root prompt comes on every run", async () => {
    const { directory, done } = await withState()
    const { api, delivered } = await run(healthy(directory))
    expect(Object.keys(delivered ?? {}).toSorted()).toEqual(["message", "systemPrompt"])
    expect(delivered?.message?.display).toBe(false)
    expect(api.sent).toEqual([])
    const again = (await api.emit("before_agent_start", {
      prompt: "again",
      systemPrompt: "the system prompt",
    })) as Array<Delivered | undefined>
    expect(again[0]?.systemPrompt).toBe(delivered?.systemPrompt)
    expect(again[0]?.message).toBeUndefined()
    expect(again[1]).toBeUndefined()
    await done()
  })

  test("Bun runs the package's holyagent.js with no env file and the empty config, as the wrapper does", () => {
    expect(runtimeArgs("/opt/pkg")).toEqual([
      "--no-env-file",
      `--config=${join("/opt/pkg", "scripts", "empty-bunfig.toml")}`,
      join("/opt/pkg", "scripts", "holyagent.js"),
    ])
    expect(runtimeArgs("C:\\Users\\me\\pkg", win32)).toEqual([
      "--no-env-file",
      "--config=C:\\Users\\me\\pkg\\scripts\\empty-bunfig.toml",
      "C:\\Users\\me\\pkg\\scripts\\holyagent.js",
    ])
    // The wrapper's last line is the call these arguments repeat: the same Bun flags, then the file.
    const exec = readFileSync(
      join(REPOSITORY, "packages/integrations/claude/src/wrapper.sh"),
      "utf8",
    )
      .trim()
      .split("\n")
      .at(-1)
    for (const part of [
      "--no-env-file",
      '--config="$here/empty-bunfig.toml"',
      '"$here/holyagent.js"',
    ])
      expect(exec).toContain(part)
  })

  test("Bun on holyagent.js is the only way to the runtime: never sh or the wrapper", async () => {
    const { directory, done } = await withState()
    const { api } = await run(healthy(directory), { start: { reason: "resume" } })
    expect(api.calls.some((call) => call.command === "sh")).toBe(false)
    for (const call of api.calls) {
      if (call.command === "git" || call.command === "pi") continue
      expect({
        command: call.command,
        runtime: call.args.slice(0, RUNTIME.length),
        project: call.args.slice(RUNTIME.length, RUNTIME.length + 2),
      }).toEqual({
        command: BUN,
        runtime: [...RUNTIME],
        project: [PI_PROJECT_FLAG, SESSION_PROJECT],
      })
    }
    const commands = startedWith(api.calls)
    for (const expected of [
      `config ${join("/work/project", ".holyagent")}`,
      "status",
      "reconcile",
      "state mode",
    ])
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
    await removeTemporary(directory)
  })

  test("is empty without a .holyagent folder, except the core of a session role", async () => {
    const missing = join(tmpdir(), "holyagent-pi-no-such-folder", ".holyagent")
    expect((await run(healthy(missing), { flag: "root" })).delivered?.message).toBeUndefined()
    expect((await run(healthy(missing), { flag: "specialist" })).delivered).toBeUndefined()
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
      await removeTemporary(directory)
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
    await removeTemporary(directory)
  })

  test("a notice carries no control character, however the failure is written", async () => {
    // ESC and CSI start escape sequences; the others move the cursor or end a line.
    const hostile =
      "a\u001b[31mred\u001b]0;title\u0007\u009b2Jb\u0000c\rd\u0085e\u200ff\u202eg\u007fh"
    const { delivered } = await run(
      healthy("/missing", { status: { code: 4, stderr: `error: ${hostile}\n` } }),
    )
    const content = delivered?.message?.content ?? ""
    expect(content).toContain("red")
    expect(unsafeCharacters(content)).toEqual([])
    expect(content).toContain("holyagent: ")
  })

  test("a notice carries no format character or variation selector, and keeps ordinary text", async () => {
    // Word joiners and invisible operators, the Arabic letter mark, the Mongolian vowel separator,
    // a soft hyphen, the tag block and variation selectors.
    const hidden =
      "\u2060\u2061\u2062\u2063\u2064\u061c\u180e\u00ad\u{e0001}\u{e0041}\u{e007f}\ufe00\ufe0f"
    const { delivered } = await run(
      healthy("/missing", {
        status: { code: 4, stderr: `error: ca${hidden}fe \u65e5\u672c\u8a9e \u00fc\n` },
      }),
    )
    const content = delivered?.message?.content ?? ""
    expect(content).toBe("holyagent: `holyagent status` failed: cafe \u65e5\u672c\u8a9e \u00fc")
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
      const child = Bun.spawn(
        [call.command === BUN ? process.execPath : call.command, ...call.args],
        {
          ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
          env: { ...process.env, HOLYAGENT_HOME: home },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          // Pi's exec kills the process when the signal aborts.
          ...(call.signal === undefined ? {} : { signal: call.signal }),
        },
      )
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
      done: () => removeTemporary(root),
    }
  }

  const real = async (cwd: string, home: string) => (await run(realExec(home), { cwd })).delivered

  test(
    "a project with an Intent gets its status; one without a .holyagent folder gets nothing",
    async () => {
      const { root, home, done } = await project()
      expect((await real(root, home))?.message).toBeUndefined()
      const created = Bun.spawn(
        [
          "bun",
          ...RUNTIME,
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
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "a bad .holyagent/config.json is reported with the field it names",
    async () => {
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
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "pi.enable false in the project's config adds nothing",
    async () => {
      const { root, home, done } = await project()
      await mkdir(join(root, ".holyagent"), { recursive: true })
      await Bun.write(
        join(root, ".holyagent", "config.json"),
        JSON.stringify({ pi: { enable: false } }),
      )
      // Nothing is added, but the root keeps its prompt: only the user's own config lifts it.
      const delivered = await real(root, home)
      expect(delivered?.message).toBeUndefined()
      expect(delivered?.systemPrompt).toContain("the system prompt")
      await done()
    },
    PROCESS_TIMEOUT_MS,
  )
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
    return { directory, done: () => removeTemporary(directory) }
  }

  test("status finishes before reconcile starts", async () => {
    const { directory, done } = await state()
    const hold = gate()
    const inner = healthy(directory)
    const api = fakeApi((call, runtime) =>
      runtime[0] === "status" ? gated(hold, { stdout: STATUS }, call.signal) : inner(call, runtime),
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
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
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
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
      await Bun.sleep(100)
      return inner(call, runtime)
    })
    // Four steps of 100ms in sequence (git, config with the state folder, status, reconcile) cross
    // a 250ms deadline in status. A slow runner only brings the deadline earlier.
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
      deadlineMs: 250,
    })(api.pi)
    const began = performance.now()
    await api.emit("session_start", { reason: "resume" })
    expect(performance.now() - began).toBeLessThan(5_000)
    const delivered = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(delivered.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered.message?.content).toContain("longer than")
    // The command in flight at the deadline is stopped, and none starts after it.
    expect(api.calls.at(-1)?.signal?.aborted).toBe(true)
    const count = api.calls.length
    await Bun.sleep(500)
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
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
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
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    await api.emit("session_shutdown", { reason: "quit" })
    await started
    expect(await api.emit("before_agent_start", { prompt: "x" })).toEqual([undefined])
    await done()
  })
})

describe("no command outlives a gather", () => {
  // A stopped command takes a while to exit, as a process does: it settles `delay` ms after the
  // signal aborts, which a gather that does not wait for it would return before.
  const slowToStop =
    (hold: ReturnType<typeof gate>, answer: Outcome, delay = 60) =>
    (call: Call): Promise<Outcome> =>
      new Promise((settle) => {
        hold.enter()
        const stop = () => void setTimeout(() => settle({ killed: true, code: 143 }), delay)
        if (call.signal?.aborted) return stop()
        call.signal?.addEventListener("abort", stop, { once: true })
        void hold.promise.then(() => settle(answer))
      })

  test("when the config fails, the state folder command is stopped and awaited before the notice is delivered", async () => {
    const hold = gate()
    const inner = healthy("/missing")
    const api = fakeApi((call, runtime) => {
      if (runtime[0] === "config")
        return hold.entered.then(() => ({
          code: 4,
          stderr: "error: ConfigInvalid: bad\nhint: Fix it.\n",
        }))
      return runtime[0] === "state" ? slowToStop(hold, { stdout: "" })(call) : inner(call, runtime)
    })
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    await api.emit("session_start", { reason: "startup" })
    expect(api.running.count).toBe(0)
    const delivered = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(delivered.message?.customType).toBe(NOTICE_MESSAGE)
    expect(api.running.count).toBe(0)
  })

  test("at the deadline, the command in flight is stopped and awaited before the notice is delivered", async () => {
    const hold = gate()
    const inner = healthy("/missing")
    const api = fakeApi((call, runtime) =>
      runtime[0] === "status" ? slowToStop(hold, { stdout: STATUS })(call) : inner(call, runtime),
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
      deadlineMs: 100,
    })(api.pi)
    await api.emit("session_start", { reason: "startup" })
    expect(api.running.count).toBe(0)
    const delivered = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(delivered.message?.content).toContain("longer than")
  })

  // A command that exits only when the test lets it, after it was stopped: a process that is slow
  // to leave, which a shutdown that does not wait for it would return before.
  const lingering =
    (hold: ReturnType<typeof gate>, exit: ReturnType<typeof gate>, answer: Outcome) =>
    (call: Call): Promise<Outcome> =>
      new Promise((settle) => {
        hold.enter()
        const stop = () => void exit.promise.then(() => settle({ killed: true, code: 143 }))
        if (call.signal?.aborted) return stop()
        call.signal?.addEventListener("abort", stop, { once: true })
        void hold.promise.then(() => settle(answer))
      })

  /** Whether the promise has settled after the other work queued so far has run. */
  const settledSoon = async (promise: Promise<unknown>): Promise<boolean> => {
    let settled = false
    void promise.then(() => void (settled = true))
    await Bun.sleep(30)
    return settled
  }

  test("session_shutdown settles only after the stopped command has exited, awaiting nothing else", async () => {
    const hold = gate()
    const exit = gate()
    const inner = healthy("/missing")
    const api = fakeApi((call, runtime) =>
      runtime[0] === "status"
        ? lingering(hold, exit, { stdout: STATUS })(call)
        : inner(call, runtime),
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    // Pi does not wait for the session_start handler, and neither does this test.
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    expect(api.running.count).toBe(1)
    const shutdown = api.emit("session_shutdown", { reason: "quit" })
    expect(await settledSoon(shutdown)).toBe(false)
    expect(api.running.count).toBe(1)
    exit.open()
    await shutdown
    expect(api.running.count).toBe(0)
    await started
  })

  test("session_shutdown also waits for the children of an older gather that a compaction stopped", async () => {
    const hold = gate()
    const exit = gate()
    const inner = healthy("/missing")
    let first = true
    const api = fakeApi((call, runtime) => {
      if (runtime[0] !== "status" || !first) return inner(call, runtime)
      first = false
      return lingering(hold, exit, { stdout: STATUS })(call)
    })
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    // The compaction's own gather runs to its end while the older one's command is still leaving.
    await api.emit("session_compact", { reason: "threshold" })
    // The compaction did the start's work, so its provider probes have to end first.
    await Bun.sleep(30)
    expect(api.running.count).toBe(1)
    const shutdown = api.emit("session_shutdown", { reason: "quit" })
    expect(await settledSoon(shutdown)).toBe(false)
    exit.open()
    await shutdown
    expect(api.running.count).toBe(0)
    await started
  })

  test("a command that never exits is given up on after the grace, and the shutdown does not hang", async () => {
    const hold = gate()
    const inner = healthy("/missing")
    // It ignores the signal, as a process whose grandchild holds the pipes does.
    const api = fakeApi((call, runtime) =>
      runtime[0] === "status" ? new Promise<Outcome>(() => hold.enter()) : inner(call, runtime),
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
      graceMs: 50,
    })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    await api.emit("session_shutdown", { reason: "quit" })
    await started
    expect(api.running.count).toBe(1)
  })

  test("a gather ended by its deadline does not wait longer than the grace for a command that never exits", async () => {
    const inner = healthy("/missing")
    const api = fakeApi((call, runtime) =>
      runtime[0] === "status" ? new Promise<Outcome>(() => {}) : inner(call, runtime),
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
      deadlineMs: 50,
      graceMs: 50,
    })(api.pi)
    await api.emit("session_start", { reason: "startup" })
    const delivered = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(delivered.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered.message?.content).toContain("longer than")
  })

  test("a pi.exec that throws before it returns a promise is a notice naming the command, not a defect", async () => {
    const api = fakeApi(healthy("/missing"))
    ;(api.pi as unknown as { exec: () => never }).exec = () => {
      throw new Error("sync boom")
    }
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    await api.emit("session_start", { reason: "startup" })
    const delivered = (await api.emit("before_agent_start", { prompt: "x" })).at(0) as Delivered
    expect(delivered.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered.message?.content).toContain("`holyagent -C")
    expect(delivered.message?.content).toContain(
      "rev-parse --show-toplevel` failed: Error: sync boom",
    )
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
    const bundled = api.calls.filter((entry) => entry.command === BUN)
    expect(bundled.length).toBeGreaterThan(3)
    for (const call of bundled)
      expect(call.args.slice(0, RUNTIME.length + 2)).toEqual([...RUNTIME, PI_PROJECT_FLAG, project])
    await removeTemporary(directory)
  })

  test("a relative session folder is made absolute, so it cannot resolve against the package's folder", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-relative-"))
    const relative = join("relative", "project")
    const { api } = await run(healthy(directory), { start: { reason: "resume" }, cwd: relative })
    const project = resolve(relative)
    expect(isAbsolute(project)).toBe(true)
    const git = api.calls.filter((call) => call.command === "git")
    expect(git.map((call) => call.args)).toEqual([["-C", project, "rev-parse", "--show-toplevel"]])
    const wrapped = api.calls.filter((call) => call.command === BUN)
    expect(wrapped.length).toBeGreaterThan(3)
    for (const call of wrapped)
      expect(call.args.slice(0, RUNTIME.length + 2)).toEqual([...RUNTIME, PI_PROJECT_FLAG, project])
    await removeTemporary(directory)
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
      // Only the user's own config was read, which needs no project folder: no command guessed at
      // the project's config or state folder.
      expect(startedWith(api.calls)).toEqual(["config"])
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
    await removeTemporary(project)
  })

  test("without a .holyagent folder it gets nothing, except the core of a session role", async () => {
    const project = await mkdtemp(join(tmpdir(), "holyagent-pi-plain-mock-"))
    expect((await run(notGit, { cwd: project })).delivered?.message).toBeUndefined()
    const { delivered } = await run(notGit, { cwd: project, flag: "session" })
    expect(delivered?.message?.content).toContain("You are the root")
    expect(delivered?.message?.content).not.toContain("holyagent status:")
    await removeTemporary(project)
  })
})

describe("with the built package and a project that is not a git repository", () => {
  const realExec =
    (home: string): Responder =>
    async (call) => {
      const child = Bun.spawn(
        [call.command === BUN ? process.execPath : call.command, ...call.args],
        {
          ...(call.cwd === undefined ? {} : { cwd: call.cwd }),
          env: { ...process.env, HOLYAGENT_HOME: home },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        },
      )
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
      done: () => removeTemporary(root),
    }
  }

  const createIntent = async (root: string, home: string) => {
    const created = Bun.spawn(
      [
        "bun",
        ...RUNTIME,
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

  test(
    "a project with a .holyagent folder gets its status",
    async () => {
      const { root, home, done } = await plain()
      expect((await real(root, home))?.message).toBeUndefined()
      await createIntent(root, home)
      const delivered = await real(root, home)
      expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
      expect(delivered?.message?.content).toContain("Plain objective")
      expect(delivered?.message?.content.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
      await done()
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "a session role gets the core and the status",
    async () => {
      const { root, home, done } = await plain()
      await createIntent(root, home)
      const delivered = await real(root, home, "session")
      expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
      expect(delivered?.message?.content).toContain("You are the root")
      expect(delivered?.message?.content).toContain("Plain objective")
      await done()
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "a session role without a .holyagent folder still gets the core",
    async () => {
      const { root, home, done } = await plain()
      const delivered = await real(root, home, "session")
      expect(delivered?.message?.customType).toBe(CONTEXT_MESSAGE)
      expect(delivered?.message?.content).toContain("You are the root")
      expect(delivered?.message?.content).not.toContain("holyagent status:")
      await done()
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "the bundled CLI fails as a state error for a project folder that does not exist",
    async () => {
      const child = Bun.spawn(
        [
          "bun",
          ...RUNTIME,
          PI_PROJECT_FLAG,
          join(tmpdir(), "holyagent-pi-no-such-project"),
          "status",
        ],
        { cwd: PACKAGE_ROOT, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
      )
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      expect(code).toBe(4)
      expect(stderr).toContain("error: StateIo")
    },
    PROCESS_TIMEOUT_MS,
  )
})

describe("finding Bun", () => {
  /**
   * A machine whose files are exactly `files`, all executable but `plain`; `asked` records every
   * path looked at.
   */
  const machine = (
    env: Record<string, string | undefined>,
    files: ReadonlyArray<string>,
    plain: ReadonlyArray<string> = [],
  ): BunSearch & { readonly asked: Array<string> } => {
    const asked: Array<string> = []
    return {
      env,
      asked,
      exists: (path) => {
        asked.push(path)
        return files.includes(path)
      },
      executable: (path) => !plain.includes(path),
    }
  }
  const found = (lookup: ReturnType<typeof findBun>) => (lookup.found ? lookup.program : undefined)
  const unix = { PATH: "/a:/b", BUN_INSTALL: "/opt/bun", HOME: "/home/me" }
  // A POSIX package root and path module, so the paths the extension builds are the POSIX ones the
  // stubs name, though the tests run on Windows too.
  const POSIX = { packageRoot: "/pkg", platformPath: posix, platform: "linux" } as const
  const POSIX_BUNDLED = runtimeArgs(POSIX.packageRoot, posix)[2] ?? ""

  test("a Bun on PATH wins over the install folders, in the order of PATH", () => {
    const search = machine(unix, ["/b/bun", "/opt/bun/bin/bun", "/home/me/.bun/bin/bun"])
    expect(found(findBun("linux", posix, search))).toBe("/b/bun")
    const both = machine(unix, ["/a/bun", "/b/bun"])
    expect(found(findBun("linux", posix, both))).toBe("/a/bun")
  })

  test("without Bun on PATH, $BUN_INSTALL/bin comes before ~/.bun/bin", () => {
    const search = machine(unix, ["/opt/bun/bin/bun", "/home/me/.bun/bin/bun"])
    expect(found(findBun("linux", posix, search))).toBe("/opt/bun/bin/bun")
    expect(search.asked).toEqual(["/a/bun", "/b/bun", "/opt/bun/bin/bun"])
  })

  test("with no $BUN_INSTALL, or none that holds Bun, ~/.bun/bin is used", () => {
    const home = machine({ PATH: "/a", HOME: "/home/me" }, ["/home/me/.bun/bin/bun"])
    expect(found(findBun("linux", posix, home))).toBe("/home/me/.bun/bin/bun")
    const stale = machine(unix, ["/home/me/.bun/bin/bun"])
    expect(found(findBun("linux", posix, stale))).toBe("/home/me/.bun/bin/bun")
    const empty = machine({ PATH: "/a", BUN_INSTALL: "", HOME: "/home/me" }, [])
    findBun("linux", posix, empty)
    expect(empty.asked).toEqual(["/a/bun", "/home/me/.bun/bin/bun"])
  })

  test("an empty PATH entry is skipped: it would mean the project's folder", () => {
    const search = machine({ PATH: ":/a::", HOME: "/home/me" }, [])
    findBun("linux", posix, search)
    expect(search.asked).toEqual(["/a/bun", "/home/me/.bun/bin/bun"])
  })

  test("a relative PATH entry is not searched: it would name a place under the working directory", () => {
    const search = machine({ PATH: "bin:./node_modules/.bin:../x:/a", HOME: "/home/me" }, [
      "bin/bun",
      "node_modules/.bin/bun",
      "../x/bun",
      "/a/bun",
    ])
    expect(found(findBun("linux", posix, search))).toBe("/a/bun")
    expect(search.asked).toEqual(["/a/bun"])
    const none = machine({ PATH: "bin:.", HOME: "/home/me" }, ["bin/bun", "bun"])
    expect(found(findBun("linux", posix, none))).toBeUndefined()
    expect(none.asked).toEqual(["/home/me/.bun/bin/bun"])
    const windows = machine(
      { Path: 'bin;.\\x;C:bun;\\rooted;"rel";C:\\ok;\\\\srv\\share;D:/fwd' },
      ["bin\\bun.exe", "x\\bun.exe", "C:bun\\bun.exe", "C:\\ok\\bun.exe"],
    )
    expect(found(findBun("win32", win32, windows))).toBe("C:\\ok\\bun.exe")
    expect(windows.asked).toEqual(["C:\\ok\\bun.exe"])
  })

  test("on POSIX a file without an executable bit is skipped, wherever it is found", () => {
    const search = machine(unix, ["/a/bun", "/b/bun", "/opt/bun/bin/bun"], ["/a/bun"])
    expect(found(findBun("linux", posix, search))).toBe("/b/bun")
    const onlyPlain = machine(
      unix,
      ["/a/bun", "/opt/bun/bin/bun", "/home/me/.bun/bin/bun"],
      ["/a/bun", "/opt/bun/bin/bun"],
    )
    expect(found(findBun("linux", posix, onlyPlain))).toBe("/home/me/.bun/bin/bun")
    const nothing = machine(unix, ["/a/bun"], ["/a/bun"])
    expect(found(findBun("linux", posix, nothing))).toBeUndefined()
    // Windows has no executable bit to ask for.
    const windows = machine({ Path: "C:\\a" }, ["C:\\a\\bun.exe"], ["C:\\a\\bun.exe"])
    expect(found(findBun("win32", win32, windows))).toBe("C:\\a\\bun.exe")
  })

  test("a program the caller refuses is passed over, and a miss names why", () => {
    const refusal = (program: string) => (program.includes("bad") ? `no ${program}` : undefined)
    const search = machine({ PATH: "/bad:/good", HOME: "/home/me" }, ["/bad/bun", "/good/bun"])
    expect(found(findBun("linux", posix, search, refusal))).toBe("/good/bun")
    const none = machine({ PATH: "/bad", HOME: "/home/me" }, ["/bad/bun"])
    const lookup = findBun("linux", posix, none, refusal)
    expect(lookup.found ? "" : lookup.looked).toBe(
      "Bun was found but cannot be started: /bad/bun: no /bad/bun",
    )
  })

  test("nothing found says where Bun was looked for", () => {
    const lookup = findBun("linux", posix, machine(unix, []))
    expect(lookup.found).toBe(false)
    const looked = lookup.found ? "" : lookup.looked
    for (const place of ["PATH", "/opt/bun/bin", "/home/me/.bun/bin", "https://bun.sh"])
      expect(looked).toContain(place)
    const unset = findBun("linux", posix, machine({}, []))
    expect(unset.found ? "" : unset.looked).toContain("neither BUN_INSTALL nor the home folder")
  })

  test("on Windows it is bun.exe, with USERPROFILE as the home and a case-blind Path", () => {
    const env = { Path: 'C:\\a;"C:\\b c"', BUN_INSTALL: "D:\\bun", USERPROFILE: "C:\\Users\\me" }
    const onPath = machine(env, ["C:\\b c\\bun.exe", "D:\\bun\\bin\\bun.exe"])
    expect(found(findBun("win32", win32, onPath))).toBe("C:\\b c\\bun.exe")
    const install = machine(env, ["D:\\bun\\bin\\bun.exe", "C:\\Users\\me\\.bun\\bin\\bun.exe"])
    expect(found(findBun("win32", win32, install))).toBe("D:\\bun\\bin\\bun.exe")
    expect(install.asked).toEqual([
      "C:\\a\\bun.exe",
      "C:\\a\\bun.cmd",
      "C:\\b c\\bun.exe",
      "C:\\b c\\bun.cmd",
      "D:\\bun\\bin\\bun.exe",
    ])
    const home = machine({ Path: "C:\\a", USERPROFILE: "C:\\Users\\me" }, [
      "C:\\Users\\me\\.bun\\bin\\bun.exe",
    ])
    expect(found(findBun("win32", win32, home))).toBe("C:\\Users\\me\\.bun\\bin\\bun.exe")
  })

  test("on Windows a bun.exe beats the bun.cmd of the same folder, which counts on PATH only", () => {
    const env = { PATH: "C:\\npm", USERPROFILE: "C:\\Users\\me" }
    const both = machine(env, ["C:\\npm\\bun.cmd", "C:\\npm\\bun.exe"])
    expect(found(findBun("win32", win32, both))).toBe("C:\\npm\\bun.exe")
    const shim = machine(env, ["C:\\npm\\bun.cmd"])
    expect(found(findBun("win32", win32, shim))).toBe("C:\\npm\\bun.cmd")
    const installed = machine({ USERPROFILE: "C:\\Users\\me" }, [
      "C:\\Users\\me\\.bun\\bin\\bun.cmd",
    ])
    expect(found(findBun("win32", win32, installed))).toBeUndefined()
  })

  test("the extension starts the Bun it found, from $BUN_INSTALL when PATH has none", async () => {
    const { api } = await run(healthy("/missing"), {
      ...POSIX,
      bunSearch: machine({ PATH: "/usr/bin", BUN_INSTALL: "/opt/bun" }, ["/opt/bun/bin/bun"]),
    })
    const bundled = api.calls.filter((call) => call.args.includes(POSIX_BUNDLED))
    expect(bundled.length).toBeGreaterThan(0)
    for (const call of bundled) expect(call.command).toBe("/opt/bun/bin/bun")
  })

  test("a Windows bun.cmd shim starts through cmd.exe, as pi does", async () => {
    const root = "C:\\Users\\me\\pkg"
    const { api } = await run(healthy("/missing"), {
      packageRoot: root,
      platformPath: win32,
      platform: "win32",
      bunSearch: machine({ Path: "C:\\npm" }, ["C:\\npm\\bun.cmd"]),
    })
    const bundled = api.calls.filter((call) =>
      call.args.includes(runtimeArgs(root, win32)[2] ?? ""),
    )
    expect(bundled.length).toBeGreaterThan(0)
    for (const call of bundled) {
      expect(call.command).toBe("cmd.exe")
      expect(call.args.slice(0, 5)).toEqual(["/d", "/s", "/c", "call", "C:\\npm\\bun.cmd"])
      expect(call.args.slice(5, 8)).toEqual([...runtimeArgs(root, win32)])
    }
    // A bun.exe is a program and starts directly.
    const direct = await run(healthy("/missing"), {
      packageRoot: root,
      platformPath: win32,
      platform: "win32",
      bunSearch: machine({ Path: "C:\\npm" }, ["C:\\npm\\bun.exe"]),
    })
    expect(direct.api.calls.some((call) => call.command === "cmd.exe")).toBe(false)
    expect(direct.api.calls.some((call) => call.command === "C:\\npm\\bun.exe")).toBe(true)
  })

  test("a bun.cmd under a folder with spaces starts with the program and every argument as its own word", async () => {
    const root = "C:\\Users\\Jane Doe\\pkg dir"
    const shim = "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm\\bun.cmd"
    const project = "D:\\my work\\project"
    const { api } = await run(healthy(project), {
      packageRoot: root,
      platformPath: win32,
      platform: "win32",
      cwd: project,
      bunSearch: machine({ Path: "C:\\Users\\Jane Doe\\AppData\\Roaming\\npm" }, [shim]),
    })
    const bundled = api.calls.filter((call) =>
      call.args.includes(runtimeArgs(root, win32)[2] ?? ""),
    )
    expect(bundled.length).toBeGreaterThan(0)
    for (const call of bundled) {
      expect(call.command).toBe("cmd.exe")
      expect(call.args.slice(0, 5)).toEqual(["/d", "/s", "/c", "call", shim])
      expect(call.args.slice(5, 8)).toEqual([...runtimeArgs(root, win32)])
      // Node quotes a word with a space and joins them, so cmd.exe reads this line, which does not
      // start with a quote (it would strip the first and last of them).
      const line = nodeCommandLine(call.args)
      expect(line).toStartWith(
        `/d /s /c call "${shim}" --no-env-file "--config=${root}\\scripts\\empty-bunfig.toml" "${root}\\scripts\\holyagent.js" ${PI_PROJECT_FLAG} `,
      )
    }
  })

  test("a word cmd.exe would read as syntax is refused, and nothing is started", () => {
    const shim = "C:\\npm\\bun.cmd"
    for (const word of ['a"b', "50%", "a^b", "a!b", "a\nb", "a b%PATH%", 'x y" & calc & "z'])
      expect(cmdExeArguments(shim, ["--project", word]).ok).toBe(false)
    expect(cmdExeArguments("C:\\a&b\\bun.cmd", []).ok).toBe(false)
    for (const word of ["C:\\a&b", "C:\\a|b", "C:\\a<b", "C:\\a>b", "C:\\(x86)"])
      expect(cmdExeArguments(shim, [word]).ok).toBe(false)
    // In quotes, which Node adds to a word with a space, the same characters are literal.
    expect(cmdExeArguments(shim, ["C:\\Program Files (x86)\\a&b"])).toEqual({
      ok: true,
      args: ["/d", "/s", "/c", "call", shim, "C:\\Program Files (x86)\\a&b"],
    })
  })

  test("a bun.cmd on a PATH folder with an operator and no space is not started", async () => {
    const { api, delivered } = await run(healthy("/missing"), {
      packageRoot: "C:\\pkg",
      platformPath: win32,
      platform: "win32",
      bunSearch: machine({ Path: "C:\\a&b" }, ["C:\\a&b\\bun.cmd"]),
    })
    expect(api.calls.some((call) => call.command === "cmd.exe")).toBe(false)
    expect(delivered?.message?.content ?? "").toContain("as an operator")
  })

  test("a bun.cmd cmd.exe cannot start is passed over for the next Bun", async () => {
    const WIN = { packageRoot: "C:\\pkg", platformPath: win32, platform: "win32" } as const
    // The shim of a folder with an operator and no space comes first; the next one is safe.
    const second = await run(healthy("/missing"), {
      ...WIN,
      bunSearch: machine({ Path: "C:\\a&b;C:\\npm" }, ["C:\\a&b\\bun.cmd", "C:\\npm\\bun.cmd"]),
    })
    const started = second.api.calls.filter((call) => call.args.includes("C:\\npm\\bun.cmd"))
    expect(started.length).toBeGreaterThan(0)
    expect(second.api.calls.some((call) => call.args.includes("C:\\a&b\\bun.cmd"))).toBe(false)
    // So is the one on PATH for the bun.exe of the install folder, which no quoting concerns.
    const installed = await run(healthy("/missing"), {
      ...WIN,
      bunSearch: machine({ Path: "C:\\a&b", USERPROFILE: "C:\\Users\\me" }, [
        "C:\\a&b\\bun.cmd",
        "C:\\Users\\me\\.bun\\bin\\bun.exe",
      ]),
    })
    expect(
      installed.api.calls.some((call) => call.command === "C:\\Users\\me\\.bun\\bin\\bun.exe"),
    ).toBe(true)
    expect(
      installed.api.calls.some(
        (call) => call.command === "cmd.exe" && call.args[4]?.includes("bun"),
      ),
    ).toBe(false)
    // A shim that cmd.exe can start only for some projects is passed over for those alone.
    const project = "D:\\50%"
    const mixed = await run(healthy(project), {
      ...WIN,
      cwd: project,
      bunSearch: machine({ Path: "C:\\npm", USERPROFILE: "C:\\Users\\me" }, [
        "C:\\npm\\bun.cmd",
        "C:\\Users\\me\\.bun\\bin\\bun.exe",
      ]),
    })
    expect(
      mixed.api.calls.some((call) => call.command === "C:\\Users\\me\\.bun\\bin\\bun.exe"),
    ).toBe(true)
  })

  test("when no Bun can be started the failure names the reason of each", async () => {
    const { api, delivered } = await run(healthy("/missing"), {
      packageRoot: "C:\\pkg",
      platformPath: win32,
      platform: "win32",
      bunSearch: machine({ Path: "C:\\a&b;C:\\c|d" }, ["C:\\a&b\\bun.cmd", "C:\\c|d\\bun.cmd"]),
    })
    expect(api.calls.some((call) => call.args.includes(RUNTIME[2] ?? ""))).toBe(false)
    const text = delivered?.message?.content ?? ""
    for (const part of [
      "cannot be started",
      "C:\\a&b\\bun.cmd",
      "C:\\c|d\\bun.cmd",
      "as an operator",
    ])
      expect(text).toContain(part)
    expect(text).not.toContain("not found")
  })

  test("a cached Bun that is gone is looked up again, once", async () => {
    const files = ["/usr/bin/bun"]
    const inner = healthy("/missing")
    const responder: Responder = (call) =>
      call.command.endsWith("/bun")
        ? files.includes(call.command)
          ? inner({ ...call, command: BUN }, call.args.slice(RUNTIME.length + 2))
          : { code: 1, stderr: `spawn ${call.command} ENOENT` }
        : inner(call, [])
    const search = machine({ PATH: "/usr/bin", BUN_INSTALL: "/opt/bun" }, files)
    const lookups = () => search.asked.filter((path) => path === "/usr/bin/bun").length
    let before = 0
    const { api, delivered } = await run(responder, {
      ...POSIX,
      bunSearch: { ...search, exists: (path) => search.exists?.(path) ?? false },
      afterwards: async (api) => {
        expect(api.calls.some((call) => call.command === "/usr/bin/bun")).toBe(true)
        before = api.calls.length
        // Bun moves from PATH to $BUN_INSTALL while the session runs.
        files.splice(0, files.length, "/opt/bun/bin/bun")
        await api.emit("session_start", { reason: "reload" })
      },
    })
    const after = api.calls.slice(before)
    expect(after.some((call) => call.command === "/opt/bun/bin/bun")).toBe(true)
    // Each command that failed to start on the old path ran again on the new one, and none twice.
    const gone = after.filter((call) => call.command === "/usr/bin/bun")
    expect(gone.length).toBeGreaterThan(0)
    expect(new Set(gone.map((call) => call.args.join(" "))).size).toBe(gone.length)
    for (const call of gone)
      expect(
        after.some(
          (other) =>
            other.command === "/opt/bun/bin/bun" && other.args.join(" ") === call.args.join(" "),
        ),
      ).toBe(true)
    expect(delivered?.message?.customType).not.toBe(NOTICE_MESSAGE)
    expect(lookups()).toBeGreaterThan(1)
  })

  test("with no Bun the command fails with where it looked, and nothing is started", async () => {
    const { api, delivered } = await run(healthy("/missing"), {
      ...POSIX,
      bunSearch: machine({ PATH: "/usr/bin", BUN_INSTALL: "/opt/bun", HOME: "/home/me" }, []),
    })
    expect(api.calls.some((call) => call.args.includes(POSIX_BUNDLED))).toBe(false)
    expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
    const text = delivered?.message?.content ?? ""
    for (const part of ["Bun was not found", "PATH", "/opt/bun/bin", "/home/me/.bun/bin"])
      expect(text).toContain(part)
  })

  test("a Bun installed after a failed lookup is found by the next command", async () => {
    const files: Array<string> = []
    const search = machine({ PATH: "/usr/bin" }, files)
    const { api } = await run(healthy("/missing"), {
      ...POSIX,
      bunSearch: search,
      afterwards: async (api) => {
        expect(api.calls.some((call) => call.args.includes(POSIX_BUNDLED))).toBe(false)
        files.push("/usr/bin/bun")
        await api.emit("session_start", { reason: "reload" })
      },
    })
    expect(api.calls.some((call) => call.command === "/usr/bin/bun")).toBe(true)
  })
})

describe("a Windows package root", () => {
  const WINDOWS_ROOT = "C:\\Users\\me\\pkg"

  const WINDOWS = { packageRoot: WINDOWS_ROOT, platformPath: win32, platform: "win32" } as const

  test("the CLI starts as bun on holyagent.js with the wrapper's flags, never sh, and every program starts in the package folder", async () => {
    const { api } = await run(
      (call) => (call.command === "git" ? { stdout: "/work/project\n" } : { stdout: CONFIG }),
      WINDOWS,
    )
    const bundled = api.calls.filter((call) => call.command === WINDOWS_BUN)
    expect(bundled.length).toBeGreaterThan(0)
    for (const call of bundled)
      expect(call.args.slice(0, 3)).toEqual([
        "--no-env-file",
        "--config=C:\\Users\\me\\pkg\\scripts\\empty-bunfig.toml",
        "C:\\Users\\me\\pkg\\scripts\\holyagent.js",
      ])
    expect(api.calls.map((call) => call.command)).not.toContain("sh")
    for (const call of api.calls) expect(call.cwd).toBe(WINDOWS_ROOT)
  })

  test("pi starts through cmd.exe, since Node cannot start its pi.cmd shim without a shell", async () => {
    const { api } = await run(healthy("/missing"), { ...WINDOWS, startOnly: true })
    await probesEnded(api, 2)
    const probes = api.calls.filter((call) => probeArgs(call) !== undefined)
    expect(probes.map((call) => call.command)).toEqual(["cmd.exe", "cmd.exe"])
    expect(probes.map((call) => call.args.slice(0, 5))).toEqual([
      ["/d", "/s", "/c", "call", "pi"],
      ["/d", "/s", "/c", "call", "pi"],
    ])
    expect(probes.map((call) => probeArgs(call)?.[0])).toEqual(["auth", "--list-models"])
    for (const call of probes) expect(call.cwd).toBe(WINDOWS_ROOT)
    expect(api.calls.some((call) => call.command === "pi")).toBe(false)
  })

  test("cmd.exe's not-found code says nothing about the provider, as a missing pi does elsewhere", async () => {
    for (const code of [CMD_NOT_FOUND, 1]) {
      const { api } = await run(healthy("/missing"), {
        ...WINDOWS,
        pi: () => ({ code, stderr: "pi is not recognized" }),
        startOnly: true,
      })
      await probesEnded(api, 1)
      expect(await nextMessages(api)).toHaveLength(code === 1 ? 1 : 0)
    }
  })

  test("another platform starts pi itself, and 9009 is then an ordinary exit code", async () => {
    const { api } = await run(healthy("/missing"), {
      pi: () => ({ code: CMD_NOT_FOUND, stderr: "not logged in" }),
      startOnly: true,
    })
    await probesEnded(api, 1)
    expect(api.calls.some((call) => call.command === "cmd.exe")).toBe(false)
    expect((await nextMessages(api))[0]?.content).toContain("not logged in")
  })

  test("the root gets powershell beside bash on Windows, and not elsewhere", async () => {
    // A fresh list for each run: the fake API edits the active tools in place.
    const options = () => ({
      activeTools: ["read", "bash", "write", "edit"],
      allTools: ["read", "bash", "write", "edit", "powershell", "codemode"],
    })
    const windows = await run(healthy("/missing"), { ...WINDOWS, ...options() })
    expect(windows.api.toolSets).toEqual([["read", "bash", "codemode", "powershell"]])
    const elsewhere = await run(healthy("/missing"), options())
    expect(elsewhere.api.toolSets).toEqual([["read", "bash", "codemode"]])
  })

  test("the session role's core names the package folder with / only too", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-win-"))
    const wrapper = "C:/Users/me/pkg/scripts/holyagent"
    const { delivered } = await run(
      (call) =>
        call.command === "git"
          ? { stdout: "/work/project\n" }
          : call.args[5] === "config"
            ? { stdout: CONFIG }
            : call.args[5] === "status"
              ? { stdout: STATUS }
              : call.args[5] === "state"
                ? { stdout: `mode: work\nconfigured: true\ndirectory: ${directory}\n` }
                : { code: 2 },
      { ...WINDOWS, flag: "session" },
    )
    expect(delivered?.message?.content).toContain(wrapper)
    expect(delivered?.message?.content).not.toContain("C:\\Users")
    await removeTemporary(directory)
  })
})

describe("telling a child from the root", () => {
  test.each(SPECIALIST_NAMES)("%s#<id> is that specialist", (name) => {
    expect(childAgent(`${name}#a1b2c3d4`)).toBe(name)
  })

  test.each(SCREEN_SPECIALIST_NAMES)("%s#<id> is that screen specialist", (name) => {
    expect(childAgent(`${name}#a1b2c3d4`)).toBe(name)
  })

  test("any other session is not a child: no name, no #, or a name that is not a specialist", () => {
    for (const name of [
      undefined,
      "",
      "holyagent",
      "worker-implementation",
      "my chat#1",
      "#a1b2c3d4",
      "worker-implementation-screen",
      "general-purpose-screen#a1b2c3d4",
      "worker-implementation-screen-screen#a1b2c3d4",
    ])
      expect(childAgent(name)).toBeUndefined()
  })

  test("a child gets the specialist's context, not the root's reminder, though the flag says root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-child-"))
    const text = async (sessionName?: string) =>
      (await run(healthy(directory), sessionName === undefined ? {} : { sessionName })).delivered
        ?.message?.content ?? ""
    const root = await text()
    const child = await text("reviewer-code#a1b2c3d4")
    expect(root.endsWith(PI_SESSION_REMINDER)).toBe(true)
    expect(child).toContain("Ship the thing")
    expect(child).not.toContain(PI_SESSION_REMINDER)
    await removeTemporary(directory)
  })

  test("a child fills the package folder into its prompt and leaves the root's process variables alone", async () => {
    const prompt = `run ${PI_ROOT_PLACEHOLDER}/scripts/holyagent status, then ${PI_ROOT_PLACEHOLDER}/scripts/holyagent rg x .`
    const { delivered, env } = await run(healthy("/missing"), {
      sessionName: "worker-implementation#a1b2c3d4",
      activeTools: ["SubagentWorkflow", "codemode"],
      systemPrompt: prompt,
      packageRoot: "C:\\Users\\me\\pkg",
      platformPath: win32,
    })
    expect(delivered?.systemPrompt).toBe(fillPackageRoot(prompt, "C:\\Users\\me\\pkg", win32))
    expect(delivered?.systemPrompt).toBe(
      "run bun --no-env-file --config='C:/Users/me/pkg/scripts/empty-bunfig.toml' 'C:/Users/me/pkg/scripts/holyagent.js' status, then bun --no-env-file --config='C:/Users/me/pkg/scripts/empty-bunfig.toml' 'C:/Users/me/pkg/scripts/holyagent.js' rg x .",
    )
    // The wrapper of a Windows root is not the one the fake answers for, so the config is
    // unreadable and the provider's variables are the defaults'; the host and the worker cap are
    // the root's alone.
    expect(env).toEqual(providerEnv(DEFAULTS))
  })

  test("a prompt without the placeholder is left as it is: no override is returned", async () => {
    const { api } = await run(healthy("/missing"), { sessionName: "reviewer-code#a1b2c3d4" })
    const results = await api.emit("before_agent_start", { systemPrompt: "plain" })
    expect(results).toEqual([undefined])
  })

  test("host-neutral CLI examples are wired to the installed package too", () => {
    expect(fillPackageRoot("Run \u0060holyagent status\u0060.", "C:\\pkg", win32)).toBe(
      "Run \u0060bun --no-env-file --config='C:/pkg/scripts/empty-bunfig.toml' 'C:/pkg/scripts/holyagent.js' status\u0060.",
    )
  })

  test.skipIf(process.platform === "win32")(
    "Unix prompt commands execute the installed wrapper with their arguments",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "holyagent-prompt-"))
      try {
        const root = join(directory, "My Apps' $(touch injected); package")
        const scripts = join(root, "scripts")
        await mkdir(scripts, { recursive: true })
        const wrapper = join(scripts, "holyagent")
        await Bun.write(wrapper, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
        await chmod(wrapper, 0o755)
        for (const prompt of [
          "`holyagent status --project 'my project'`",
          `${PI_ROOT_PLACEHOLDER}/scripts/holyagent status --project 'my project'`,
        ]) {
          const command = fillPackageRoot(prompt, root).replaceAll("`", "")
          const child = Bun.spawn(["sh", "-c", command], {
            cwd: directory,
            stdout: "pipe",
            stderr: "pipe",
          })
          expect(await child.exited).toBe(0)
          expect(await new Response(child.stdout).text()).toBe("status\n--project\nmy project\n")
        }
        expect(await Bun.file(join(directory, "injected")).exists()).toBe(false)
      } finally {
        await removeTemporary(directory)
      }
    },
  )

  test("Windows CLI prompts use isolated Bun rather than a non-executable shell wrapper", () => {
    const prompt = fillPackageRoot(
      PI_ROOT_PLACEHOLDER + "/scripts/holyagent --version",
      "C:\\Program Files\\holyagent",
      win32,
    )
    expect(prompt).toBe(
      "bun --no-env-file --config='C:/Program Files/holyagent/scripts/empty-bunfig.toml' 'C:/Program Files/holyagent/scripts/holyagent.js' --version",
    )
  })

  test("fillPackageRoot writes the folder with the platform separator turned to /", () => {
    expect(fillPackageRoot(`${PI_ROOT_PLACEHOLDER}/x`, "/opt/pkg")).toBe("/opt/pkg/x")
    expect(fillPackageRoot(`${PI_ROOT_PLACEHOLDER}/x`, "D:\\p q\\pkg", win32)).toBe("D:/p q/pkg/x")
  })
})

describe("the host and process variables", () => {
  const TOOLS = ["read", "bash", "SubagentWorkflow", "codemode"]
  const rootEnv = toolArgs(DEFAULTS, "root").env

  test("the names are the ones the holyagent CLI reads", () => {
    expect(HOST_ENV).toBe(HOST_VARIABLE)
    expect(WORKFLOWS_ENV).toBe(WORKFLOWS_VARIABLE)
  })

  test("hostEnvironment says workflows are on only with SubagentWorkflow and codemode both active", () => {
    expect(hostEnvironment(TOOLS)).toEqual({ HOLYAGENT_HOST: "pi", HOLYAGENT_WORKFLOWS: "1" })
    for (const tools of [["read", "codemode"], ["read", "SubagentWorkflow"], ["read"], []])
      expect(hostEnvironment(tools)).toEqual({ HOLYAGENT_HOST: "pi", HOLYAGENT_WORKFLOWS: "0" })
  })

  test("applyEnvironment replaces, or with keep leaves what is set", () => {
    const target: Record<string, string | undefined> = { A: "1", B: undefined }
    applyEnvironment(target, { A: "2", B: "2", C: "2" }, true)
    expect(target).toEqual({ A: "1", B: "2", C: "2" })
    applyEnvironment(target, { A: "3" }, false)
    expect(target.A).toBe("3")
  })

  test("before the root's run: host pi, workflows from the active tools, the worker cap and the long cache", async () => {
    const { env } = await run(healthy("/missing"), { activeTools: TOOLS })
    expect(env).toEqual({
      HOLYAGENT_HOST: "pi",
      HOLYAGENT_WORKFLOWS: "1",
      ...rootEnv,
      ...providerEnv(DEFAULTS),
      PI_CACHE_RETENTION: "long",
    })
    // The worker cap, and Billion Context's guardrails off while the bash tool runs on just-bash.
    expect(Object.keys(rootEnv)).toEqual([
      "PI_CODEMODE_MAX_WORKERS",
      "BILI_GUARDRAIL_BASH_TIMEOUT",
      "BILI_GUARDRAIL_MAX_OUTPUT_BYTES",
      "BILI_GUARDRAIL_REPETITION",
    ])
    expect(CACHE_RETENTION_ENV).toBe("PI_CACHE_RETENTION")
  })

  test("workflows are read again at each run, and the other variables are set once", async () => {
    const env: Record<string, string | undefined> = {}
    const active: Array<string> = ["read", "codemode"]
    const api = fakeApi(healthy("/missing"), undefined, SESSION_CWD, { activeTools: active })
    createExtension({ packageRoot: PACKAGE_ROOT, env, platform: "linux", bunSearch: BUN_SEARCH })(
      api.pi,
    )
    await api.emit("session_start", { reason: "startup" })
    await api.emit("before_agent_start", { prompt: "a" })
    expect(env["HOLYAGENT_WORKFLOWS"]).toBe("0")
    active.push("SubagentWorkflow")
    env["PI_CACHE_RETENTION"] = "short"
    await api.emit("before_agent_start", { prompt: "b" })
    expect(env["HOLYAGENT_WORKFLOWS"]).toBe("1")
    expect(env["PI_CACHE_RETENTION"]).toBe("short")
  })

  test("a value the user already set wins over the config's", async () => {
    const { env } = await run(healthy("/missing"), {
      env: { PI_CODEMODE_MAX_WORKERS: "9", PI_CACHE_RETENTION: "none" },
    })
    expect(env["PI_CODEMODE_MAX_WORKERS"]).toBe("9")
    expect(env["PI_CACHE_RETENTION"]).toBe("none")
  })

  test("with pi.enable off the config sets nothing, though the host is still pi", async () => {
    const { env } = await run(
      (call, runtime) =>
        runtime[0] === "config" ? { stdout: DISABLED } : healthy("/missing")(call, runtime),
      { activeTools: TOOLS },
    )
    expect(env).toEqual({ HOLYAGENT_HOST: "pi", HOLYAGENT_WORKFLOWS: "1" })
  })
})

describe("the Agent tool", () => {
  test.each(SPECIALIST_NAMES)("%s may launch", (name) => {
    expect(
      refuseNonSpecialist({ toolName: AGENT_TOOL, input: { subagent_type: name } }),
    ).toBeUndefined()
  })

  test.each(SCREEN_SPECIALIST_NAMES)(
    "%s may launch, for an Assignment with the screen capability",
    (name) => {
      expect(
        refuseNonSpecialist({ toolName: AGENT_TOOL, input: { subagent_type: name } }),
      ).toBeUndefined()
    },
  )

  test("a type outside the 18 and their -screen variants is refused, and the refusal names the screen form", () => {
    for (const type of ["worker-implementation-screen-screen", "screen", "explorer-map-screens"]) {
      const result = refuseNonSpecialist({ toolName: AGENT_TOOL, input: { subagent_type: type } })
      expect(result?.block, type).toBe(true)
      expect(result?.reason, type).toContain(
        "(each also as <name>-screen, or <name>-headless-screen on a headless machine)",
      )
    }
  })

  test("a type outside the 18 is refused with the names that are allowed", () => {
    for (const type of ["general-purpose", "Explore", "my-reviewer", "Worker-Implementation", ""]) {
      const result = refuseNonSpecialist({ toolName: AGENT_TOOL, input: { subagent_type: type } })
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain(SPECIALIST_NAMES.join(", "))
    }
    expect(refuseNonSpecialist({ toolName: AGENT_TOOL, input: {} })?.reason).toStartWith(
      "No agent type given",
    )
  })

  test("a resume names an existing agent, so its type is not checked", () => {
    expect(
      refuseNonSpecialist({
        toolName: AGENT_TOOL,
        input: { subagent_type: "general-purpose", resume: "agent-1" },
      }),
    ).toBeUndefined()
  })

  test("another tool is not looked at", () => {
    expect(
      refuseNonSpecialist({ toolName: "bash", input: { subagent_type: "general-purpose" } }),
    ).toBeUndefined()
  })

  test("the tool_call handler blocks, and leaves model and thinking as given", async () => {
    const api = fakeApi(healthy("/missing"))
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    const input = {
      subagent_type: "reviewer-code",
      model: "kimi-coding/kimi-k3.1",
      thinking: "high",
      prompt: "x",
    }
    const before = structuredClone(input)
    expect(await api.emit("tool_call", { toolName: AGENT_TOOL, input })).toEqual([undefined])
    expect(input).toEqual(before)
    const blocked = await api.emit("tool_call", {
      toolName: AGENT_TOOL,
      input: { ...input, subagent_type: "general-purpose" },
    })
    expect(blocked).toEqual([expect.objectContaining({ block: true })])
  })
})

const META = "export const meta = { name: 'w', description: 'd' }\n"
const workflowScript = (...agentTypes: ReadonlyArray<string | undefined>): string =>
  `${META}const out = await parallel([${agentTypes
    .map(
      (type, at) =>
        `() => agent('task ${at}', ${type === undefined ? "{ label: 'x' }" : `{ agentType: '${type}' }`})`,
    )
    .join(", ")}])\nreturn out`

const refusedWorkflow = (input: Record<string, unknown>) =>
  Effect.runPromise(refuseNonSpecialistWorkflow({ toolName: WORKFLOW_TOOL, input }))

describe("the SubagentWorkflow tool", () => {
  test("the workflow check knows the Claude specialists under the namespace it keeps for itself", () => {
    expect([...CLAUDE_SPECIALISTS]).toEqual(
      SPECIALIST_NAMES.map((name) => `${PLUGIN_NAMESPACE}:${name}`),
    )
  })

  test("a script whose every agent() names a specialist by literal agentType may run", async () => {
    expect(await refusedWorkflow({ script: workflowScript(...SPECIALIST_NAMES) })).toBeUndefined()
  })

  test("a script that names a screen specialist by literal agentType may run, and a made-up -screen name may not", async () => {
    expect(
      await refusedWorkflow({ script: workflowScript(...SCREEN_SPECIALIST_NAMES) }),
    ).toBeUndefined()
    const result = await refusedWorkflow({ script: workflowScript("explorer-map-screens") })
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain(
      "(each also as <name>-screen, or <name>-headless-screen on a headless machine)",
    )
  })

  test("a script that starts a default, a foreign or a computed agent is refused", async () => {
    const scripts = [
      workflowScript(undefined),
      workflowScript("worker-implementation", undefined),
      workflowScript("general-purpose"),
      workflowScript("holyagent:worker-implementation"),
      `${META}const type = 'worker-implementation'\nreturn await agent('x', { agentType: type })`,
    ]
    for (const script of scripts) {
      const result = await refusedWorkflow({ script })
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain(SPECIALIST_NAMES.join(", "))
    }
  })

  test("any input but script and args is refused, though the script alone would pass", async () => {
    const script = workflowScript("explorer-map")
    expect(await refusedWorkflow({ script, args: { entries: [] } })).toBeUndefined()
    for (const extra of [
      { name: "saved" },
      { scriptPath: "w.js" },
      { resume: "run-1" },
      { x: 1 },
    ]) {
      const result = await refusedWorkflow({ script, ...extra })
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain("inline `script`")
    }
  })

  test("a script that cannot be read is refused", async () => {
    expect((await refusedWorkflow({ script: "agent(" }))?.block).toBe(true)
  })

  // The package cuts the meta fragment from the source by pattern and evaluates it on the host
  // thread, then compiles the script as a classic script: the gate vets exactly those.
  test("the meta fragment the package would evaluate, and the program it would run, are vetted", async () => {
    const payload = '{ description: this.constructor.constructor("return process")() }'
    const body = "await agent('t', { agentType: 'explorer-map' })"
    for (const script of [
      `export const meta = /* ${payload} */ { name: "a", description: "d" }\n${body}`,
      `export const meta = // ${payload}\n{ name: "a", description: "d" }\n${body}`,
      `${META}let n = 0\nn <!--n; function workflow() { return 1 }\nawait workflow({ scriptPath: "x.js" })\n${body}`,
    ]) {
      const result = await refusedWorkflow({ script })
      expect(result?.block).toBe(true)
      expect(result?.reason).toContain("The workflow script is refused")
    }
  })

  test("text with `<!--` or `-->` in a string is not refused", async () => {
    const script = `${META}log(\`a --> b\`)\nawait agent('see <!-- and --> here', { agentType: 'explorer-map' })`
    expect(await refusedWorkflow({ script })).toBeUndefined()
  })

  test("a scriptPath, a saved name or no script is refused, as one cannot be vetted", async () => {
    for (const input of [
      { scriptPath: "w.js" },
      { script: workflowScript("explorer-map"), scriptPath: "w.js" },
      { name: "saved" },
      {},
      { script: "  " },
    ]) {
      expect((await refusedWorkflow(input))?.block).toBe(true)
    }
  })

  test("another tool is not looked at", async () => {
    expect(
      await Effect.runPromise(
        refuseNonSpecialistWorkflow({ toolName: "bash", input: { script: "agent(" } }),
      ),
    ).toBeUndefined()
  })

  test("the tool_call handler blocks without asking, and lets a specialist script through", async () => {
    const api = fakeApi(healthy("/missing"))
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    expect(
      await api.emit("tool_call", {
        toolName: WORKFLOW_TOOL,
        input: { script: workflowScript("reviewer-code") },
      }),
    ).toEqual([undefined])
    const [blocked] = await api.emit("tool_call", {
      toolName: WORKFLOW_TOOL,
      input: { script: workflowScript(undefined) },
    })
    expect(blocked).toMatchObject({ block: true })
    expect(typeof (blocked as { reason: unknown }).reason).toBe("string")
    expect(api.touched).toEqual([])
  })
})

describe("the gates and pi.enable", () => {
  const refusing = [
    { toolName: AGENT_TOOL, input: { subagent_type: "general-purpose" } },
    { toolName: WORKFLOW_TOOL, input: { script: workflowScript(undefined) } },
  ]

  test("with pi.enable off neither tool is refused", async () => {
    const { api } = await run(healthy("/missing", { config: { stdout: `${DISABLED}\n` } }))
    for (const event of refusing) expect(await api.emit("tool_call", event)).toEqual([undefined])
  })

  test("with pi.enable on both tools are refused", async () => {
    const { api } = await run(healthy("/missing"))
    for (const event of refusing)
      expect(await api.emit("tool_call", event)).toEqual([expect.objectContaining({ block: true })])
  })

  test("pi.enable off in the project's config alone leaves both gates on, and the context off", async () => {
    // The merged call names the project's state folder; the user's file is read alone, with none.
    const { api, delivered } = await run((call, runtime) =>
      runtime[0] === "config"
        ? { stdout: runtime.length > 1 ? DISABLED : CONFIG }
        : healthy("/missing")(call, runtime),
    )
    expect(delivered?.message).toBeUndefined()
    for (const event of refusing)
      expect(await api.emit("tool_call", event)).toEqual([expect.objectContaining({ block: true })])
  })

  test("pi.enable off in the user's config lifts the gates", async () => {
    const { api } = await run((call, runtime) =>
      runtime[0] === "config" ? { stdout: DISABLED } : healthy("/missing")(call, runtime),
    )
    for (const event of refusing) expect(await api.emit("tool_call", event)).toEqual([undefined])
  })

  test("a user config that cannot be read leaves the gates on under a project that says off", async () => {
    const { api } = await run((call, runtime) =>
      runtime[0] === "config"
        ? runtime.length > 1
          ? { stdout: DISABLED }
          : { code: 4, stderr: "error: ConfigInvalid: broken\n" }
        : healthy("/missing")(call, runtime),
    )
    for (const event of refusing)
      expect(await api.emit("tool_call", event)).toEqual([expect.objectContaining({ block: true })])
  })

  test("a config that cannot be read leaves both gates on", async () => {
    const { api } = await run(
      healthy("/missing", { config: { code: 4, stderr: "error: ConfigInvalid: broken\n" } }),
    )
    for (const event of refusing)
      expect(await api.emit("tool_call", event)).toEqual([expect.objectContaining({ block: true })])
  })

  test("a later collection that finds the extension on turns the gates back on", async () => {
    let enabled = false
    const { api } = await run((call, runtime) =>
      runtime[0] === "config"
        ? { stdout: enabled ? CONFIG : DISABLED }
        : healthy("/missing")(call, runtime),
    )
    expect(await api.emit("tool_call", refusing[0])).toEqual([undefined])
    enabled = true
    await api.emit("session_compact", {})
    expect(await api.emit("tool_call", refusing[0])).toEqual([
      expect.objectContaining({ block: true }),
    ])
  })
})

describe("a child that settles without a usable report", () => {
  const assistant = (
    stopReason: string,
    content: ReadonlyArray<object>,
  ): Parameters<typeof failedFinalMessage>[0] =>
    ({ role: "assistant", content, stopReason, model: "m", usage: {} }) as never

  const text = (value: string) => ({ type: "text", text: value })

  test("an empty final message fails, with the reason", () => {
    for (const content of [
      [],
      [text("")],
      [text("  \n")],
      [{ type: "thinking", thinking: "hm" }],
    ]) {
      expect(failedFinalMessage(assistant("stop", content))).toMatchObject({
        stopReason: "error",
        errorMessage: EMPTY_REPORT,
      })
    }
  })

  test("a length stop fails even with text, and keeps the text for the partial output", () => {
    const failed = failedFinalMessage(assistant("length", [text("result: half")]))
    expect(failed).toMatchObject({ stopReason: "error", errorMessage: CUT_OFF_REPORT })
    expect((failed as { content: unknown }).content).toEqual([text("result: half")])
  })

  test("a complete report, a tool call, an error and a user message are left alone", () => {
    expect(failedFinalMessage(assistant("stop", [text("result: done")]))).toBeUndefined()
    expect(
      failedFinalMessage(assistant("toolUse", [{ type: "toolCall", id: "1", name: "bash" }])),
    ).toBeUndefined()
    expect(
      failedFinalMessage(assistant("length", [{ type: "toolCall", id: "1", name: "bash" }])),
    ).toBeUndefined()
    expect(failedFinalMessage(assistant("error", []))).toBeUndefined()
    expect(failedFinalMessage(assistant("aborted", []))).toBeUndefined()
    expect(
      failedFinalMessage({ role: "user", content: "hi", timestamp: 1 } as never),
    ).toBeUndefined()
  })

  test("the reasons carry no word Pi retries a provider error on", () => {
    for (const reason of [EMPTY_REPORT, CUT_OFF_REPORT])
      expect(reason).not.toMatch(
        /overloaded|rate.?limit|timed? ?out|timeout|terminated|ended without|try .* again|retry|unavailable|5\d\d/i,
      )
  })

  test("message_end replaces the message of a child, and leaves the root's alone", async () => {
    const message = assistant("stop", [])
    const child = fakeApi(healthy("/missing"), undefined, SESSION_CWD, {
      name: "worker-debugging#a1b2c3d4",
    })
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(child.pi)
    const [replaced] = await child.emit("message_end", { message })
    expect((replaced as { message: object }).message).toMatchObject({
      stopReason: "error",
      errorMessage: EMPTY_REPORT,
    })
    const root = fakeApi(healthy("/missing"))
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(root.pi)
    expect(await root.emit("message_end", { message })).toEqual([undefined])
  })
})

/** A theme that marks nothing, so a drawn line reads as plain text. */
const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text }

/** The tool's own renderers, as the package registers them: drawing a call evaluates its script. */
const evaluatingRenderers = (evaluated: Array<string>): ToolRenderers => ({
  renderCall: (args) => {
    evaluated.push(String((args as { script?: unknown }).script))
    throw new Error("the package drew the call")
  },
  renderResult: () => ({ render: () => ["card"], invalidate: () => undefined }),
})

/** The lines the resolved renderers draw for a workflow call with `script`. */
const drawnCall = (script: unknown, evaluated: Array<string> = []): ReadonlyArray<string> => {
  const resolved = workflowRenderers(WORKFLOW_TOOL, () => evaluatingRenderers(evaluated))
  const component = resolved?.renderCall?.({ script }, PLAIN_THEME as never, {} as never)
  return component?.render(120) ?? []
}

describe("drawing a SubagentWorkflow call", () => {
  // The package draws a call by evaluating the meta fragment on the host, and Pi draws a call on
  // every streamed update, before the tool_call gate: nothing in the script may run.
  const EXPLOITS: ReadonlyArray<readonly [string, string]> = [
    [
      "a constructor chain to process",
      'export const meta = { description: this.constructor.constructor("return process")() }',
    ],
    [
      "a call that records itself",
      'export const meta = { name: (globalThis.__holyagentEvaluated = "call", "x") }',
    ],
    [
      "a getter that records itself",
      'export const meta = { get name() { globalThis.__holyagentEvaluated = "getter"; return "x" } }',
    ],
    [
      "an immediately invoked function that records itself",
      'export const meta = { name: (() => { globalThis.__holyagentEvaluated = "iife"; return "x" })() }',
    ],
  ]

  test.each(EXPLOITS)("%s is not evaluated and draws the default line", (_label, meta) => {
    const globals = globalThis as { __holyagentEvaluated?: string }
    delete globals.__holyagentEvaluated
    const evaluated: Array<string> = []
    const lines = drawnCall(
      `${meta}\nawait agent('p', { agentType: 'worker-implementation' })`,
      evaluated,
    )
    expect(globals.__holyagentEvaluated).toBeUndefined()
    expect(evaluated).toEqual([])
    expect(lines.join("\n")).toContain(`${WORKFLOW_TOOL}`)
    expect(lines.join("\n")).toContain("workflow")
  })

  test("a literal meta shows its name, and the package's own call drawing is never used", () => {
    const evaluated: Array<string> = []
    const lines = drawnCall(
      "export const meta = { name: 'release-check', description: 'd' }\nreturn 1",
      evaluated,
    )
    expect(lines.join("\n")).toContain("release-check")
    expect(evaluated).toEqual([])
  })

  test("a later name wins, and a name that is no string is not shown", () => {
    const line = (script: string) => workflowCallLine({ script }, PLAIN_THEME)
    expect(line("export const meta = { name: 'first', name: 'second' }")).toMatch(/second$/)
    expect(line("export const meta = { name: 'first', name: 2 }")).toMatch(/workflow$/)
  })

  test("control characters of a name are removed and a long name is cut", () => {
    const line = workflowCallLine(
      { script: `export const meta = { name: '\\x1b[2Jevil\\n${"x".repeat(200)}' }` },
      PLAIN_THEME,
    )
    expect(line).not.toContain("\u001b")
    expect(line).not.toContain("\n")
    expect(line.length).toBeLessThan(WORKFLOW_TOOL.length + 100)
  })

  test("bidi overrides and zero-width characters of a name are dropped", () => {
    const hidden = "\\u202e\\u2066\\u2069\\u200b\\u200f\\ufeff"
    const line = workflowCallLine(
      { script: `export const meta = { name: 'rel${hidden}ease${hidden}' }` },
      PLAIN_THEME,
    )
    expect(line).toMatch(/release$/)
    expect(line).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/)
    expect(sanitizeWorkflowName("\u200b\u202e\ufeff")).toBeUndefined()
  })

  test("format characters and variation selectors of a name are dropped, ordinary text stays", () => {
    expect(sanitizeWorkflowName("re\u2060le\u061cas\u180ee\u{e0041}\ufe0f \u00fc\u65e5")).toBe(
      "release \u00fc\u65e5",
    )
    expect(sanitizeWorkflowName("\u2060\u2064\u{e0000}\u{e007f}\ufe00")).toBeUndefined()
  })

  test("a name is cut at 80 characters without splitting a surrogate pair", () => {
    const emoji = "\u{1f600}"
    const cut = sanitizeWorkflowName(`${"x".repeat(79)}${emoji}${emoji}`)
    expect(cut).toBe(`${"x".repeat(79)}${emoji}`)
    expect(cut).not.toMatch(
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    )
    expect(sanitizeWorkflowName("y".repeat(200))).toBe("y".repeat(80))
  })

  test("the last argument's result is reused, and a new argument computes again", () => {
    const seen: Array<string> = []
    const cached = memoizeLast((key) => {
      seen.push(key)
      return key.length
    })
    expect([cached("aa"), cached("aa"), cached("aa")]).toEqual([2, 2, 2])
    expect(cached("b")).toBe(1)
    expect(cached("aa")).toBe(2)
    expect(seen).toEqual(["aa", "b", "aa"])
  })

  test("a call without a string script draws the default line", () => {
    for (const script of [undefined, 3, "", "no meta here"])
      expect(drawnCall(script).join("\n")).toMatch(/workflow\s*$/)
    expect(workflowCallLine(undefined, PLAIN_THEME)).toMatch(/workflow$/)
  })

  test("the result card and every other tool keep what Pi would use", () => {
    const base = evaluatingRenderers([])
    const resolved = workflowRenderers(WORKFLOW_TOOL, () => base)
    expect(resolved?.renderResult).toBe(base.renderResult)
    expect(workflowRenderers("bash", () => base)).toBe(base)
    expect(workflowRenderers("bash", () => undefined)).toBeUndefined()
    expect(workflowRenderers(WORKFLOW_TOOL, () => undefined)).toBeUndefined()
  })

  test("the extension registers the resolver in every session, a child's and a disabled one's too", () => {
    for (const session of [{}, { name: "worker-debugging#a1b2c3d4" }]) {
      const api = fakeApi(healthy("/missing"), undefined, SESSION_CWD, session)
      createExtension({
        packageRoot: PACKAGE_ROOT,
        env: {},
        platform: "linux",
        bunSearch: BUN_SEARCH,
      })(api.pi)
      expect(api.renderers).toEqual([workflowRenderers])
    }
  })
})

/** Waits until the provider probes ended: `count` of them ran and none is left running. */
const probesEnded = async (api: ReturnType<typeof fakeApi>, count: number) => {
  const probes = () => api.calls.filter((call) => probeArgs(call) !== undefined).length
  for (let tries = 0; tries < 400 && (probes() < count || api.running.count > 0); tries++)
    await Bun.sleep(5)
  expect(probes()).toBe(count)
  // The probe's result is stored a few microtasks after its last command ends.
  await Bun.sleep(20)
}

/** The messages the handlers of one more run return, without the system prompt. */
const nextMessages = async (
  api: ReturnType<typeof fakeApi>,
): Promise<Array<Delivered["message"]>> =>
  (
    (await api.emit("before_agent_start", { prompt: "next", systemPrompt: "p" })) as Array<
      Delivered | undefined
    >
  ).flatMap((result) => (result?.message === undefined ? [] : [result.message]))

/**
 * The characters of a text that are unsafe to draw or to hand to the model: the C0 and C1 controls
 * (ESC and CSI among them), the line and paragraph separators, bidi overrides and zero-width
 * characters, as UTF-16 code units (all of them are in the basic plane).
 */
const unsafeCharacters = (text: string): ReadonlyArray<number> =>
  Array.from(text, (_, at) => text.charCodeAt(at)).filter(
    (code) =>
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e),
  )

const piCalls = (api: ReturnType<typeof fakeApi>) =>
  api.calls.flatMap((call) => probeArgs(call)?.join(" ") ?? [])

describe("the root's system prompt", () => {
  const PI_PROMPT = "Pi's own prompt, with AGENTS.md and the skills"
  const filledPrompt = fillPackageRoot(PI_ROOT_PROMPT, PACKAGE_ROOT)

  test("is the Kimi root prompt with the package folder filled, in front of Pi's own", async () => {
    const { delivered } = await run(healthy("/missing"), { systemPrompt: PI_PROMPT })
    expect(delivered?.systemPrompt).toBe(`${filledPrompt}\n\n${PI_PROMPT}`)
    expect(delivered?.systemPrompt).not.toContain(PI_ROOT_PLACEHOLDER)
    expect(delivered?.systemPrompt).toContain(`${toPosix(PACKAGE_ROOT)}/scripts/holyagent`)
  })

  test("is returned on every run, since Pi starts each run from its own prompt", async () => {
    const { api } = await run(healthy("/missing"))
    const again = (await api.emit("before_agent_start", {
      prompt: "again",
      systemPrompt: PI_PROMPT,
    })) as Array<Delivered | undefined>
    expect(again[0]?.systemPrompt).toBe(`${filledPrompt}\n\n${PI_PROMPT}`)
  })

  test("keeps the status message beside it", async () => {
    const { delivered } = await run(healthy("/missing"))
    expect(delivered?.message?.customType).toBeUndefined()
    const withState = await mkdtemp(join(tmpdir(), "holyagent-pi-prompt-"))
    const { delivered: both } = await run(healthy(withState))
    expect(both?.message?.customType).toBe(CONTEXT_MESSAGE)
    expect(both?.systemPrompt).toContain(filledPrompt)
    await removeTemporary(withState)
  })

  test("stays when the status fails after the config is read, with the notice beside it", async () => {
    const { delivered } = await run(
      healthy("/missing", { status: { code: 3, stderr: "error: boom\n" } }),
    )
    expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
    expect(delivered?.systemPrompt).toContain(filledPrompt)
  })

  test("is not given to a specialist or a plain session, nor to a child", async () => {
    for (const flag of ["specialist", "session"])
      expect((await run(healthy("/missing"), { flag })).delivered?.systemPrompt).toBeUndefined()
    const child = await run(healthy("/missing"), {
      sessionName: "reviewer-code#a1b2c3d4",
      systemPrompt: PI_PROMPT,
    })
    expect(child.delivered?.systemPrompt).toBeUndefined()
  })

  test("is given when the config cannot be read or the role is unknown, beside the notice", async () => {
    const broken: ReadonlyArray<readonly [string, Responder, { flag?: string }]> = [
      [
        "a config the loader refuses",
        (call, runtime) =>
          runtime[0] === "config"
            ? { code: 4, stderr: "error: bad\n" }
            : healthy("/missing")(call, runtime),
        {},
      ],
      [
        "a config with an unknown key",
        (call, runtime) =>
          runtime[0] === "config"
            ? { stdout: `${JSON.stringify({ pi: {}, extra: 1 })}\n` }
            : healthy("/missing")(call, runtime),
        {},
      ],
      [
        "a git that fails",
        (call, runtime) =>
          call.command === "git" ? { code: 1 } : healthy("/missing")(call, runtime),
        {},
      ],
      ["an unknown role", healthy("/missing"), { flag: "nonsense" }],
    ]
    for (const [label, responder, options] of broken) {
      const { delivered } = await run(responder, { systemPrompt: PI_PROMPT, ...options })
      expect(delivered?.message?.customType, label).toBe(NOTICE_MESSAGE)
      expect(delivered?.systemPrompt, label).toBe(`${filledPrompt}\n\n${PI_PROMPT}`)
    }
  })

  test("is not given to a specialist or a plain session whose config cannot be read", async () => {
    for (const options of [
      { flag: "specialist" },
      { flag: "session" },
      { sessionName: "reviewer-code#a1b2c3d4" },
    ]) {
      const { delivered } = await run(
        healthy("/missing", { config: { code: 4, stderr: "error: bad\n" } }),
        options,
      )
      expect(delivered?.systemPrompt).toBeUndefined()
    }
  })

  test("is not given with pi.enable off, in the user's config or the project's", async () => {
    const off: Responder = (call, runtime) =>
      runtime[0] === "config" ? { stdout: DISABLED } : healthy("/missing")(call, runtime)
    const { delivered, api } = await run(off, { activeTools: ["read", "write"] })
    expect(delivered).toBeUndefined()
    expect(api.toolSets).toEqual([])
    expect(piCalls(api)).toEqual([])
    const userOff: Responder = (call, runtime) =>
      runtime[0] === "config" && call.args.length === 3 ? { stdout: DISABLED } : off(call, runtime)
    expect((await run(userOff)).delivered).toBeUndefined()
  })
})

describe("the root's tools", () => {
  test("activates registered FFF search tools and leaves them callable through codemode", async () => {
    const search = ["grep", "find", "multi_grep"]
    const { api } = await run(healthy("/missing"), {
      activeTools: ["read", "bash"],
      allTools: ["read", "bash", "codemode", ...search],
    })
    expect(api.pi.getActiveTools()).toEqual(["read", "bash", "codemode", ...search])
    for (const name of search)
      expect(
        await api.emit("tool_call", {
          toolName: name,
          toolCallId: "search",
          input: {},
          parentToolCallId: "code",
        }),
      ).toEqual([undefined])
  })

  const ACTIVE = ["read", "bash", "write", "edit", "todo", "moonshot_search", "computer_use_click"]

  test("are its active selection plus codemode, minus the tools it excludes", async () => {
    const { api } = await run(healthy("/missing"), {
      activeTools: [...ACTIVE],
      allTools: [...ACTIVE, "codemode", "moonshot_fetch"],
    })
    expect(api.toolSets).toEqual([["read", "bash", "todo", "codemode"]])
  })

  test("are set before the first run reads them, once per start", async () => {
    const { api } = await run(healthy("/missing"), { activeTools: [...ACTIVE] })
    expect(api.toolSets).toHaveLength(1)
    await api.emit("session_compact", { reason: "manual" })
    await api.emit("before_agent_start", { prompt: "x", systemPrompt: "p" })
    expect(api.toolSets).toHaveLength(1)
  })

  test("a compaction leaves a change the user made to the tools", async () => {
    const { api } = await run(healthy("/missing"), { activeTools: [...ACTIVE] })
    api.pi.setActiveTools(["read", "write"])
    await api.emit("session_compact", { reason: "manual" })
    await api.emit("before_agent_start", { prompt: "x", systemPrompt: "p" })
    expect(api.pi.getActiveTools()).toEqual(["read", "write"])
  })

  test("a child, a specialist and a plain session keep the tools they have", async () => {
    for (const options of [
      { sessionName: "worker-implementation#a1b2c3d4" },
      { flag: "specialist" },
      { flag: "session" },
    ]) {
      const { api } = await run(healthy("/missing"), { activeTools: [...ACTIVE], ...options })
      expect(api.toolSets).toEqual([])
      expect(api.pi.getActiveTools()).toEqual(ACTIVE)
    }
  })

  test("are left alone with pi.enable off", async () => {
    const { api } = await run(
      (call, runtime) =>
        runtime[0] === "config" ? { stdout: DISABLED } : healthy("/missing")(call, runtime),
      { activeTools: [...ACTIVE] },
    )
    expect(api.toolSets).toEqual([])
    expect(api.pi.getActiveTools()).toEqual(ACTIVE)
  })

  test("a setActiveTools that throws is a notice, not an error that reaches Pi", async () => {
    const { api } = await run(healthy("/missing"), {
      activeTools: [...ACTIVE],
      toolsFail: new Error("no such loadout"),
      startOnly: true,
    })
    const [notice] = await nextMessages(api)
    expect(notice?.customType).toBe(NOTICE_MESSAGE)
    expect(notice?.content).toContain("the root's tools were not applied")
    expect(notice?.content).toContain("no such loadout")
  })

  test("a setActiveTools that throws is reported beside the status, which it does not replace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "holyagent-pi-tools-"))
    const { api, delivered } = await run(healthy(directory), {
      activeTools: [...ACTIVE],
      toolsFail: new Error("no such loadout"),
      startOnly: true,
    })
    expect(delivered).toBeUndefined()
    const messages = await nextMessages(api)
    expect(messages.map((message) => message?.customType)).toEqual([
      CONTEXT_MESSAGE,
      NOTICE_MESSAGE,
    ])
    expect(messages[1]?.content).toContain("no such loadout")
    expect(await nextMessages(api)).toEqual([])
    await removeTemporary(directory)
  })

  test("are the defaults' when the config cannot be read: the root keeps its exclusions", async () => {
    const { api, delivered } = await run(
      healthy("/missing", { config: { code: 4, stderr: "error: bad\n" } }),
      { activeTools: [...ACTIVE], allTools: [...ACTIVE, "codemode", "moonshot_fetch"] },
    )
    expect(delivered?.message?.customType).toBe(NOTICE_MESSAGE)
    expect(api.toolSets).toEqual([["read", "bash", "todo", "codemode"]])
  })

  test("a compaction that stops the start's collection does the start's work, once", async () => {
    const hold = gate()
    const inner = healthy("/missing")
    let first = true
    const api = fakeApi(
      (call, runtime) => {
        if (runtime[0] !== "status" || !first) return inner(call, runtime)
        first = false
        return gated(hold, { stdout: STATUS }, call.signal)
      },
      undefined,
      SESSION_CWD,
      { activeTools: [...ACTIVE] },
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    await api.emit("session_compact", { reason: "threshold" })
    await started
    await probesEnded(api, 2)
    expect(api.toolSets).toEqual([["read", "bash", "todo", "codemode"]])
    expect(piCalls(api)).toEqual(["auth check --provider kimi-coding --json", "--list-models"])
    await api.emit("session_compact", { reason: "threshold" })
    await Bun.sleep(20)
    expect(api.toolSets).toHaveLength(1)
    expect(piCalls(api)).toHaveLength(2)
  })
})

describe("the root's excluded tools", () => {
  const call = (toolName: string, extra: object = {}) => ({
    toolName,
    toolCallId: "call-1/1",
    input: {},
    ...extra,
  })
  const blocked = [expect.objectContaining({ block: true })]
  // The tools Pi lets a codemode script call whether or not they are active: the computer-use
  // tools beyond the core set and pi-web-kit's, registered `deferred`.
  const DEFERRED = [
    "computer_use_scroll",
    "computer_use_get_screen_size",
    "web_search",
    "web_fetch",
  ]
  // fff's tools under both name sets: override mode's, and the default mode's, which the package also
  // registers under `--fff-mode`, `PI_FFF_MODE` and a working directory it does not index.
  const FFF = ["grep", "find", "multi_grep", "ffgrep", "fffind", "fff-multi-grep"]
  const EXCLUDED = ["write", "edit", "computer_use_click", "moonshot_search", "moonshot_fetch"]
  const webKit = JSON.stringify({
    ...DEFAULTS,
    pi: { ...DEFAULTS.pi, features: { ...DEFAULTS.pi.features, web: "pi-web-kit" } },
  })

  test("a call to one is refused for the root, from the model and from a codemode script", async () => {
    const { api } = await run(healthy("/missing"))
    for (const name of EXCLUDED) {
      expect(await api.emit("tool_call", call(name))).toEqual(blocked)
      // A script's call carries the id of the codemode call that made it.
      expect(await api.emit("tool_call", call(name, { parentToolCallId: "call-1" }))).toEqual(
        blocked,
      )
    }
    for (const name of ["read", "bash", "codemode", "todo", ...FFF])
      expect(await api.emit("tool_call", call(name))).toEqual([undefined])
  })

  test("the reason says which tool and what to do instead", async () => {
    const { api } = await run(healthy("/missing"))
    const [refusal] = (await api.emit("tool_call", call("computer_use_scroll"))) as Array<
      { reason: string } | undefined
    >
    expect(refusal?.reason).toContain("computer_use_scroll")
    expect(refusal?.reason).toContain("specialist")
  })

  test("the deferred tools stay refused though no longer active, and pi-web-kit's follow the config", async () => {
    const { api } = await run(
      (call, runtime) =>
        runtime[0] === "config" ? { stdout: webKit } : healthy("/missing")(call, runtime),
      { activeTools: ["read", ...DEFERRED] },
    )
    expect(api.pi.getActiveTools()).not.toContain("web_search")
    for (const name of DEFERRED)
      expect(await api.emit("tool_call", call(name, { parentToolCallId: "call-1" }))).toEqual(
        blocked,
      )
    // The defaults' exclusions stay whatever the config chooses, so the provider's tools too.
    expect(await api.emit("tool_call", call("moonshot_search"))).toEqual(blocked)
  })

  /** Answers the project's merged `config` call with `merged` and the user's alone with `user`. */
  const configs =
    (merged: string, user: string = CONFIG): Responder =>
    (callOf, runtime) =>
      runtime[0] === "config"
        ? { stdout: runtime.length > 1 ? merged : user }
        : healthy("/missing")(callOf, runtime)
  const project = (pi: object) => JSON.stringify({ ...DEFAULTS, pi: { ...DEFAULTS.pi, ...pi } })
  const featuresOf = (features: object) =>
    project({ features: { ...DEFAULTS.pi.features, ...features } })

  test("a project's pi.enable false keeps the exclusions, the gate and the root prompt", async () => {
    const { api, delivered } = await run(configs(project({ enable: false })))
    expect(delivered?.message).toBeUndefined()
    expect(delivered?.systemPrompt).toContain(`${toPosix(PACKAGE_ROOT)}/scripts/holyagent`)
    for (const name of EXCLUDED)
      expect(await api.emit("tool_call", call(name, { parentToolCallId: "call-1" }))).toEqual(
        blocked,
      )
    expect(await api.emit("tool_call", call("read"))).toEqual([undefined])
  })

  test("a project's pi.enable false still lifts them for another role", async () => {
    const { api, delivered } = await run(configs(project({ enable: false })), { flag: "session" })
    expect(delivered).toBeUndefined()
    for (const name of EXCLUDED)
      expect(await api.emit("tool_call", call(name))).toEqual([undefined])
  })

  test("a project can add an exclusion but not take one away", async () => {
    // computerUse off and the pi-web-kit mode each drop patterns from the merged config's own list.
    const { api } = await run(
      configs(featuresOf({ computerUse: false, web: "pi-web-kit" }), CONFIG),
      { activeTools: ["read", "computer_use_click", "moonshot_search", "web_search"] },
    )
    for (const name of [...EXCLUDED, "web_search", "web_fetch"])
      expect(await api.emit("tool_call", call(name))).toEqual(blocked)
    // And the active tools lose them too.
    expect(api.pi.getActiveTools()).not.toContain("computer_use_click")
    expect(api.pi.getActiveTools()).not.toContain("moonshot_search")
  })

  test("the user's own exclusions stay whatever the project says", async () => {
    const { api } = await run(configs(CONFIG, webKit))
    for (const name of [...EXCLUDED, "web_search", "web_fetch"])
      expect(await api.emit("tool_call", call(name))).toEqual(blocked)
  })

  test("the user's own exclusions stay when the project's config cannot be read", async () => {
    // The merged call fails (a malformed or unknown-key project file) while the user's file reads.
    const { api } = await run(
      (callOf, runtime) =>
        runtime[0] === "config" && runtime.length > 1
          ? { code: 4, stderr: "error: ConfigInvalid: project\n" }
          : configs(CONFIG, webKit)(callOf, runtime),
      { activeTools: ["read", ...DEFERRED] },
    )
    for (const name of [...EXCLUDED, "web_search", "web_fetch"])
      expect(await api.emit("tool_call", call(name, { parentToolCallId: "call-1" }))).toEqual(
        blocked,
      )
    expect(api.pi.getActiveTools()).not.toContain("web_search")
  })

  test("the user's own exclusions stay when git fails, as a project's malformed .git makes it", async () => {
    const { api } = await run(
      (callOf, runtime) =>
        callOf.command === "git"
          ? { code: 128, stderr: "fatal: invalid gitfile format\n" }
          : configs(CONFIG, webKit)(callOf, runtime),
      { activeTools: ["read", ...DEFERRED] },
    )
    for (const name of [...EXCLUDED, "web_search", "web_fetch"])
      expect(await api.emit("tool_call", call(name))).toEqual(blocked)
    expect(api.pi.getActiveTools()).not.toContain("web_search")
  })

  test("a compaction whose reads fail keeps the exclusions an earlier collection took from the user", async () => {
    let failing = false
    const { api } = await run(
      (callOf, runtime) =>
        failing && (callOf.command === "git" || runtime[0] === "config")
          ? { code: 4, stderr: "error: unreadable\n" }
          : configs(CONFIG, webKit)(callOf, runtime),
      { startOnly: true },
    )
    failing = true
    await api.emit("session_compact", {})
    for (const name of [...EXCLUDED, "web_search", "web_fetch"])
      expect(await api.emit("tool_call", call(name))).toEqual(blocked)
  })

  test("a deadline during the user's read reports the home-level config and keeps the defaults", async () => {
    const hold = gate()
    const { api } = await run(
      (callOf, runtime) =>
        runtime[0] === "config" && runtime.length === 1
          ? gated(hold, { stdout: webKit }, callOf.signal)
          : healthy("/missing")(callOf, runtime),
      { startOnly: true, deadlineMs: 100 },
    )
    for (const name of EXCLUDED) expect(await api.emit("tool_call", call(name))).toEqual(blocked)
    const messages = await nextMessages(api)
    expect(
      messages.some(
        (message) =>
          message?.customType === NOTICE_MESSAGE &&
          String(message.content).includes("home-level config could not be read"),
      ),
    ).toBe(true)
  })

  test("a user config that cannot be read is reported, and the defaults' exclusions stay", async () => {
    const { api } = await run(
      (callOf, runtime) =>
        runtime[0] === "config" && runtime.length === 1
          ? { code: 4, stderr: "error: ConfigInvalid: home\n" }
          : healthy("/missing")(callOf, runtime),
      { startOnly: true },
    )
    for (const name of EXCLUDED) expect(await api.emit("tool_call", call(name))).toEqual(blocked)
    const messages = await nextMessages(api)
    const home = messages.find((message) => message?.customType === NOTICE_MESSAGE)
    expect(home?.content).toContain("home-level config could not be read")
    expect(await nextMessages(api)).toEqual([])
  })

  test("a session starts with the defaults' exclusions, until the config is read", async () => {
    for (const reason of ["startup", "reload"]) {
      const hold = gate()
      const api = fakeApi((callOf, runtime) =>
        runtime[0] === "config"
          ? gated(hold, { stdout: `${CONFIG}\n` }, callOf.signal)
          : healthy("/missing")(callOf, runtime),
      )
      createExtension({
        packageRoot: PACKAGE_ROOT,
        env: {},
        platform: "linux",
        bunSearch: BUN_SEARCH,
      })(api.pi)
      const started = api.emit("session_start", { reason })
      await hold.entered
      for (const name of EXCLUDED) expect(await api.emit("tool_call", call(name))).toEqual(blocked)
      hold.open()
      await started
      for (const name of EXCLUDED) expect(await api.emit("tool_call", call(name))).toEqual(blocked)
    }
  })

  test("a worker starts without root exclusions but cannot call web tools without Search", async () => {
    const hold = gate()
    const api = fakeApi(
      (callOf, runtime) =>
        runtime[0] === "config"
          ? gated(hold, { stdout: `${CONFIG}\n` }, callOf.signal)
          : healthy("/missing")(callOf, runtime),
      undefined,
      SESSION_CWD,
      { name: "worker-implementation#a1b2c3d4" },
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    for (const name of EXCLUDED)
      expect(await api.emit("tool_call", call(name))).toEqual(
        name.startsWith("moonshot_") ? blocked : [undefined],
      )
    hold.open()
    await started
  })

  test("a config that cannot be read leaves the defaults' exclusions", async () => {
    const { api } = await run(healthy("/missing", { config: { code: 4, stderr: "error: bad\n" } }))
    for (const name of EXCLUDED)
      expect(await api.emit("tool_call", call(name, { parentToolCallId: "call-1" }))).toEqual(
        blocked,
      )
  })

  test("a failing git or status leaves them too", async () => {
    for (const responder of [
      (callOf: Call, runtime: ReadonlyArray<string>) =>
        callOf.command === "git"
          ? { code: 128, stderr: "fatal: unsafe\n" }
          : healthy("/missing")(callOf, runtime),
      healthy("/missing", { status: { code: 3, stderr: "error: boom\n" } }),
    ]) {
      const { api } = await run(responder)
      for (const name of EXCLUDED) expect(await api.emit("tool_call", call(name))).toEqual(blocked)
    }
  })

  test("other sessions and a pi.enable that is off are not held to root exclusions", async () => {
    for (const options of [{ flag: "specialist" }, { flag: "session" }]) {
      const { api } = await run(healthy("/missing"), options)
      for (const name of EXCLUDED)
        expect(await api.emit("tool_call", call(name))).toEqual([undefined])
    }
    const worker = await run(healthy("/missing"), { sessionName: "worker-implementation#a1b2c3d4" })
    for (const name of EXCLUDED)
      expect(await worker.api.emit("tool_call", call(name))).toEqual(
        name.startsWith("moonshot_") ? blocked : [undefined],
      )
    const librarian = await run(healthy("/missing"), {
      sessionName: "librarian-lookup#a1b2c3d4",
      activeTools: ["moonshot_search", "moonshot_fetch"],
    })
    for (const name of ["moonshot_search", "moonshot_fetch"])
      expect(await librarian.api.emit("tool_call", call(name))).toEqual([undefined])
    const unavailable = await run(healthy("/missing"), {
      sessionName: "librarian-lookup#a1b2c3d4",
      activeTools: [],
      startOnly: true,
    })
    const notices = await nextMessages(unavailable.api)
    expect(
      notices.some((message) => String(message?.content).includes("Kimi search is not exposed")),
    ).toBe(true)
    for (const config of [DISABLED]) {
      const { api } = await run(healthy("/missing", { config: { stdout: config } }))
      for (const name of EXCLUDED)
        expect(await api.emit("tool_call", call(name))).toEqual([undefined])
    }
  })

  test("a later collection that finds the extension off lifts them, and one that finds it on sets them", async () => {
    let enabled = true
    const { api } = await run((callOf, runtime) =>
      runtime[0] === "config"
        ? { stdout: enabled ? CONFIG : DISABLED }
        : healthy("/missing")(callOf, runtime),
    )
    expect(await api.emit("tool_call", call("write"))).toEqual(blocked)
    enabled = false
    await api.emit("session_compact", {})
    expect(await api.emit("tool_call", call("write"))).toEqual([undefined])
    enabled = true
    await api.emit("session_compact", {})
    expect(await api.emit("tool_call", call("write"))).toEqual(blocked)
  })

  test("refuseExcludedTool matches names and patterns, and an empty list refuses nothing", () => {
    expect(refuseExcludedTool({ toolName: "computer_use_x" }, ["computer_use_*"])?.block).toBe(true)
    expect(refuseExcludedTool({ toolName: "computer_use" }, ["computer_use_*"])).toBeUndefined()
    expect(refuseExcludedTool({ toolName: "write" }, [])).toBeUndefined()
  })
})

describe("the provider", () => {
  const LOGIN_FIX = "Run /login kimi-coding in Pi, or set KIMI_API_KEY"
  const withoutModels: PiProbe = (args) =>
    args[0] === "auth"
      ? { code: 0 }
      : { code: 0, stdout: "provider     model   context\nkimi-coding  other-model  256K\n" }

  test("its variables are set for the root and for a child, and the user's own stay", async () => {
    const root = await run(healthy("/missing"))
    expect(root.env["KIMI_CODE_REGION"]).toBe("global")
    const child = await run(healthy("/missing"), { sessionName: "reviewer-code#a1b2c3d4" })
    expect(child.env).toEqual(providerEnv(DEFAULTS))
    const own = await run(healthy("/missing"), { env: { KIMI_CODE_REGION: "cn" } })
    expect(own.env["KIMI_CODE_REGION"]).toBe("cn")
  })

  test("its variables are set before the first probe starts, and the user's own win there too", async () => {
    for (const [own, expected] of [
      [{}, "global"],
      [{ KIMI_CODE_REGION: "cn" }, "cn"],
    ] as const) {
      const env: Record<string, string | undefined> = { ...own }
      const seen: Array<string | undefined> = []
      const { api } = await run(healthy("/missing"), {
        env,
        startOnly: true,
        pi: (args) => {
          seen.push(env["KIMI_CODE_REGION"])
          return readyPi(args)
        },
      })
      await probesEnded(api, 2)
      expect(seen).toEqual([expected, expected])
    }
  })

  test("its variables are the defaults' when the config cannot be read, and no probe runs", async () => {
    const { api, env } = await run(
      healthy("/missing", { config: { code: 4, stderr: "error: bad\n" } }),
      { startOnly: true },
    )
    await Bun.sleep(20)
    expect(env["KIMI_CODE_REGION"]).toBe("global")
    expect(piCalls(api)).toEqual([])
  })

  test("with pi.enable off none of its variables are set", async () => {
    const { env } = await run((call, runtime) =>
      runtime[0] === "config" ? { stdout: DISABLED } : healthy("/missing")(call, runtime),
    )
    expect(env["KIMI_CODE_REGION"]).toBeUndefined()
  })

  test("a ready provider that lists the route models adds no notice; both probes ran", async () => {
    const { api } = await run(healthy("/missing"), { startOnly: true })
    await probesEnded(api, 2)
    expect(piCalls(api)).toEqual(["auth check --provider kimi-coding --json", "--list-models"])
    expect(await nextMessages(api)).toEqual([])
  })

  test("a provider that is not ready is a notice with the fix, and the models are not listed", async () => {
    const { api } = await run(healthy("/missing"), { pi: () => ({ code: 1 }), startOnly: true })
    await probesEnded(api, 1)
    const [notice] = await nextMessages(api)
    expect(notice?.customType).toBe(NOTICE_MESSAGE)
    expect(notice?.display).toBe(true)
    expect(notice?.content).toContain("kimi-coding is not ready")
    expect(notice?.content).toContain(LOGIN_FIX)
    expect(piCalls(api)).toHaveLength(1)
  })

  test("what Pi printed reaches the notice without its control characters", async () => {
    const { api } = await run(healthy("/missing"), {
      pi: () => ({
        code: 2,
        stderr: "error: \u001b[2J\u001b]8;;http://x\u0007broken\u009b31m auth.json\n",
      }),
      startOnly: true,
    })
    await probesEnded(api, 1)
    const content = (await nextMessages(api))[0]?.content ?? ""
    expect(content).toContain("broken")
    expect(content).toContain("auth.json")
    expect(unsafeCharacters(content)).toEqual([])
  })

  test("a provider Pi finds invalid is a notice with what Pi printed", async () => {
    const { api } = await run(healthy("/missing"), {
      pi: () => ({ code: 2, stderr: "error: broken auth.json\n" }),
      startOnly: true,
    })
    await probesEnded(api, 1)
    expect((await nextMessages(api))[0]?.content).toContain("broken auth.json")
  })

  test("a route model the catalog lacks is a notice naming the model and the fix", async () => {
    const { api } = await run(healthy("/missing"), { pi: withoutModels, startOnly: true })
    await probesEnded(api, 2)
    const [notice] = await nextMessages(api)
    expect(notice?.customType).toBe(NOTICE_MESSAGE)
    expect(notice?.content).toContain("does not list")
    expect(notice?.content).toContain(DEFAULTS.pi.routes.root.model)
    expect(notice?.content).toContain("pi.routes")
  })

  test("the notice is delivered once, beside the status message and not in its place", async () => {
    const { directory, done } = { directory: "/missing", done: async () => {} }
    const api = fakeApi(healthy(directory), undefined, SESSION_CWD, { pi: () => ({ code: 1 }) })
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    await api.emit("session_start", { reason: "startup" })
    await probesEnded(api, 1)
    const messages = (
      (await api.emit("before_agent_start", { prompt: "x", systemPrompt: "p" })) as Array<
        Delivered | undefined
      >
    ).flatMap((result) => (result?.message === undefined ? [] : [result.message.customType]))
    expect(messages).toEqual([NOTICE_MESSAGE])
    expect(await nextMessages(api)).toEqual([])
    await done()
  })

  test("startup does not wait for the probes, and the notice comes on the run after they end", async () => {
    const hold = gate()
    const { api, delivered } = await run(healthy("/missing"), {
      pi: (_args, signal) => gated(hold, { code: 1 }, signal),
    })
    await hold.entered
    expect(delivered?.message?.customType).toBeUndefined()
    expect(await nextMessages(api)).toEqual([])
    hold.open()
    await probesEnded(api, 1)
    expect((await nextMessages(api))[0]?.content).toContain("not ready")
  })

  test("a probe that cannot start, is stopped or times out says nothing about the provider", async () => {
    for (const pi of [
      (): Outcome => ({ killed: true, code: 143 }),
      (): Outcome => {
        throw new Error("spawn pi ENOENT")
      },
      // Pi's exec maps a program that is not found to exit 1 with the spawn error on stderr, which
      // `pi auth check` itself uses for "not logged in".
      (): Outcome => ({ code: 1, stderr: "spawn pi ENOENT" }),
      (): Outcome => ({ code: 1, stderr: "spawn pi EACCES\n" }),
    ]) {
      const { api } = await run(healthy("/missing"), { pi, startOnly: true })
      await probesEnded(api, 1)
      expect(await nextMessages(api)).toEqual([])
    }
  })

  test("a catalog that cannot be listed or read says nothing either", async () => {
    for (const listing of [{ code: 1, stderr: "error: nope\n" }, { stdout: "something else\n" }]) {
      const { api } = await run(healthy("/missing"), {
        pi: (args) => (args[0] === "auth" ? { code: 0 } : listing),
        startOnly: true,
      })
      await probesEnded(api, 2)
      expect(await nextMessages(api)).toEqual([])
    }
  })

  test("a probe that did start and exits 1 with other output is still not logged in", async () => {
    const { api } = await run(healthy("/missing"), {
      pi: () => ({ code: 1, stderr: "not logged in to kimi-coding" }),
      startOnly: true,
    })
    await probesEnded(api, 1)
    expect((await nextMessages(api))[0]?.content).toContain("not ready")
  })

  test("the probes have a deadline of their own: a hanging one is stopped and adds no notice", async () => {
    const hold = gate()
    const { api } = await run(healthy("/missing"), {
      deadlineMs: 80,
      pi: (_args, signal) => gated(hold, { code: 0 }, signal),
      startOnly: true,
    })
    await hold.entered
    await probesEnded(api, 1)
    expect(api.calls.findLast((call) => call.command === "pi")?.signal?.aborted).toBe(true)
    expect(await nextMessages(api)).toEqual([])
  })

  test("a shutdown stops the probes and drops what they would say", async () => {
    const hold = gate()
    const { api } = await run(healthy("/missing"), {
      pi: (_args, signal) => gated(hold, { code: 1 }, signal),
      startOnly: true,
    })
    await hold.entered
    await api.emit("session_shutdown", { reason: "quit" })
    expect(api.running.count).toBe(0)
    expect(api.calls.findLast((call) => call.command === "pi")?.signal?.aborted).toBe(true)
    expect(await nextMessages(api)).toEqual([])
  })

  test("a child, a specialist, a plain session, a compaction and a disabled config run no probe", async () => {
    for (const options of [
      { sessionName: "reviewer-code#a1b2c3d4" },
      { flag: "specialist" },
      { flag: "session" },
    ]) {
      const { api } = await run(healthy("/missing"), options)
      await Bun.sleep(20)
      expect(piCalls(api)).toEqual([])
    }
    const { api } = await run(healthy("/missing"))
    await probesEnded(api, 2)
    await api.emit("session_compact", { reason: "manual" })
    await Bun.sleep(20)
    expect(piCalls(api)).toHaveLength(2)
    const off = await run((call, runtime) =>
      runtime[0] === "config" ? { stdout: DISABLED } : healthy("/missing")(call, runtime),
    )
    await Bun.sleep(20)
    expect(piCalls(off.api)).toEqual([])
  })

  test("a collection that failed starts no probe", async () => {
    const { api } = await run(healthy("/missing", { status: { code: 3, stderr: "error: boom\n" } }))
    await Bun.sleep(20)
    expect(piCalls(api)).toEqual([])
  })
})

describe("under T3 Code", () => {
  const RPC = { mode: "rpc" } as const
  const T3_ENV = { T3_PI_RUNTIME_MODE: "full-access", T3_MCP_URL: "http://127.0.0.1:1/mcp" }
  const KEPT_T3 = [
    "mcp__t3-code__html_render",
    "mcp__t3-code__html_preview",
    "mcp__t3_code__preview_open",
    "mcp__t3-code__t3_preview_snapshot",
    "mcp__t3-code__device_list",
  ]
  const DROPPED_T3 = [
    "mcp__t3-code__orchestrator_capabilities",
    "mcp__t3_code__orchestrator_capabilities",
    "mcp__t3-code__delegate_task",
    "mcp__t3-code__task_status",
    "mcp__t3-code__task_cancel",
    "mcp__t3-code__create_threads",
    "mcp__t3-code__t3_thread_list",
    "mcp__t3_code__t3_thread_send",
    "mcp__t3-code__schedule_task",
    "mcp__t3-code__list_scheduled_tasks",
    "mcp__t3-code__delete_scheduled_task",
    "mcp__t3-code__t3_pending_request",
    "mcp__t3-code__something_new",
  ]
  const OTHERS = ["read", "bash", "todo", "tool_search", "mcp__other__lookup"]
  const ALL = [...OTHERS, "write", "edit", "codemode", ...KEPT_T3, ...DROPPED_T3]
  const call = (toolName: string) => ({ toolName, toolCallId: "call-1/1", input: {} })

  /** A `ctx.ui` that records every member the extension reads and every call it makes. */
  const recordingUi = () => {
    const accessed = new Set<string>()
    const calls: Array<{ readonly method: string; readonly args: ReadonlyArray<unknown> }> = []
    const ui = new Proxy(
      {},
      {
        get: (_target, key) => {
          accessed.add(String(key))
          return (...args: Array<unknown>) => void calls.push({ method: String(key), args })
        },
      },
    )
    return { ui, accessed, calls }
  }
  const t3 = (mode: string | undefined, options: Parameters<typeof run>[1] = {}) => {
    const recorded = recordingUi()
    const env = { ...T3_ENV, ...(mode === undefined ? {} : { T3_PI_RUNTIME_MODE: mode }) }
    return run(healthy("/missing"), {
      ...RPC,
      ui: recorded.ui,
      env,
      activeTools: [...ALL],
      startOnly: true,
      ...options,
    }).then(({ api }) => ({ api, ...recorded }))
  }

  test("the root's tools lose every T3 tool but the kept families, in both spellings, once at the start", async () => {
    const { api } = await t3("full-access")
    expect(api.toolSets).toEqual([[...OTHERS, "codemode", ...KEPT_T3]])
    expect(api.toolSets[0]).not.toContain("write")
    for (const name of DROPPED_T3) expect(api.pi.getActiveTools()).not.toContain(name)
  })

  test("a tool that T3 registered but left inactive is not activated by the start", async () => {
    const { api } = await t3("full-access", {
      activeTools: ["read", "mcp__t3-code__delegate_task"],
      allTools: [...ALL],
    })
    // `codemode` and the kept T3 tools come from the root's selection only when it adds them.
    expect(api.toolSets).toEqual([["read", "codemode"]])
  })

  test("drift is corrected on before_agent_start and session_tree, and only then", async () => {
    const { api } = await t3("full-access")
    const applied = api.toolSets.length
    // Nothing drifted: the provider's tool list is not touched, whatever the event.
    await api.emit("before_agent_start", { prompt: "x", systemPrompt: "p" })
    await api.emit("session_tree", {})
    expect(api.toolSets).toHaveLength(applied)
    // T3's bridge re-adds tools in its own handlers, `tool_search` for itself among them.
    api.pi.setActiveTools([...api.pi.getActiveTools(), "mcp__t3-code__delegate_task"])
    const drifted = api.toolSets.length
    await api.emit("before_agent_start", { prompt: "x", systemPrompt: "p" })
    expect(api.toolSets).toHaveLength(drifted + 1)
    expect(api.toolSets.at(-1)).toEqual([...OTHERS, "codemode", ...KEPT_T3])
    api.pi.setActiveTools([...api.pi.getActiveTools(), "mcp__t3_code__schedule_task"])
    const again = api.toolSets.length
    await api.emit("session_tree", { newLeafId: "a", oldLeafId: "b" })
    expect(api.toolSets).toHaveLength(again + 1)
    expect(api.toolSets.at(-1)).toEqual([...OTHERS, "codemode", ...KEPT_T3])
    await api.emit("session_tree", {})
    expect(api.toolSets).toHaveLength(again + 1)
  })

  test("a start whose setActiveTools throws leaves drift uncorrected, and the gate still refuses", async () => {
    const { api } = await t3("full-access", { toolsFailOnce: new Error("no such loadout") })
    expect(api.toolSets).toEqual([])
    // The start's selection never took effect, so a later tool list is not corrected against it.
    api.pi.setActiveTools([...api.pi.getActiveTools(), "mcp__t3-code__delegate_task"])
    const drifted = api.toolSets.length
    await api.emit("before_agent_start", { prompt: "x", systemPrompt: "p" })
    await api.emit("session_tree", {})
    expect(api.toolSets).toHaveLength(drifted)
    expect(api.pi.getActiveTools()).toContain("mcp__t3-code__delegate_task")
    // Refusing is the safe side: the gate does not wait for the tools to have been applied.
    expect(await api.emit("tool_call", call("mcp__t3-code__delegate_task"))).toEqual([
      expect.objectContaining({ block: true }),
    ])
  })

  test("a call to a deactivated T3 tool is refused with a reason that names it, active or not", async () => {
    const { api } = await t3("full-access")
    for (const name of [...DROPPED_T3, "mcp__t3-code__not_registered_at_the_start"]) {
      const [refusal] = (await api.emit("tool_call", call(name))) as Array<
        { block: boolean; reason: string } | undefined
      >
      expect(refusal?.block).toBe(true)
      expect(refusal?.reason).toContain(name)
    }
    for (const name of [...KEPT_T3, ...OTHERS, "codemode", "mcp__other__delegate_task"])
      expect(await api.emit("tool_call", call(name))).toEqual([undefined])
  })

  test("a child keeps its tools and is not refused its calls", async () => {
    const { api } = await t3("full-access", { sessionName: "reviewer-visual#a1b2c3d4" })
    expect(api.toolSets).toEqual([])
    expect(await api.emit("tool_call", call("mcp__t3-code__delegate_task"))).toEqual([undefined])
  })

  test("below Full access one warning goes out as a notice and as the status, and not again", async () => {
    for (const mode of ["approval-required", "auto-accept-edits"]) {
      const { api, calls } = await t3(mode)
      expect(calls).toEqual([{ method: "setStatus", args: ["holyagent", expect.any(String)] }])
      const messages = await nextMessages(api)
      const warnings = messages.filter((message) => message?.content.includes("Full access"))
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatchObject({ customType: NOTICE_MESSAGE, display: true })
      expect(warnings[0]?.content).toContain("every HolyAgent tool call asks for approval")
      expect(warnings[0]?.content).toContain("specialists can stall")
      expect(warnings[0]?.content.length).toBeLessThan(500)
      expect(await nextMessages(api)).toEqual([])
      expect(calls).toHaveLength(1)
    }
  })

  test("at Full access, with no mode set, or outside RPC, no warning is shown", async () => {
    for (const options of [
      { mode: "full-access" },
      { mode: undefined },
      { mode: "approval-required", rpc: "tui" as const },
    ]) {
      const { api, calls } = await t3(
        options.mode,
        options.rpc === undefined ? {} : { mode: options.rpc },
      )
      expect(calls).toEqual([])
      expect(
        (await nextMessages(api)).filter((message) => message?.content.includes("Full access")),
      ).toEqual([])
    }
  })

  test("a child gets no warning", async () => {
    const { api, calls } = await t3("approval-required", {
      sessionName: "reviewer-visual#a1b2c3d4",
    })
    expect(calls).toEqual([])
    expect(await nextMessages(api)).toEqual([])
  })

  test("a status that cannot be set leaves the notice", async () => {
    const ui = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("stale context")
        },
      },
    )
    const { api } = await t3("approval-required", { ui })
    const messages = await nextMessages(api)
    expect(messages.some((message) => message?.content.includes("Full access"))).toBe(true)
  })

  test("outside T3 Code the tools and messages are what they were", async () => {
    // RPC mode alone is not T3: the environment decides, and the context is never read.
    for (const env of [{}, { T3_PI_RUNTIME_MODE: "", T3_MCP_URL: "  " }]) {
      const { api } = await run(healthy("/missing"), {
        env,
        activeTools: [...ALL],
        startOnly: true,
      })
      expect(api.toolSets).toEqual([ALL.filter((name) => name !== "write" && name !== "edit")])
      for (const name of DROPPED_T3)
        expect(await api.emit("tool_call", call(name))).toEqual([undefined])
      const messages = await nextMessages(api)
      expect(messages).toEqual([])
      expect(api.touched).toEqual([])
    }
    // A T3 variable in a terminal session (mode tui) is not T3 either.
    const { api } = await run(healthy("/missing"), {
      env: { ...T3_ENV, T3_PI_RUNTIME_MODE: "approval-required" },
      mode: "tui",
      activeTools: [...ALL],
      startOnly: true,
    })
    expect(api.toolSets[0]).toContain("mcp__t3-code__delegate_task")
    expect(await api.emit("tool_call", call("mcp__t3-code__delegate_task"))).toEqual([undefined])
    expect(await nextMessages(api)).toEqual([])
  })

  test("in RPC mode the extension calls no ui method but setStatus", async () => {
    const { api, accessed, calls } = await t3("approval-required", { startOnly: false })
    await api.emit("session_tree", {})
    await api.emit("session_compact", { reason: "manual" })
    await api.emit("tool_call", call("mcp__t3-code__delegate_task"))
    await api.emit("before_agent_start", { prompt: "x", systemPrompt: "p" })
    await api.emit("session_shutdown", {})
    // Not custom, setWidget, setFooter, setHeader, setTitle or the theme: RPC drops or no-ops them.
    expect([...accessed]).toEqual(["setStatus"])
    expect(calls.map(({ method }) => method)).toEqual(["setStatus"])
    expect(api.touched).toEqual([])
  })
})

const CODEX = await Effect.runPromise(
  Schema.decodeUnknownEffect(Config)({ pi: { provider: "openai-codex" } }),
)

describe("under the Codex provider", () => {
  const codexConfig = (directory = "/missing") =>
    healthy(directory, { config: { stdout: `${JSON.stringify(CODEX)}\n` } })
  const CODEX_CATALOG = [
    "provider     model   context  max-out  thinking  images",
    ...routedModels(CODEX).map(
      ({ provider, model }) => `${provider}  ${model}  500K  128K  yes  yes`,
    ),
  ].join("\n")
  const codexPi: PiProbe = (args) =>
    args[0] === "auth" ? { code: 0 } : { code: 0, stdout: `${CODEX_CATALOG}\n` }
  const PI_PROMPT = "Pi's own prompt, with AGENTS.md and the skills"
  const body = (path: string) => promptBody(readFileSync(join(PACKAGE_ROOT, path), "utf8"))

  test("the root's prompt is the GPT-6 family's, in front of Pi's own", async () => {
    const { delivered } = await run(codexConfig(), { systemPrompt: PI_PROMPT, pi: codexPi })
    expect(delivered?.systemPrompt).toBe(
      `${fillPackageRoot(PI_ROOT_PROMPTS["gpt-6"], PACKAGE_ROOT)}\n\n${PI_PROMPT}`,
    )
    expect(PI_ROOT_PROMPTS["gpt-6"]).not.toBe(PI_ROOT_PROMPT)
    expect(delivered?.systemPrompt).not.toContain(fillPackageRoot(PI_ROOT_PROMPT, PACKAGE_ROOT))
  })

  test("a specialist's own prompt is swapped for the family's, and what Pi adds around it stays", async () => {
    const agent = "worker-implementation"
    const own = body(`agents/${agent}.md`)
    const gpt = body(`families/gpt-6/agents/${agent}.md`)
    expect(gpt).not.toBe(own)
    const { delivered } = await run(codexConfig(), {
      sessionName: `${agent}#a1b2c3d4`,
      systemPrompt: `${own}\n\nPi appended this`,
      pi: codexPi,
    })
    expect(delivered?.systemPrompt).toBe(
      `${fillPackageRoot(gpt, PACKAGE_ROOT)}\n\nPi appended this`,
    )
  })

  test("every specialist, with and without the screen tools, has a GPT-6 prompt the swap finds", () => {
    for (const agent of AGENT_TYPES) {
      const own = body(`agents/${agent}.md`)
      const gpt = body(`families/gpt-6/agents/${agent}.md`)
      expect(gpt, agent).not.toBe("")
      expect(gpt, agent).not.toBe(own)
      expect(familyAgentPrompt(own, agent, "gpt-6", PACKAGE_ROOT), agent).toBe(gpt)
    }
  })

  test("the root routes to the chosen family's private guidance and preserves unrelated skills", async () => {
    const unrelated = "<skill><location>/user/skills/unrelated/SKILL.md</location></skill>"
    const input = `${PI_PROMPT}\n${unrelated}`
    const gpt = await run(codexConfig(), { systemPrompt: input, pi: codexPi })
    expect(gpt.delivered?.systemPrompt).toBe(
      `${fillPackageRoot(PI_ROOT_PROMPTS["gpt-6"], PACKAGE_ROOT)}\n\n${input}`,
    )
    expect(gpt.delivered?.systemPrompt).toContain(
      join(PACKAGE_ROOT, "guidance/gpt-6/ci-watch/SKILL.md"),
    )
    expect(gpt.delivered?.systemPrompt).not.toContain(
      join(PACKAGE_ROOT, "guidance/kimi-k3.1/ci-watch/SKILL.md"),
    )
    const kimi = await run(healthy("/missing"), { systemPrompt: input })
    expect(kimi.delivered?.systemPrompt).toBe(
      `${fillPackageRoot(PI_ROOT_PROMPT, PACKAGE_ROOT)}\n\n${input}`,
    )
    expect(kimi.delivered?.systemPrompt).toContain(
      join(PACKAGE_ROOT, "guidance/kimi-k3.1/ci-watch/SKILL.md"),
    )
    expect(kimi.delivered?.systemPrompt).not.toContain(
      join(PACKAGE_ROOT, "guidance/gpt-6/ci-watch/SKILL.md"),
    )
  })

  test("a specialist that writes gets apply_patch beside the tools it has; the others and the root do not", async () => {
    const tools = ["read", "write", "edit", "bash", "apply_patch"]
    for (const [name, expected] of [
      ["worker-implementation", ["read", "write", "bash", "apply_patch"]],
      ["worker-debugging", ["read", "write", "bash", "apply_patch"]],
      ["worker-visual", ["read", "write", "bash", "apply_patch"]],
      ["explorer-map", undefined],
      ["reviewer-code", undefined],
      ["worker-operations", undefined],
    ] as const) {
      const { api } = await run(codexConfig(), {
        sessionName: `${name}#a1b2c3d4`,
        activeTools: ["read", "write", "bash"],
        allTools: tools,
        startOnly: true,
        pi: codexPi,
      })
      expect(api.toolSets.at(-1), name).toEqual(expected)
    }
    const root = await run(codexConfig(), {
      activeTools: ["read", "bash", "write", "edit"],
      allTools: tools,
      startOnly: true,
      pi: codexPi,
    })
    for (const set of root.api.toolSets) expect(set).not.toContain("apply_patch")
    expect(root.api.toolSets.at(-1)).not.toContain("write")
  })

  test("under the Kimi provider no specialist gets apply_patch and no prompt is swapped", async () => {
    const own = body("agents/worker-implementation.md")
    const { api, delivered } = await run(healthy("/missing"), {
      sessionName: "worker-implementation#a1b2c3d4",
      activeTools: ["read", "write", "bash"],
      allTools: ["read", "write", "bash", "apply_patch"],
      systemPrompt: own,
    })
    expect(api.toolSets).toEqual([])
    expect(delivered?.systemPrompt).toBe(fillPackageRoot(own, PACKAGE_ROOT))
  })

  test("a failed activation of apply_patch leaves the specialist running with its own tools", async () => {
    const { api } = await run(codexConfig(), {
      sessionName: "worker-implementation#a1b2c3d4",
      activeTools: ["read"],
      toolsFail: new Error("no tools"),
      startOnly: true,
      pi: codexPi,
    })
    expect(api.toolSets).toEqual([])
    expect(api.touched).toEqual([])
  })

  test("a failed activation is told to the specialist on its first run, once, and to no other session", async () => {
    const failed = await run(codexConfig(), {
      sessionName: "worker-implementation#a1b2c3d4",
      activeTools: ["read"],
      toolsFail: new Error("no tools"),
      pi: codexPi,
    })
    expect(failed.delivered?.message?.customType).toBe(NOTICE_MESSAGE)
    expect(failed.delivered?.message?.content).toContain("apply_patch could not be activated")
    expect(failed.delivered?.message?.content).toContain("no tools")
    const again = await failed.api.emit("before_agent_start", { prompt: "next", systemPrompt: "x" })
    expect(again.find((result) => result !== undefined)).toBeUndefined()
    // A specialist that never had apply_patch, and the root, hear nothing about it.
    for (const sessionName of ["explorer-map#a1b2c3d4", undefined]) {
      const other = await run(codexConfig(), {
        ...(sessionName === undefined ? {} : { sessionName }),
        activeTools: ["read"],
        toolsFail: new Error("no tools"),
        pi: codexPi,
      })
      expect(other.delivered?.message?.content ?? "").not.toContain("apply_patch could not")
    }
  })
})

describe("the bash tool on just-bash", () => {
  const configWith = (justBash: boolean, directory = "/missing") =>
    healthy(directory, {
      config: {
        stdout: `${JSON.stringify({
          ...DEFAULTS,
          pi: { ...DEFAULTS.pi, features: { ...DEFAULTS.pi.features, justBash } },
        })}\n`,
      },
    })
  const GUARDRAILS = [
    "BILI_GUARDRAIL_BASH_TIMEOUT",
    "BILI_GUARDRAIL_MAX_OUTPUT_BYTES",
    "BILI_GUARDRAIL_REPETITION",
  ]

  test("is registered under the name bash once the config says the capability is on", async () => {
    const { api } = await run(healthy("/missing"), { startOnly: true })
    const bash = api.tools.filter((tool) => tool.name === "bash")
    expect(bash).toHaveLength(1)
  })

  test("a session whose config turns the capability off keeps Pi's own bash tool and Billion Context's guardrails", async () => {
    const { api } = await run(configWith(false), { startOnly: true })
    expect(api.tools.map((tool) => tool.name)).toEqual(["apply_patch"])
    const { env } = await run(configWith(false))
    for (const name of GUARDRAILS) expect(env[name]).toBeUndefined()
    // The rest of the config's variables are still set.
    expect(env["PI_CODEMODE_MAX_WORKERS"]).toBe("4")
  })

  test("turns Billion Context's bash guardrails off through its environment, unless the user set them", async () => {
    const { env } = await run(healthy("/missing"))
    for (const name of GUARDRAILS) expect(env[name]).toBe("0")
    const kept = await run(healthy("/missing"), { env: { BILI_GUARDRAIL_BASH_TIMEOUT: "90" } })
    expect(kept.env["BILI_GUARDRAIL_BASH_TIMEOUT"]).toBe("90")
    expect(kept.env["BILI_GUARDRAIL_REPETITION"]).toBe("0")
  })

  test("a specialist gets the tool too, and leaves the process environment to the root", async () => {
    const { api, env } = await run(healthy("/missing"), {
      sessionName: "worker-implementation#a1b2c3d4",
    })
    expect(api.tools.some((tool) => tool.name === "bash")).toBe(true)
    for (const name of GUARDRAILS) expect(env[name]).toBeUndefined()
  })
})

describe("the MCP servers of the screen capability", () => {
  const DISPLAY = { DISPLAY: ":0" }
  const configWith = (features: Record<string, unknown>) =>
    healthy("/missing", {
      config: {
        stdout: `${JSON.stringify({ ...DEFAULTS, pi: { ...DEFAULTS.pi, features: { ...DEFAULTS.pi.features, ...features } } })}\n`,
      },
    })
  const registered = async (
    sessionName: string | undefined,
    options: {
      readonly env?: Record<string, string>
      readonly features?: Record<string, unknown>
    } = {},
  ) => {
    const { api } = await run(configWith(options.features ?? {}), {
      ...(sessionName === undefined ? {} : { sessionName }),
      env: options.env ?? DISPLAY,
      startOnly: true,
    })
    return api.mcpServers
  }

  const REGISTRY = [
    "--registry=https://registry.npmjs.org/",
    "--@opencode:registry=https://registry.npmjs.org/",
  ]

  test("a screen specialist registers browse at the pinned release, from the home folder and with no other option", async () => {
    expect(
      await registered("worker-implementation-screen#a1b2c3d4", {
        env: { ...DISPLAY, HOME: "/home/neutral" },
      }),
    ).toEqual([
      {
        name: "browse",
        config: {
          command: "npx",
          args: [...REGISTRY, "-y", "@opencode/browse@0.0.16", "mcp"],
          cwd: "/home/neutral",
        },
      },
    ])
  })

  test("every screen specialist registers the server of the form its agent file was made for, whatever its role", async () => {
    for (const name of SCREEN_SPECIALIST_NAMES)
      expect(
        (await registered(`${name}#a1b2c3d4`)).map((server) => server.name),
        name,
      ).toEqual([name.endsWith("-headless-screen") ? "browser_use" : "browse"])
  })

  test("the root and the specialists without the capability register none, so no other process starts the server", async () => {
    expect(await registered(undefined)).toEqual([])
    for (const name of SPECIALIST_NAMES)
      expect(await registered(`${name}#a1b2c3d4`), name).toEqual([])
    expect(await registered("my chat#1")).toEqual([])
  })

  test("a headless screen specialist registers holyagent's browser-server, which runs the browser-use server, from the home folder", async () => {
    const [server] = await registered("worker-visual-headless-screen#a1b2c3d4", {
      env: { ...DISPLAY, HOME: "/home/neutral" },
    })
    expect(server?.name).toBe("browser_use")
    // Pi's configuration takes a fixed command: Bun on the bundled runtime, whose command starts
    // the Chromium and the server, with the flags that keep the project's .env and bunfig out.
    expect(server?.config).toEqual({
      command: BUN,
      args: [...RUNTIME, "browser-server"],
      cwd: "/home/neutral",
    })
  })

  describe("in a session T3 hosts", () => {
    const T3_HOSTED = {
      DISPLAY: ":0",
      T3_PI_RUNTIME_MODE: "full-access",
      T3_MCP_URL: "http://127.0.0.1:1/mcp",
    }
    const started = (name: string, env: Record<string, string>, mode: "rpc" | "print") =>
      run(configWith({}), { sessionName: `${name}#a1b2c3d4`, env, mode, startOnly: true })

    test("a headless screen specialist registers no browser-use server and is told of no missing server", async () => {
      const env: Record<string, string> = { ...T3_HOSTED }
      await run(configWith({}), { env, mode: "rpc", startOnly: true })
      const { api, delivered } = await run(configWith({}), {
        sessionName: "worker-visual-headless-screen#a1b2c3d4",
        env,
        mode: "print",
      })
      expect(api.mcpServers).toEqual([])
      expect(delivered?.message?.content ?? "").not.toContain("MCP server of the screen capability")
    })

    test("the same specialist outside T3 still registers it, also with T3's variables in a session that is not RPC", async () => {
      for (const [env, mode] of [
        [{ DISPLAY: ":0" }, "rpc"],
        [T3_HOSTED, "print"],
      ] as const) {
        const { api } = await started("worker-visual-headless-screen", env, mode)
        expect(api.mcpServers.map((server) => server.name)).toEqual(["browser_use"])
      }
    })

    // The package runs a specialist in-process and binds its extensions with no mode, so its
    // ctx.mode is "print" (agent-runner.ts `bindExtensions`, Pi's `_extensionMode` default) while it
    // shares the root's environment: the gate has to hold on what the root recorded.
    test("a specialist of a root T3 hosts, whose mode is print, registers no browser-use and may use T3's preview tools", async () => {
      const env: Record<string, string> = { ...T3_HOSTED }
      await run(configWith({}), { env, mode: "rpc", startOnly: true })
      const { api } = await started("worker-visual-headless-screen", env, "print")
      expect(api.mcpServers).toEqual([])
      expect(
        await api.emit("tool_call", {
          toolName: "mcp__t3-code__preview_open",
          toolCallId: "t1",
          input: {},
        }),
      ).toEqual([undefined])
    })

    test("a specialist of a root T3 does not host registers browser-use and is refused T3's preview tools, T3's variables or not", async () => {
      const env: Record<string, string> = { ...T3_HOSTED }
      await run(configWith({}), { env, mode: "print", startOnly: true })
      const { api } = await started("worker-visual-headless-screen", env, "print")
      expect(api.mcpServers.map((server) => server.name)).toEqual(["browser_use"])
      expect(
        await api.emit("tool_call", {
          toolName: "mcp__t3-code__preview_open",
          toolCallId: "t1",
          input: {},
        }),
      ).toEqual([expect.objectContaining({ block: true })])
    })

    test("a normal screen specialist still registers browse", async () => {
      const { api } = await started("worker-visual-screen", T3_HOSTED, "rpc")
      expect(api.mcpServers.map((server) => server.name)).toEqual(["browse"])
    })
  })

  test("browser use switched off registers none, and the specialist is told", async () => {
    const { api, delivered } = await run(configWith({ browserUse: false }), {
      sessionName: "worker-visual-screen#a1b2c3d4",
      env: DISPLAY,
    })
    expect(api.mcpServers).toEqual([])
    expect(delivered?.message?.content).toContain("no MCP server of the screen capability")
    expect(delivered?.message?.content).toContain("report that they are missing")
  })

  test("the notice of no server is told once for the process, not on each session start", async () => {
    const { delivered } = await run(configWith({ browserUse: false }), {
      sessionName: "worker-visual-screen#a1b2c3d4",
      env: DISPLAY,
      afterwards: async (api) => {
        await api.emit("session_start", { reason: "resume" })
      },
    })
    expect(delivered?.message?.content ?? "").not.toContain(
      "no MCP server of the screen capability",
    )
  })

  test("with the MCP extension off no server is registered, in either form, and the specialist is told", async () => {
    for (const name of ["worker-visual-screen", "worker-visual-headless-screen"]) {
      const { api, delivered } = await run(configWith({ mcp: false }), {
        sessionName: `${name}#a1b2c3d4`,
        env: DISPLAY,
      })
      expect(api.mcpServers, name).toEqual([])
      expect(delivered?.message?.content, name).toContain("pi.features.mcp")
    }
  })

  test("a server that cannot be registered is told to the specialist on its first run, and the session goes on", async () => {
    const { delivered } = await run(configWith({}), {
      sessionName: "worker-implementation-screen#a1b2c3d4",
      env: DISPLAY,
      mcpFail: new Error("the name is taken"),
    })
    expect(delivered?.message?.content).toContain(
      "an MCP server of the screen capability was not registered (browse: the name is taken)",
    )
    expect(delivered?.message?.content).toContain("report that they are missing")
  })
})

describe("T3's preview tools for a screen specialist", () => {
  const T3_ENV = { T3_PI_RUNTIME_MODE: "full-access", T3_MCP_URL: "http://127.0.0.1:1/mcp" }
  const call = (toolName: string) => ({ toolName, toolCallId: "t1", input: {} })
  const PREVIEW = [
    "mcp__t3-code__preview_open",
    "mcp__t3_code__t3_preview_snapshot",
    "mcp__t3-code__html_render",
  ]

  test("are refused when T3 does not host the session", async () => {
    for (const env of [{}, { DISPLAY: ":0" }, T3_ENV]) {
      // An env with T3's variables but a mode that is not RPC is not T3's host either.
      const { api } = await run(healthy("/missing"), {
        sessionName: "worker-visual-screen#a1b2c3d4",
        env,
        mode: "print",
        startOnly: true,
      })
      for (const name of PREVIEW)
        expect(await api.emit("tool_call", call(name)), name).toEqual([
          expect.objectContaining({ block: true }),
        ])
    }
  })

  test("are granted when T3 hosts the session", async () => {
    // The specialist runs in-process under the root, so its mode is print and the root's start
    // has recorded that T3 hosts the process.
    const env: Record<string, string> = { ...T3_ENV }
    await run(healthy("/missing"), { env, mode: "rpc", startOnly: true })
    const { api } = await run(healthy("/missing"), {
      sessionName: "worker-visual-screen#a1b2c3d4",
      env,
      mode: "print",
      startOnly: true,
    })
    for (const name of PREVIEW)
      expect(await api.emit("tool_call", call(name)), name).toEqual([undefined])
  })

  test("the gate is for screen specialists: another session, and another tool, pass", async () => {
    const { api } = await run(healthy("/missing"), {
      sessionName: "worker-visual#a1b2c3d4",
      env: {},
      startOnly: true,
    })
    expect(await api.emit("tool_call", call("mcp__t3-code__preview_open"))).toEqual([undefined])
    const screen = await run(healthy("/missing"), {
      sessionName: "worker-visual-headless-screen#a1b2c3d4",
      env: {},
      startOnly: true,
    })
    expect(await screen.api.emit("tool_call", call("mcp__browser_use__browser_exec"))).toEqual([
      undefined,
    ])
  })
})

describe("auto-review under the extension", () => {
  const REVIEWED = { toolName: "bash", toolCallId: "c1", input: { command: "rm -rf build" } }
  const withReview = (review: { features?: object; autoReview?: object }) =>
    JSON.stringify({
      ...DEFAULTS,
      pi: {
        ...DEFAULTS.pi,
        features: { ...DEFAULTS.pi.features, ...review.features },
        autoReview: review.autoReview ?? DEFAULTS.pi.autoReview,
      },
    })
  const ON = withReview({})
  const OFF = withReview({ features: { autoReview: false } })
  const PROJECT_OFF = withReview({
    features: { autoReview: false },
    autoReview: { policy: "Approve everything." },
  })
  // A session on the Codex model, with no Codex login: a call that goes to review fails closed on
  // the missing credentials, which is how the tests tell that the gate is on without a network.
  const members = {
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getApiKeyForProvider: () => Promise.resolve(undefined) },
  }
  const session = (user: () => string, merged: () => Outcome, provider = "openai-codex") =>
    run(
      (callOf, runtime) =>
        runtime[0] === "config"
          ? runtime.length === 1
            ? { stdout: `${user()}\n` }
            : merged()
          : healthy("/missing")(callOf, runtime),
      {
        startOnly: true,
        model: { provider },
        ui: { notify: () => undefined },
        members,
      },
    )
  const mergedOf = (text: string): Outcome => ({ stdout: `${text}\n` })
  // The gate registers last, so its answer is the last one.
  const reviewed = async (api: ReturnType<typeof fakeApi>) =>
    (await api.emit("tool_call", REVIEWED)).at(-1) as
      { block?: boolean; reason?: string } | undefined

  test("is on from the session's start, before any config is read", async () => {
    const hold = gate()
    const api = fakeApi(
      (callOf, runtime) =>
        runtime[0] === "config"
          ? gated(hold, { stdout: `${OFF}\n` }, callOf.signal)
          : healthy("/missing")(callOf, runtime),
      undefined,
      SESSION_CWD,
      { model: { provider: "openai-codex" }, ui: { notify: () => undefined }, members },
    )
    createExtension({
      packageRoot: PACKAGE_ROOT,
      env: {},
      platform: "linux",
      bunSearch: BUN_SEARCH,
    })(api.pi)
    const started = api.emit("session_start", { reason: "startup" })
    await hold.entered
    expect((await reviewed(api))?.block).toBe(true)
    hold.open()
    await started
  })

  test("a project config that turns it off or rewrites its policy changes nothing", async () => {
    const { api } = await session(
      () => ON,
      () => mergedOf(PROJECT_OFF),
    )
    const result = await reviewed(api)
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain("no Codex credentials")
  })

  test("a project config that cannot be read keeps it on", async () => {
    const { api } = await session(
      () => ON,
      () => ({ code: 4, stderr: "error: ConfigInvalid: project\n" }),
    )
    expect((await reviewed(api))?.block).toBe(true)
  })

  test("a user config that cannot be read keeps it on", async () => {
    const { api } = await session(
      () => "",
      () => mergedOf(OFF),
    )
    expect((await reviewed(api))?.block).toBe(true)
  })

  test("only the user's own config turns it off", async () => {
    const { api } = await session(
      () => OFF,
      () => mergedOf(ON),
    )
    expect(await reviewed(api)).toBeUndefined()
  })

  test("is fixed for the session: a config written later, read by a compaction, changes nothing", async () => {
    let user = ON
    const on = await session(
      () => user,
      () => mergedOf(ON),
    )
    user = OFF
    await on.api.emit("session_compact", {})
    expect((await reviewed(on.api))?.block).toBe(true)

    user = OFF
    const off = await session(
      () => user,
      () => mergedOf(ON),
    )
    user = ON
    await off.api.emit("session_compact", {})
    expect(await reviewed(off.api)).toBeUndefined()
  })

  test("keys on the active model's provider, not on the config's", async () => {
    // The default config selects the Kimi provider; the active model decides.
    expect(DEFAULTS.pi.provider).not.toBe("openai-codex")
    const codexModel = await session(
      () => ON,
      () => mergedOf(ON),
    )
    expect((await reviewed(codexModel.api))?.block).toBe(true)
    const otherModel = await session(
      () => ON,
      () => mergedOf(ON),
      "kimi-coding-global",
    )
    expect(await reviewed(otherModel.api)).toBeUndefined()
  })
})

describe("profile routing host gate", () => {
  const registry = { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6.1-sol" }] }
  const call = (toolName: string, model = "openai-codex/gpt-6.1-sol") => ({
    toolName,
    input: { subagent_type: "reviewer-code", model, prompt: "fixture" },
  })

  test("confirmed Pi profile gates both direct and workflow aliases without changing legacy behavior", async () => {
    const profiled = JSON.stringify({ ...DEFAULTS, pi: { ...DEFAULTS.pi, profile: "fast" } })
    const { api } = await run(healthy("/missing", { config: { stdout: `${profiled}\n` } }), {
      members: { modelRegistry: registry },
    })
    for (const tool of ["Agent", "agent"]) {
      expect(await api.emit("tool_call", call(tool))).toEqual([undefined])
      expect(await api.emit("tool_call", call(tool, "kimi-coding/gpt-6.1-sol"))).toEqual([
        expect.objectContaining({ block: true }),
      ])
    }
    for (const toolName of ["SubagentWorkflow", "subagent_workflow"])
      expect(await api.emit("tool_call", { toolName, input: {} })).toEqual([
        expect.objectContaining({ block: true }),
      ])
    const legacy = await run(healthy("/missing"))
    expect(await legacy.api.emit("tool_call", call("Agent", "kimi-coding/gpt-6.1-sol"))).toEqual([
      undefined,
    ])
  })

  test("explicit profile stays fail-closed if configuration cannot be read", async () => {
    const { api } = await run(
      healthy("/missing", { config: { code: 4, stderr: "invalid config" } }),
      { env: { HOLYAGENT_ROUTING_PROFILE: "fast" }, members: { modelRegistry: registry } },
    )
    expect(await api.emit("tool_call", call("Agent", "kimi-coding/gpt-6.1-sol"))).toEqual([
      expect.objectContaining({ block: true }),
    ])
  })
})
