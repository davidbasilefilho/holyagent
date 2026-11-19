import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai"
import {
  createAgentSession,
  createEventBus,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"

import { createAgentWait, registerAgentWait } from "../src/wait-for-agents.ts"

let fixtureRoot: string
beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "holyagent-events-test-"))
  if (spawnSync("git", ["-C", fixtureRoot, "rev-parse", "--show-toplevel"]).status === 0)
    throw new Error("fixture is inside a Git worktree")
})
afterEach(() => rm(fixtureRoot, { recursive: true, force: true }))

const enabledFixture = (pi: ExtensionAPI) => {
  const guard = registerAgentWait(pi)
  pi.on("session_start", () => guard.enable())
}

test("an unknown host version does not register the wait tool", () => {
  const registered: string[] = []
  const pi = {
    events: createEventBus(),
    registerTool: (tool: { readonly name: string }) => registered.push(tool.name),
  } as unknown as ExtensionAPI
  const wait = registerAgentWait(pi, false, "unknown")
  wait.enable()
  expect(registered).toEqual([])
})

test("a completed top-level agent is retained across a completion-before-wait race", async () => {
  const bus = createEventBus()
  let consumed = false
  bus.on("subagents:rpc:consume", () => {
    consumed = true
  })
  const wait = createAgentWait(bus)
  bus.emit("subagents:ready", {})
  bus.emit("subagents:started", { id: "a" })
  bus.emit("subagents:completed", { id: "a", result: "host keeps this" })
  wait.input("rpc")
  expect(await wait.wait({ timeoutMs: 10 })).toEqual({
    reason: "agent",
    id: "a",
    status: "completed",
  })
  expect(await wait.wait({ timeoutMs: 10 })).toEqual({ reason: "input" })
  expect(consumed).toBe(false)
  expect(await wait.wait({ timeoutMs: 10 })).toMatchObject({ reason: "unavailable" })
  wait.dispose()
})

test("completion, submitted input, cancellation and timeout wake independently", async () => {
  const bus = createEventBus()
  const wait = createAgentWait(bus)
  bus.emit("subagents:ready", {})
  bus.emit("subagents:started", { id: "a" })
  const input = wait.wait({ timeoutMs: 500 })
  wait.input("extension")
  wait.input("rpc")
  expect(await input).toEqual({ reason: "input" })
  const completion = wait.wait({ timeoutMs: 500 })
  bus.emit("subagents:failed", { id: "a" })
  expect(await completion).toEqual({ reason: "agent", id: "a", status: "failed" })
  bus.emit("subagents:started", { id: "b" })
  const abort = new AbortController()
  const cancelled = wait.wait({ timeoutMs: 500, signal: abort.signal })
  abort.abort()
  expect(await cancelled).toEqual({ reason: "cancelled" })
  expect(await wait.wait({ timeoutMs: 1 })).toEqual({
    reason: "timeout",
    timeoutMs: 1,
    cache: "unknown",
  })
  const pending = wait.wait({ timeoutMs: 500 })
  wait.dispose()
  expect(await pending).toMatchObject({ reason: "cancelled" })
})

test("missing events and workflow work return unavailable rather than blocking", async () => {
  const bus = createEventBus()
  const wait = createAgentWait(bus)
  expect(await wait.wait({ timeoutMs: 100 })).toMatchObject({ reason: "unavailable" })
  bus.emit("subagents:ready", {})
  bus.emit("subagents:started", { id: "a" })
  expect(await wait.wait({ timeoutMs: 100, workflowPending: true })).toMatchObject({
    reason: "unavailable",
  })
  bus.emit("subagents:completed", { id: "a" })
  expect(await wait.wait({ timeoutMs: 100 })).toMatchObject({ reason: "agent", id: "a" })
  wait.dispose()
})

