import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import { Effect, Schema } from "effect"
import { Type } from "typebox"

import { Config } from "../../../runtime/src/config/schema.ts"
import { codexSettings } from "../src/codex.ts"
import {
  refusePrematureWebFallback,
  refuseProfileLaunch,
  refuseUnassignedWebTool,
} from "../src/extension.ts"

test("a Codex writing role under a Kimi root gets Codex tools without giving them to Kimi roles", async () => {
  const config = await Effect.runPromise(
    Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })({
      pi: { routes: { "Worker.integration": { provider: "openai-codex" } } },
    }),
  )
  const settings = codexSettings(config)
  expect(settings?.applyPatchAgents).toContain("worker-integration")
  expect(settings?.applyPatchAgents).not.toContain("worker-implementation")
})

test("explicit fallback and enabled native search remain callable independently of the model", () => {
  const registered = ["moonshot_search", "web_search"]
  const active = ["moonshot_search", "web_search"]
  expect(
    refusePrematureWebFallback({ toolName: "web_search" }, "pi-web-kit", registered, active),
  ).toBeUndefined()
  expect(
    refusePrematureWebFallback({ toolName: "moonshot_search" }, "pi-web-kit", registered, active),
  ).toBeUndefined()
  // The native tool's own OAuth, denial, and network errors are returned to its caller; they do
  // not mutate this inventory or turn on another provider.
  expect(
    refusePrematureWebFallback({ toolName: "web_search" }, "provider", registered, active)?.block,
  ).toBe(true)
})

test("explicit fallback remains available when native exposure is unknown or disabled", () => {
  expect(
    refusePrematureWebFallback({ toolName: "web_search" }, "pi-web-kit", [], []),
  ).toBeUndefined()
  expect(
    refusePrematureWebFallback({ toolName: "web_search" }, "pi-web-kit", ["moonshot_search"], []),
  ).toBeUndefined()
  expect(refusePrematureWebFallback({ toolName: "web_search" }, "provider", [], [])?.block).toBe(
    true,
  )
  expect(
    refusePrematureWebFallback(
      { toolName: "moonshot_search" },
      "off",
      ["moonshot_search"],
      ["moonshot_search"],
    )?.block,
  ).toBe(true)
  expect(
    refuseUnassignedWebTool({ toolName: "moonshot_search" }, "worker-implementation")?.block,
  ).toBe(true)
  expect(
    refuseUnassignedWebTool({ toolName: "moonshot_search" }, "librarian-lookup"),
  ).toBeUndefined()
})

test("profile launch gates require exact available provider/model and refuse both workflow names", () => {
  const registry = { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6.1-sol" }] }
  for (const toolName of ["Agent", "agent"]) {
    expect(
      refuseProfileLaunch(
        { toolName, input: { model: "openai-codex/gpt-6.1-sol" } },
        true,
        registry,
      ),
    ).toBeUndefined()
    expect(
      refuseProfileLaunch({ toolName, input: { model: "kimi-coding/gpt-6.1-sol" } }, true, registry)
        ?.block,
    ).toBe(true)
    expect(refuseProfileLaunch({ toolName, input: {} }, true, registry)?.block).toBe(true)
    expect(
      refuseProfileLaunch(
        { toolName, input: { model: "openai-codex/gpt-6.1-sol" } },
        true,
        undefined,
      )?.block,
    ).toBe(true)
    expect(
      refuseProfileLaunch({ toolName, input: { model: "anything" } }, false, undefined),
    ).toBeUndefined()
  }
  for (const toolName of ["SubagentWorkflow", "subagent_workflow"]) {
    expect(refuseProfileLaunch({ toolName, input: {} }, true, registry)?.block).toBe(true)
    expect(refuseProfileLaunch({ toolName, input: {} }, false, registry)).toBeUndefined()
  }
})

test("real Pi codemode nested calls cannot use wrong-provider fallback", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "holyagent-route-sdk-"))
  try {
    const services = await createAgentSessionServices({
      cwd,
      agentDir: join(cwd, "agent"),
      resourceLoaderOptions: {
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          { name: "codemode", factory: createCodemodeExtension({ models: false }) },
          {
            name: "routing-gate",
            factory: (pi) => {
              for (const name of ["Agent", "agent", "SubagentWorkflow", "subagent_workflow"])
                pi.registerTool({
                  name,
                  label: name,
                  description: "fixture",
                  parameters: Type.Object({ model: Type.Optional(Type.String()) }),
                  execute: () =>
                    Promise.resolve({
                      content: [{ type: "text", text: "fixture ran" }],
                      details: {},
                    }),
                })
              pi.on("tool_call", (event) =>
                refuseProfileLaunch(event, true, {
                  getAvailable: () => [{ provider: "openai-codex", id: "gpt-6.1-sol" }],
                }),
              )
            },
          },
        ],
      },
    })
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
    })
    await session.bindExtensions({ onError: () => {} })
    try {
      session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"])
      session.agent.state.messages.push({
        role: "assistant",
        content: [],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: Date.now(),
      })
      const tool = session.agent.state.tools.find((entry) => entry.name === "codemode")
      if (tool === undefined) throw new Error("codemode unavailable")
      const runCode = (code: string) => tool.execute("parent", { code })
      expect(
        JSON.stringify(
          await runCode('text(await tools.Agent({ model: "openai-codex/gpt-6.1-sol" }))'),
        ),
      ).toContain("fixture ran")
      expect(
        JSON.stringify(
          await runCode(
            'try { await tools.agent({ model: "kimi-coding/gpt-6.1-sol" }) } catch (error) { text(String(error)) }',
          ),
        ),
      ).toContain("not available")
      expect(
        JSON.stringify(
          await runCode(
            "try { await tools.subagent_workflow({}) } catch (error) { text(String(error)) }",
          ),
        ),
      ).toContain("requires direct Agent")
    } finally {
      session.dispose()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}, 15000)
