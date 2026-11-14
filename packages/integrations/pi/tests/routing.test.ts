import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import { assignment, intent, makeContext } from "@holyagent/core"
import { Effect, Schema } from "effect"
import { Type } from "typebox"

import { Config } from "../../../runtime/src/config/schema.ts"
import { codexSettings } from "../src/codex.ts"
import {
  refusePrematureWebFallback,
  refuseProfileLaunch,
  refuseUnassignedWebTool,
} from "../src/extension.ts"
import { checkProfileLaunch } from "../src/profile-gate.ts"

test("a Codex-enabled config identifies eligible writing roles", async () => {
  const config = await Effect.runPromise(
    Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })({
      pi: { routes: { "Worker.integration": { provider: "openai-codex" } } },
    }),
  )
  const settings = codexSettings(config)
  expect(settings?.applyPatchAgents).toContain("worker-integration")
  expect(settings?.applyPatchAgents).toContain("worker-implementation")
})

test("ranked Codex writers receive patch access, but read-only roles do not", async () => {
  const config = await Effect.runPromise(
    Schema.decodeUnknownEffect(Config)({
      pi: { profile: "fast", routes: { "Worker.integration": { provider: "openai-codex" } } },
    }),
  )
  const settings = codexSettings(config)
  expect(settings?.applyPatchAgents).toContain("worker-implementation")
  expect(settings?.applyPatchAgents).not.toContain("reviewer-code")
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

const launchFixture = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "holyagent-core-routing-"))
  if (spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).status === 0)
    throw new Error("fixture is inside a git worktree")
  const env = { HOME: cwd, HOLYAGENT_ROUTING_PROFILE: "fast" }
  const context = await Effect.runPromise(
    makeContext({ cwd, env, host: "pi", authorize: () => true, deferRouting: true }),
  )
  await Effect.runPromise(intent.create(context, { objective: "routing fixture" }))
  const config = { pi: { provider: "openai-codex" } }
  await writeFile(join(cwd, ".holyagent", "config.json"), JSON.stringify(config))
  const dispatch = async (objective: string, screen = false) => {
    const result = await Effect.runPromise(
      assignment.dispatch(context, {
        roleTask: "Reviewer.testing",
        objective,
        screen,
        criteria: [{ text: "checked", blocking: true, dimension: "behavior" }],
      }),
    )
    const launch = result.assignment.specialist?.intendedLaunch
    if (launch === undefined) throw new Error("profiled launch missing")
    return { ...result, launch }
  }
  return {
    cwd,
    env,
    context,
    config,
    dispatch,
    close: () => rm(cwd, { recursive: true, force: true }),
  }
}

const contents = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry): Promise<ReadonlyArray<string>> => {
      const path = join(dir, entry.name)
      return entry.isDirectory()
        ? contents(path)
        : [path + ":" + (await readFile(path)).toString("base64")]
    }),
  )
  return nested.flat().toSorted()
}

test("Core-backed profile selection checks role, screen, state, model, effort, override and fallback without writes", async () => {
  const f = await launchFixture()
  try {
    const started = await f.dispatch("fallback")
    const input = {
      prompt: started.prompt,
      subagent_type: started.agent,
      model: started.launch.model,
      thinking: started.launch.effort,
    }
    const before = await contents(join(f.cwd, ".holyagent"))
    const check = (call: Readonly<Record<string, unknown>>) =>
      Effect.runPromise(checkProfileLaunch(call, f.cwd, f.env))
    expect(await check(input)).toBeUndefined()
    expect(await check({ ...input, model: "openai-codex/gpt-6.1-sol" })).toContain("does not match")
    expect(await check({ ...input, thinking: "low" })).toContain("does not match")
    expect(await check({ ...input, subagent_type: "worker-integration" })).toContain(
      "role or screen",
    )
    expect(await check({ ...input, subagent_type: "reviewer-testing-headless-screen" })).toContain(
      "role or screen",
    )
    expect(
      await check({
        ...input,
        prompt: "Role: Reviewer.testing (reviewer-testing). Assignment: assignment-unknown.",
      }),
    ).toContain("unavailable")
    expect(await contents(join(f.cwd, ".holyagent"))).toEqual(before)
    await writeFile(
      join(f.cwd, ".holyagent", "config.json"),
      JSON.stringify({
        pi: { provider: "openai-codex", routes: { "Reviewer.testing": { model: "gpt-6.1-sol" } } },
      }),
    )
    expect(await check(input)).toContain("stale")
    const override = await f.dispatch("override")
    expect(override.launch.model).toBe("openai-codex/gpt-6.1-sol")
    expect(
      await check({
        prompt: override.prompt,
        subagent_type: override.agent,
        model: override.launch.model,
        thinking: override.launch.effort,
      }),
    ).toBeUndefined()
    await writeFile(join(f.cwd, ".holyagent", "config.json"), JSON.stringify(f.config))
    const screen = await f.dispatch("screen", true)
    expect(
      await check({
        prompt: screen.prompt,
        subagent_type: screen.agent,
        model: screen.launch.model,
        thinking: screen.launch.effort,
      }),
    ).toBeUndefined()
    await Effect.runPromise(
      assignment.close(f.context, { id: screen.assignment.id, outcome: "failure" }),
    )
    expect(
      await check({
        prompt: screen.prompt,
        subagent_type: screen.agent,
        model: screen.launch.model,
        thinking: screen.launch.effort,
      }),
    ).toContain("no current profiled dispatch")
  } finally {
    await f.close()
  }
})