test("the wait tool is not registered without the explicit root flag", async () => {
  const settingsManager = SettingsManager.inMemory()
  const loader = new DefaultResourceLoader({
    cwd: fixtureRoot,
    agentDir: join(fixtureRoot, "agent"),
    settingsManager,
    extensionFactories: [enabledFixture],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await loader.reload()
  const runtime = await ModelRuntime.create({
    authPath: join(fixtureRoot, "agent", "auth.json"),
    modelsPath: join(fixtureRoot, "agent", "models.json"),
  })
  const { session } = await createAgentSession({
    cwd: fixtureRoot,
    agentDir: join(fixtureRoot, "agent"),
    modelRuntime: runtime,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  })
  await session.bindExtensions({})
  expect(session.agent.state.tools.some((tool) => tool.name === "wait_for_agents")).toBe(false)
  session.dispose()
})

test("real Pi SDK queues RPC input while the wait tool is executing", async () => {
  const bus = createEventBus()
  const settingsManager = SettingsManager.inMemory()
  let guard: ReturnType<typeof registerAgentWait> | undefined
  const loader = new DefaultResourceLoader({
    cwd: fixtureRoot,
    agentDir: join(fixtureRoot, "agent"),
    settingsManager,
    eventBus: bus,
    extensionFactories: [
      (pi) => {
        guard = registerAgentWait(pi)
        pi.on("session_start", () => guard?.enable())
      },
    ],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await loader.reload()
  loader.getExtensions().runtime.flagValues.set("holyagent-native-root", true)
  const runtime = await ModelRuntime.create({
    authPath: join(fixtureRoot, "agent", "auth.json"),
    modelsPath: join(fixtureRoot, "agent", "models.json"),
  })
  runtime.registerProvider("mock-events", {
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    apiKey: "fixture",
    models: [
      {
        id: "mock",
        name: "mock",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 1000,
      },
    ],
  })
  await runtime.setRuntimeApiKey("mock-events", "fixture")
  const model: Model<"openai-completions"> = {
    id: "mock",
    name: "mock",
    api: "openai-completions",
    provider: "mock-events",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 10000,
    maxTokens: 1000,
  }
  const { session } = await createAgentSession({
    cwd: fixtureRoot,
    agentDir: join(fixtureRoot, "agent"),
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager,
  })
  await session.bindExtensions({ onError: () => {} })
  bus.emit("subagents:ready", {})
  bus.emit("subagents:started", { id: "a" })
  let count = 0
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream()
    const first = count++ === 0
    const message: AssistantMessage = {
      role: "assistant",
      content: first
        ? [
            {
              type: "toolCall",
              id: "call-1",
              name: "wait_for_agents",
              arguments: { timeout_ms: 1000 },
            },
          ]
        : [{ type: "text", text: "done" }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: first ? "toolUse" : "stop",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    queueMicrotask(() => stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }))
    return stream
  }
  let wakeStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    wakeStarted = resolve
  })
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "wait_for_agents")
      wakeStarted?.()
  })
  const running = session.prompt("start")
  await started
  await session.steer("new user instruction", undefined, { source: "rpc" })
  await running
  expect(
    session.messages.some(
      (message) =>
        message.role === "toolResult" &&
        message.content.some(
          (part) => part.type === "text" && part.text.includes('"reason":"input"'),
        ),
    ),
  ).toBe(true)
  expect(
    session.messages.some(
      (message) =>
        message.role === "user" && JSON.stringify(message.content).includes("new user instruction"),
    ),
  ).toBe(true)
  guard?.disable()
  expect(session.getActiveToolNames()).not.toContain("wait_for_agents")
  guard?.enable()
  expect(session.getActiveToolNames()).toContain("wait_for_agents")
  await session.reload()
  expect(session.agent.state.tools.some((tool) => tool.name === "wait_for_agents")).toBe(true)
  unsubscribe()
  session.dispose()
})

test("malformed event subscriptions release installed handlers and cannot produce a successful wait", async () => {
  for (const broken of ["throw", "undefined", "object"] as const) {
    const handlers = new Map<string, (payload: unknown) => void>()
    const removed: string[] = []
    const bus = {
      on(channel: string, handler: (payload: unknown) => void) {
        handlers.set(channel, handler)
        if (channel === "subagents:started") {
          if (broken === "throw") throw new Error("broken bus")
          return broken === "undefined" ? undefined : {}
        }
        return () => {
          removed.push(channel)
          handlers.delete(channel)
        }
      },
    }
    const wait = createAgentWait(bus as unknown as Parameters<typeof createAgentWait>[0])
    expect(removed).toEqual(["subagents:ready", "subagents:created"])
    handlers.get("subagents:ready")?.({})
    handlers.get("subagents:started")?.({ id: "ignored" })
    wait.input("rpc")
    expect(await wait.wait({ timeoutMs: 10 })).toMatchObject({ reason: "unavailable" })
    expect(() => {
      wait.dispose()
      wait.dispose()
    }).not.toThrow()
    expect(removed).toEqual(["subagents:ready", "subagents:created"])
  }
})

test("throwing unsubscribe callbacks cannot stop cleanup or make disposal non-idempotent", async () => {
  const attempted: string[] = []
  const wait = createAgentWait({
    on(channel) {
      return () => {
        attempted.push(channel)
        if (channel === "subagents:created") throw new Error("broken unsubscribe")
      }
    },
  })
  expect(() => {
    wait.dispose()
    wait.dispose()
  }).not.toThrow()
  expect(attempted).toEqual([
    "subagents:ready",
    "subagents:created",
    "subagents:started",
    "subagents:completed",
    "subagents:failed",
    "subagents:disposed",
  ])
  expect(await wait.wait({ timeoutMs: 10 })).toMatchObject({ reason: "cancelled" })
})

