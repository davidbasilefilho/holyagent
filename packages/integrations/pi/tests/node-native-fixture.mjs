import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const spawned = []
const originalSpawn = childProcess.spawn
childProcess.spawn = (program, args, options) => {
  spawned.push([program, ...(args ?? [])])
  return originalSpawn(program, args, options)
}
syncBuiltinESMExports()
const {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createCodemodeExtension,
  SessionManager,
} = await import("@earendil-works/pi-coding-agent")
const { registerNativeTools, NATIVE_ROOT_FLAG } = await import(pathToFileURL(process.argv[2]).href)
const { setup, Shell } = await import("@holyagent/core")
const { Effect, Layer, Option } = await import("effect")
const { Type } = await import("typebox")
const cwd = process.argv[3]
const repository = childProcess.spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
  encoding: "utf8",
})
assert.notEqual(
  repository.status,
  0,
  `Fixture must be outside any repository: ${repository.stdout}`,
)
const services = await createAgentSessionServices({
  cwd,
  agentDir: join(cwd, "agent"),
  extensionFlagValues: new Map([[NATIVE_ROOT_FLAG, true]]),
  resourceLoaderOptions: {
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension({ models: false }) },
      {
        name: "host-diagnostic-fixture",
        factory: (pi) =>
          pi.registerTool({
            name: "fixture_core_doctor",
            label: "Fixture Core doctor",
            description: "Exercise the direct Core diagnostic with a fake host.",
            parameters: Type.Object({}),
            exposure: "codemode",
            execute: async () => {
              const context = {
                cwd,
                env: { HOME: cwd, HOLYAGENT_HOME: cwd },
                host: "pi",
                execution: { host: "pi", ttlMinutes: 55, workflowsAvailable: false },
                authorize: (capability) => capability === "doctor.read",
              }
              const shell = Layer.succeed(Shell, {
                which: () => Effect.succeed(Option.none()),
                run: () => Effect.die("unexpected command"),
              })
              const report = await Effect.runPromise(
                setup.doctor(context, { fix: false }).pipe(Effect.provide(shell)),
              )
              return { content: [{ type: "text", text: JSON.stringify(report) }] }
            },
          }),
      },
      {
        name: "native",
        factory: (pi) => {
          const native = registerNativeTools(pi, {
            env: { ...process.env, HOME: cwd, HOLYAGENT_HOME: cwd },
          })
          pi.on("session_start", () => native.setEnabled(true))
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
  assert.equal(typeof globalThis.Bun, "undefined")
  const direct = session.getToolDefinition("holyagent_intent_create")
  assert.ok(direct)
  const created = await direct.execute(
    "direct",
    { objective: "Node direct fixture" },
    undefined,
    undefined,
    { cwd },
  )
  assert.equal(created.isError, undefined, JSON.stringify(created))
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
  const codemode = session.agent.state.tools.find((tool) => tool.name === "codemode")
  assert.ok(codemode)
  const nested = await codemode.execute("nested", {
    code: "text(await tools.holyagent_intent_list({}))",
  })
  assert.match(JSON.stringify(nested), /Node direct fixture/)
  const diagnostic = await codemode.execute("diagnostic", {
    code: "text(await tools.fixture_core_doctor({}))",
  })
  assert.match(JSON.stringify(diagnostic), /settings/)
  assert.equal(session.getToolDefinition("holyagent_doctor"), undefined)
  assert.ok(spawned.length > 0)
  assert.ok(
    spawned.every(([program]) => program === "git"),
    JSON.stringify(spawned),
  )
  console.log("Node SDK direct and codemode core tools passed; only Git subprocesses spawned")
} finally {
  session.dispose()
}