test("profile preflight requires an exact available model and refuses workflows", () => {
  const registry = { getAvailable: () => [{ provider: "openai-codex", id: "gpt-6.1-sol" }] }
  for (const toolName of ["Agent", "agent"]) {
    const input = { subagent_type: "reviewer-testing", model: "openai-codex/gpt-6.1-sol" }
    expect(refuseProfileLaunch({ toolName, input }, true, registry)).toBeUndefined()
    expect(
      refuseProfileLaunch(
        { toolName, input: { ...input, model: "kimi-coding/gpt-6.1-sol" } },
        true,
        registry,
      )?.block,
    ).toBe(true)
    expect(refuseProfileLaunch({ toolName, input }, true, undefined)?.block).toBe(true)
    expect(refuseProfileLaunch({ toolName, input: {} }, false, undefined)).toBeUndefined()
  }
  for (const toolName of ["SubagentWorkflow", "subagent_workflow"])
    expect(refuseProfileLaunch({ toolName, input: {} }, true, registry)?.block).toBe(true)
})

test("real Pi codemode nested calls cannot use wrong-provider fallback", async () => {
  const f = await launchFixture()
  const cwd = f.cwd
  const started = await f.dispatch("sdk")
  const input = {
    prompt: started.prompt,
    subagent_type: started.agent,
    model: started.launch.model,
    thinking: started.launch.effort,
  }
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
                  parameters: Type.Object({
                    model: Type.Optional(Type.String()),
                    prompt: Type.Optional(Type.String()),
                    subagent_type: Type.Optional(Type.String()),
                    thinking: Type.Optional(Type.String()),
                  }),
                  execute: () =>
                    Promise.resolve({
                      content: [{ type: "text", text: "fixture ran" }],
                      details: {},
                    }),
                })
              pi.on(
                "tool_call",
                (event) =>
                  refuseProfileLaunch(event, true, {
                    getAvailable: () => [
                      { provider: "openai-codex", id: "gpt-6.1-sol" },
                      { provider: "openai-codex", id: "gpt-6.1-terra" },
                    ],
                  }) ??
                  (event.toolName === "Agent" || event.toolName === "agent"
                    ? Effect.runPromise(
                        checkProfileLaunch(event.input, cwd, f.env).pipe(
                          Effect.map((reason) =>
                            reason === undefined ? undefined : { block: true, reason },
                          ),
                        ),
                      )
                    : undefined),
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
        JSON.stringify(await runCode(`text(await tools.Agent(${JSON.stringify(input)}))`)),
      ).toContain("fixture ran")
      expect(
        JSON.stringify(await runCode(`text(await tools.agent(${JSON.stringify(input)}))`)),
      ).toContain("fixture ran")
      expect(
        JSON.stringify(
          await runCode(
            `text(await tools.Agent(${JSON.stringify({ ...input, model: "openai-codex/gpt-6.1-sol" })}))`,
          ),
        ),
      ).toContain("does not match")
      expect(
        JSON.stringify(
          await runCode(
            `try { await tools.agent(${JSON.stringify({ ...input, model: "kimi-coding/gpt-6.1-sol" })}) } catch (error) { text(String(error)) }`,
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
    await f.close()
  }
}, 15000)

test("Node SDK uses real Core state for direct, sequential and parallel managed launches", async () => {
  const temp = await mkdtemp(join(tmpdir(), "holyagent-node-route-"))
  try {
    if (spawnSync("git", ["-C", temp, "rev-parse", "--show-toplevel"]).status === 0)
      throw new Error("fixture is inside a git worktree")
    const host = join(temp, "host")
    const cwd = join(temp, "project")
    await mkdir(join(host, "node_modules", "@holyagent"), { recursive: true })
    await mkdir(join(host, "node_modules", "@earendil-works"), { recursive: true })
    await mkdir(cwd)
    const modules = join(host, "node_modules")
    for (const [name, source] of [
      ["@holyagent/core", "../node_modules/@holyagent/core"],
      ["@earendil-works/pi-coding-agent", "../node_modules/@earendil-works/pi-coding-agent"],
      ["typebox", "../node_modules/typebox"],
      ["effect", "../../../../node_modules/effect"],
    ] as const)
      await symlink(await realpath(join(import.meta.dir, source)), join(modules, name), "dir")
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "../src/profile-gate.ts")],
      target: "node",
      format: "esm",
      external: ["effect"],
    })
    if (!built.success || built.outputs[0] === undefined)
      throw new Error(JSON.stringify(built.logs))
    const bundle = join(host, "gate.mjs")
    await writeFile(bundle, await built.outputs[0].text())
    const runner = join(host, "fixture.mjs")
    await copyFile(join(import.meta.dir, "node-routing-fixture.mjs"), runner)
    const result = spawnSync("node", [runner, bundle, cwd], {
      encoding: "utf8",
      env: { ...process.env, HOME: temp },
      timeout: 20000,
    })
    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain("Node Core-backed SDK launch checks passed")
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}, 30000)