test("malformed callable buses cannot crash registration or repeated session shutdown", async () => {
  for (const failure of ["throw", "invalid"] as const) {
    const handlers = new Map<string, () => void>()
    let tool:
      | { execute: (id: string, args: { timeout_ms?: number }) => Promise<{ details: unknown }> }
      | undefined
    const pi = {
      events: {
        on: () => {
          if (failure === "throw") throw new Error("broken bus")
          return undefined
        },
      },
      on: (name: string, handler: () => void) => handlers.set(name, handler),
      getFlag: () => true,
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: () => {},
      registerTool: (value: typeof tool) => {
        tool = value
      },
    } as unknown as ExtensionAPI
    const guard = registerAgentWait(pi, false, "1.5.0")
    guard.enable()
    expect(tool).toBeUndefined()
    if (tool !== undefined)
      expect((await tool.execute("1", { timeout_ms: 10 })).details).toMatchObject({
        reason: "unavailable",
      })
    expect(() => {
      handlers.get("session_shutdown")?.()
      handlers.get("session_shutdown")?.()
      guard.disable()
      handlers.get("session_start")?.()
      guard.enable()
      handlers.get("session_shutdown")?.()
    }).not.toThrow()
  }
})

test("absent or unreadable event buses remain unavailable and safe to dispose", async () => {
  const wait = createAgentWait(undefined)
  wait.input("rpc")
  expect(await wait.wait({ timeoutMs: 10 })).toMatchObject({ reason: "unavailable" })
  expect(() => {
    wait.dispose()
    wait.dispose()
  }).not.toThrow()
  for (const events of [
    undefined,
    {
      get on() {
        throw new Error("unreadable bus")
      },
    },
  ]) {
    const pi = { events } as unknown as ExtensionAPI
    expect(() => {
      const guard = registerAgentWait(pi, false, "1.5.0")
      guard.enable()
      guard.disable()
      guard.disable()
    }).not.toThrow()
  }
})

test("a restarted session suppresses a registered wait when its bus breaks and restores it when healthy", async () => {
  const handlers = new Map<string, () => void>()
  let bus: unknown = createEventBus()
  let active: string[] = []
  let tool:
    | { execute: (id: string, args: { timeout_ms?: number }) => Promise<{ details: unknown }> }
    | undefined
  const pi = {
    get events() {
      return bus
    },
    on: (name: string, handler: () => void) => handlers.set(name, handler),
    getFlag: () => true,
    getAllTools: () => [],
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => {
      active = names
    },
    registerTool: (value: typeof tool) => {
      tool = value
      active.push("wait_for_agents")
    },
  } as unknown as ExtensionAPI
  const guard = registerAgentWait(pi, false, "1.5.0")
  guard.enable()
  expect(active).toContain("wait_for_agents")
  handlers.get("session_shutdown")?.()
  bus = { on: () => undefined }
  handlers.get("session_start")?.()
  guard.enable()
  expect(active).not.toContain("wait_for_agents")
  expect((await tool!.execute("1", { timeout_ms: 10 })).details).toMatchObject({
    reason: "unavailable",
  })
  handlers.get("session_shutdown")?.()
  bus = undefined
  handlers.get("session_start")?.()
  guard.enable()
  expect(active).not.toContain("wait_for_agents")
  expect((await tool!.execute("missing", { timeout_ms: 10 })).details).toMatchObject({
    reason: "unavailable",
  })
  handlers.get("session_shutdown")?.()
  const restored = createEventBus()
  bus = restored
  handlers.get("session_start")?.()
  guard.enable()
  expect(active).toContain("wait_for_agents")
  restored.emit("subagents:ready", {})
  restored.emit("subagents:started", { id: "a" })
  restored.emit("subagents:completed", { id: "a" })
  expect((await tool!.execute("2", { timeout_ms: 10 })).details).toMatchObject({
    reason: "agent",
    id: "a",
  })
  handlers.get("session_shutdown")?.()
})

test("untrusted workflow events do not establish workflow completion", async () => {
  const bus = createEventBus()
  const handlers = new Map<string, (event: { toolName: string }) => void>()
  let tool:
    | { execute: (id: string, args: { timeout_ms?: number }) => Promise<{ details: unknown }> }
    | undefined
  const pi = {
    events: bus,
    on: (name: string, handler: (event: { toolName: string }) => void) =>
      handlers.set(name, handler),
    getFlag: () => true,
    getAllTools: () => [],
    getActiveTools: () => [],
    registerTool: (value: typeof tool) => {
      tool = value
    },
  } as unknown as ExtensionAPI
  const guard = registerAgentWait(pi, false, "1.5.0")
  guard.enable()
  bus.emit("subagents:ready", {})
  bus.emit("subagents:started", { id: "top-level" })
  handlers.get("tool_call")?.({ toolName: "subagent_workflow" })
  expect((await tool!.execute("1", { timeout_ms: 10 })).details).toMatchObject({
    reason: "unavailable",
  })
  bus.emit("subagents:workflow:completed", { id: "anything" })
  handlers.get("tool_result")?.({ toolName: "subagent_workflow" })
  expect((await tool!.execute("2", { timeout_ms: 10 })).details).toMatchObject({
    reason: "unavailable",
  })
  bus.emit("subagents:completed", { id: "top-level" })
  expect((await tool!.execute("3", { timeout_ms: 10 })).details).toMatchObject({
    reason: "agent",
    id: "top-level",
  })
  expect((await tool!.execute("4", { timeout_ms: 10 })).details).toMatchObject({
    reason: "unavailable",
  })
  handlers.get("session_shutdown")?.({ toolName: "" })
})
