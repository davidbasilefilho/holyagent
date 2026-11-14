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
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionToolContext,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"
import { Type } from "typebox"

import { refuseNonSpecialist, refuseNonSpecialistWorkflow } from "../src/extension.ts"
import { registerToolAliases } from "../src/tool-aliases.ts"

let fixtureRoot: string
beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), "holyagent-events-test-"))
  if (spawnSync("git", ["-C", fixtureRoot, "rev-parse", "--show-toplevel"]).status === 0)
    throw new Error("fixture is inside a Git worktree")
})
afterEach(() => rm(fixtureRoot, { recursive: true, force: true }))

const sourceInfo = {
  path: "<fixture>",
  source: "npm:@tintinweb/pi-subagents@0.23.2",
  scope: "temporary" as const,
  origin: "package" as const,
}
const info = (name: string, exposure: ToolInfo["exposure"] = "direct"): ToolInfo => ({
  name,
  description: "original",
  parameters: Type.Object({ message: Type.String() }),
  exposure,
  sourceInfo:
    name === "fff-multi-grep"
      ? { ...sourceInfo, source: "npm:@ff-labs/pi-fff@0.11.0" }
      : sourceInfo,
})
const host = (initial: ToolInfo[], active: string[], allowed: () => boolean = () => true) => {
  const tools = [...initial]
  const definitions: ToolDefinition[] = []
  const pi = {
    getAllTools: () => tools,
    getActiveTools: () => active,
    registerTool: (tool: ToolDefinition) => {
      definitions.push(tool)
      tools.push({ ...tool, exposure: tool.exposure ?? "direct", sourceInfo })
    },
  } as unknown as ExtensionAPI
  registerToolAliases(pi, allowed)
  return { definitions, tools, active }
}

test("unknown Pi host versions leave original names untouched", () => {
  const registered: string[] = []
  const pi = {
    getAllTools: () => [info("Agent")],
    getActiveTools: () => ["Agent"],
    registerTool: (tool: ToolDefinition) => registered.push(tool.name),
  } as unknown as ExtensionAPI
  expect(
    registerToolAliases(
      pi,
      () => true,
      () => true,
      "unknown",
    ),
  ).toEqual([])
  expect(registered).toEqual([])
})

test("alias forwards the original schema, signal, updates and error status through executeTool", async () => {
  const target = info("Agent")
  const { definitions } = host([target], ["Agent"])
  const alias = definitions[0]
  expect(alias?.name).toBe("agent")
  expect(alias?.parameters).toEqual(target.parameters)
  const signal = new AbortController().signal
  const partial = () => {}
  let observed: unknown
  const context = {
    executeTool: (name: string, args: unknown, options: unknown) => {
      observed = { name, args, options }
      return Promise.resolve({
        result: { content: [{ type: "text", text: "denied" }], details: { origin: "target" } },
        isError: true,
      })
    },
  } as unknown as ExtensionToolContext
  const result = await alias!.execute("1", { message: "x" }, signal, partial, context)
  expect(observed).toEqual({
    name: "Agent",
    args: { message: "x" },
    options: { signal, onUpdate: partial },
  })
  expect(result).toMatchObject({ isError: true, details: { origin: "target" } })
})

test("collision, model-only, inactive direct and a disappearing target fail closed", async () => {
  expect(host([info("Agent"), info("agent")], ["Agent"]).definitions).toHaveLength(0)
  expect(host([info("Agent", "model-only")], ["Agent"]).definitions).toHaveLength(0)
  expect(host([info("Agent")], []).definitions).toHaveLength(0)
  expect(
    host(
      [
        {
          ...info("Agent"),
          sourceInfo: { ...sourceInfo, source: "npm:@tintinweb/pi-subagents@0.24.0" },
        },
      ],
      ["Agent"],
    ).definitions,
  ).toHaveLength(0)
  const source = host([info("fff-multi-grep", "deferred")], [])
  const alias = source.definitions[0]
  expect(alias?.name).toBe("fff_multi_grep")
  source.tools[0] = {
    ...info("fff-multi-grep", "deferred"),
    sourceInfo: { ...info("fff-multi-grep").sourceInfo, path: "<replacement>" },
  }
  const changed = await alias!.execute("1", {}, undefined, undefined, {} as ExtensionToolContext)
  expect(changed.isError).toBe(true)
  source.tools.shift()
  const result = await alias!.execute("1", {}, undefined, undefined, {} as ExtensionToolContext)
  expect(result.isError).toBe(true)
})

