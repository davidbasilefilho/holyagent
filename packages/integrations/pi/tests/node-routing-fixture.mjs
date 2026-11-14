import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { readdir, readFile, writeFile } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const calls = []
const spawn = childProcess.spawn
childProcess.spawn = (program, args, options) => {
  calls.push(program)
  return spawn(program, args, options)
}
syncBuiltinESMExports()
const { assignment, intent, makeContext } = await import("@holyagent/core")
const { Effect } = await import("effect")
const { Type } = await import("typebox")
const {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  SessionManager,
} = await import("@earendil-works/pi-coding-agent")
const { checkProfileLaunch, refuseProfileLaunch } = await import(
  pathToFileURL(process.argv[2]).href
)
const cwd = process.argv[3]
assert.equal(typeof globalThis.Bun, "undefined")
assert.notEqual(
  childProcess.spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).status,
  0,
)
const env = { HOME: cwd, HOLYAGENT_ROUTING_PROFILE: "fast" }
const context = await Effect.runPromise(
  makeContext({ cwd, env, host: "pi", authorize: () => true, deferRouting: true }),
)
await Effect.runPromise(intent.create(context, { objective: "Node routing fixture" }))
await writeFile(
  join(cwd, ".holyagent", "config.json"),
  JSON.stringify({ pi: { provider: "openai-codex" } }),
)
const start = async (objective) => {
  const result = await Effect.runPromise(
    assignment.dispatch(context, {
      roleTask: "Reviewer.testing",
      objective,
      criteria: [{ text: "checked", blocking: true, dimension: "behavior" }],
    }),
  )
  return {
    prompt: result.prompt,
    subagent_type: result.agent,
    model: result.launch.model,
    thinking: result.launch.effort,
  }
}
const inputs = await Promise.all([start("one"), start("two"), start("three")])
const snapshot = async (dir) =>
  (
    await Promise.all(
      (await readdir(dir, { withFileTypes: true })).map(async (entry) => {
        const path = join(dir, entry.name)
        return entry.isDirectory()
          ? snapshot(path)
          : [path + ":" + (await readFile(path)).toString("base64")]
      }),
    )
  )
    .flat()
    .sort()
const before = await snapshot(join(cwd, ".holyagent"))
calls.length = 0
const registry = {
  getAvailable: () => [
    { provider: "openai-codex", id: "gpt-6.1-terra" },
    { provider: "openai-codex", id: "gpt-6.1-sol" },
  ],
}
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
        name: "agent-fixture",
        factory: (pi) => {
          for (const name of ["Agent", "agent"])
            pi.registerTool({
              name,
              label: name,
              description: "fixture",
              parameters: Type.Object({
                prompt: Type.String(),
                subagent_type: Type.String(),
                model: Type.String(),
                thinking: Type.String(),
              }),
              execute: async () => ({ content: [{ type: "text", text: "fixture ran" }] }),
            })
          pi.on(
            "tool_call",
            (event) =>
              refuseProfileLaunch(event, true, registry) ??
              (event.toolName === "Agent" || event.toolName === "agent"
                ? Effect.runPromise(
                    checkProfileLaunch(event.input, cwd, env).pipe(
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
await session.bindExtensions({
  onError: (error) => {
    throw Error(JSON.stringify(error))
  },
})
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
  assert.ok(tool)
  const run = async (code) => JSON.stringify(await tool.execute("parent", { code }))
  const encoded = inputs.map(JSON.stringify)
  assert.match(await run(`text(await tools.Agent(${encoded[0]}))`), /fixture ran/)
  assert.match(await run(`text(await tools.agent(${encoded[1]}))`), /fixture ran/)
  assert.equal(
    (
      await run(`text(await tools.Agent(${encoded[0]})); text(await tools.agent(${encoded[1]}))`)
    ).match(/fixture ran/g)?.length,
    2,
  )
  assert.equal(
    (
      await run(`text(await Promise.all([tools.Agent(${encoded[0]}), tools.agent(${encoded[2]})]))`)
    ).match(/fixture ran/g)?.length,
    2,
  )
  assert.match(
    await run(
      `text(await tools.Agent(${JSON.stringify({ ...inputs[0], model: "openai-codex/gpt-6.1-sol" })}))`,
    ),
    /does not match/,
  )
  assert.match(
    await run(
      `text(await tools.Agent(${JSON.stringify({ ...inputs[0], subagent_type: "worker-integration" })}))`,
    ),
    /role or screen/,
  )
  assert.deepEqual(await snapshot(join(cwd, ".holyagent")), before)
  assert.ok(
    calls.every((program) => program === "git"),
    `unexpected subprocesses: ${calls}`,
  )
  console.log("Node Core-backed SDK launch checks passed")
} finally {
  session.dispose()
}