test("a previously registered alias refuses calls after the integration is disabled", async () => {
  let enabled = true
  const { definitions } = host([info("Agent")], ["Agent"], () => enabled)
  enabled = false
  const result = await definitions[0]!.execute(
    "1",
    { message: "x" },
    undefined,
    undefined,
    {} as ExtensionToolContext,
  )
  expect(result.isError).toBe(true)
  expect(JSON.stringify(result.content)).toContain("disabled or unavailable")
})

test("canonical gates apply to aliases and originals", async () => {
  for (const toolName of ["Agent", "agent"])
    expect(refuseNonSpecialist({ toolName, input: { subagent_type: "untrusted" } })?.block).toBe(
      true,
    )
  for (const toolName of ["SubagentWorkflow", "subagent_workflow"])
    expect(
      (
        await Effect.runPromise(
          refuseNonSpecialistWorkflow({
            toolName,
            input: { script: "await agent('x', { agentType: dynamic })" },
          }),
        )
      )?.block,
    ).toBe(true)
})

test("Pi SDK runs the alias and nested original through independent tool hooks", async () => {
  for (const deny of ["none", "target", "alias", "schema", "throw", "disabled"] as const) {
    const hooks: string[] = []
    let calls = 0
    let enabled = true
    let nestedSignal: AbortSignal | undefined
    const updates: string[] = []
    const settingsManager = SettingsManager.inMemory()
    const loader = new DefaultResourceLoader({
      cwd: fixtureRoot,
      agentDir: join(fixtureRoot, "agent"),
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "Agent",
            label: "Agent",
            description: "fixture",
            parameters: Type.Object({ message: Type.String() }),
            execute: (_id, _params, signal, onUpdate) => {
              calls++
              nestedSignal = signal
              if (deny === "throw") return Promise.reject(new Error("target failed"))
              onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} })
              return Promise.resolve({
                content: [{ type: "text" as const, text: "original result" }],
                details: { ok: true },
              })
            },
          })
          pi.on("tool_call", (event) => {
            hooks.push(event.toolName)
            return (deny === "target" && event.toolName === "Agent") ||
              (deny === "alias" && event.toolName === "agent")
              ? { block: true, reason: `${deny} denied` }
              : undefined
          })
          pi.on("session_start", () => {
            registerToolAliases(
              pi,
              () => enabled,
              () => true,
            )
          })
        },
      ],
    })
    await loader.reload()
    const runtime = await ModelRuntime.create({
      authPath: join(fixtureRoot, "agent", "auth.json"),
      modelsPath: join(fixtureRoot, "agent", "models.json"),
    })
    runtime.registerProvider("mock-alias", {
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
    const model: Model<"openai-completions"> = {
      id: "mock",
      name: "mock",
      api: "openai-completions",
      provider: "mock-alias",
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
    await session.bindExtensions({})
    if (deny === "disabled") enabled = false
    expect(session.getAllTools().map((tool) => tool.name)).toContain("Agent")
    expect(session.getCallableToolNames()).toContain("Agent")
    expect(session.getActiveToolNames()).toContain("agent")
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_update") updates.push(JSON.stringify(event.partialResult))
    })
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
                name: "agent",
                arguments:
                  deny === "schema" ? { message: { invalid: true } } : { message: "hello" },
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
      queueMicrotask(() =>
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message }),
      )
      return stream
    }
    await session.prompt("start")
    expect(hooks).toEqual(
      deny === "schema"
        ? []
        : deny === "alias" || deny === "disabled"
          ? ["agent"]
          : ["agent", "Agent"],
    )
    expect(calls).toBe(deny === "none" || deny === "throw" ? 1 : 0)
    if (deny === "none") {
      expect(nestedSignal).toBeInstanceOf(AbortSignal)
      expect(updates.some((update) => update.includes("partial"))).toBe(true)
    }
    const result = session.messages.find((message) => message.role === "toolResult")
    expect(result).toMatchObject({ isError: deny !== "none" })
    if (deny !== "schema")
      expect(JSON.stringify(result)).toContain(
        deny === "none"
          ? "original result"
          : deny === "throw"
            ? "target failed"
            : deny === "disabled"
              ? "disabled or unavailable"
              : `${deny} denied`,
      )
    unsubscribe()
    session.dispose()
  }
})
