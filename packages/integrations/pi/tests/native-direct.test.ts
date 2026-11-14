import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  type ExtensionAPI,
  SessionManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { COMMANDS } from "../../../runtime/src/cli/commands.ts"
import { run } from "../../../runtime/src/cli/program.ts"
import { CAPABILITIES, inventory } from "../../../runtime/src/native/catalog.ts"
import { createExtension } from "../src/extension.ts"
import { NATIVE_ROOT_FLAG, type NativeTools, registerNativeTools } from "../src/native-tools.ts"

const assertOutsideGit = (cwd: string) => {
  expect(spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"]).status).not.toBe(0)
}

describe("direct native operation boundaries", () => {
  test("the complete CLI inventory is explicitly classified", () => {
    for (const command of COMMANDS) expect(CAPABILITIES[command.path.join(" ")]).toBeDefined()
    expect(inventory(false)).toEqual([])
    expect(inventory(true)).toContain("handoff")
  })

  test("actual SDK and codemode invoke direct core, revoke, and deny child flags", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "holyagent-native-sdk-"))
    try {
      assertOutsideGit(cwd)
      let rootTools: NativeTools | undefined
      const build = async (root: boolean) => {
        const services = await createAgentSessionServices({
          cwd,
          agentDir: join(cwd, "agent"),
          ...(root ? { extensionFlagValues: new Map([[NATIVE_ROOT_FLAG, true]]) } : {}),
          resourceLoaderOptions: {
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              { name: "codemode", factory: createCodemodeExtension({ models: false }) },
              {
                name: "native",
                factory: (pi) => {
                  const native = registerNativeTools(pi, {
                    env: { ...process.env, HOME: cwd, HOLYAGENT_HOME: cwd },
                  })
                  if (root) rootTools = native
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
        await session.bindExtensions({ onError: () => {} })
        return session
      }
      const root = await build(true)
      const child = await build(false)
      child.setSessionName("root#forged")
      try {
        expect(root.getCallableToolNames()).toContain("holyagent_intent_create")
        expect(child.getCallableToolNames()).not.toContain("holyagent_intent_create")
        root.setActiveToolsByName([...root.getActiveToolNames(), "codemode"])
        root.agent.state.messages.push({
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
        const code = root.agent.state.tools.find((tool) => tool.name === "codemode")
        if (code === undefined) throw new Error("codemode unavailable")
        expect(
          JSON.stringify(
            await code.execute("parent", {
              code: 'text(await tools.holyagent_intent_create({objective:"SDK fixture"}))',
            }),
          ),
        ).toContain("intent-")
        expect(
          JSON.stringify(
            await code.execute("parent", { code: "text(await tools.holyagent_intent_list({}))" }),
          ),
        ).toContain("SDK fixture")
        expect(
          JSON.stringify(
            await code.execute("parent", {
              code: 'try { await tools.holyagent_intent_create({objective:"bad",extra:true}) } catch(e) { text(String(e)) }',
            }),
          ),
        ).toContain("excess")
        expect(
          JSON.stringify(
            await code.execute("parent", {
              code: 'try { await tools.holyagent_state_mode({mode:"local"}) } catch(e) { text(String(e)) }',
            }),
          ),
        ).toContain("approval")
        const controller = new AbortController()
        controller.abort()
        const preCancelled = await root
          .getToolDefinition("holyagent_intent_create")
          ?.execute("cancelled", { objective: "cancelled fixture" }, controller.signal, undefined, {
            cwd,
          } as never)
        expect(preCancelled?.isError).toBe(true)
        expect(
          JSON.stringify(
            await code.execute("parent", { code: "text(await tools.holyagent_intent_list({}))" }),
          ),
        ).not.toContain("cancelled fixture")
        const stale = root.getToolDefinition("holyagent_intent_list")
        rootTools?.setEnabled(false)
        expect(root.getCallableToolNames()).not.toContain("holyagent_intent_list")
        const denied = await stale?.execute("stale", {}, undefined, undefined, { cwd } as never)
        expect(denied?.isError).toBe(true)
        await root.reload()
        await child.reload()
        expect(root.getCallableToolNames()).toContain("holyagent_intent_create")
        expect(child.getCallableToolNames()).not.toContain("holyagent_intent_create")
      } finally {
        root.dispose()
        child.dispose()
      }
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 15000)

  test("CLI and native operations preserve the same lifecycle on isolated projects", async () => {
    const left = await mkdtemp(join(tmpdir(), "holyagent-parity-cli-"))
    const right = await mkdtemp(join(tmpdir(), "holyagent-parity-native-"))
    try {
      assertOutsideGit(left)
      assertOutsideGit(right)
      const tools = new Map<string, ToolDefinition>()
      const pi = {
        registerFlag: () => undefined,
        getFlag: (name: string) => name === NATIVE_ROOT_FLAG,
        getActiveTools: () => [],
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      } as unknown as ExtensionAPI
      const native = registerNativeTools(pi, {
        env: { ...process.env, HOME: right, HOLYAGENT_HOME: right },
      })
      native.setEnabled(true)
      const call = async (name: string, input: object) => {
        const result = await tools
          .get(`holyagent_${name}`)
          ?.execute("parity", input, undefined, undefined, { cwd: right } as never)
        if (result === undefined || result.isError) throw new Error(JSON.stringify(result))
        return (result.details as { ok: true; data: Record<string, unknown> }).data
      }
      const cli = async (args: string[], data?: unknown) => {
        const result = await Effect.runPromise(
          run(args, {
            cwd: left,
            env: { ...process.env, HOME: left, HOLYAGENT_HOME: left, HOLYAGENT_HOST: "pi" },
            stdin: Effect.succeed(data === undefined ? "" : JSON.stringify(data)),
          }),
        )
        if (result.code !== 0) throw new Error(result.stderr)
        return result.stdout
      }
      const cliIntent = await cli(["intent", "create"], { objective: "Parity fixture" })
      const nativeIntent = await call("intent_create", { objective: "Parity fixture" })
      expect(cliIntent).toContain("objective: Parity fixture")
      expect(nativeIntent).toMatchObject({
        objective: "Parity fixture",
        state: "Open",
        revision: 1,
      })
      const draft = {
        roleTask: "Reviewer.testing",
        objective: "Compare paths",
        criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
      }
      const cliAssignment = await cli(["assignment", "create"], draft)
      const nativeAssignment = await call("assignment_create", draft)
      expect(cliAssignment).toContain("state: Ready")
      expect(nativeAssignment).toMatchObject({
        state: "Ready",
        objective: draft.objective,
        roleTask: draft.roleTask,
      })
      const id = /id: (assignment-[a-z0-9-]+)/.exec(cliAssignment)?.[1]
      if (id === undefined) throw new Error(cliAssignment)
      const cliShown = await cli(["assignment", "show", id, "--full"])
      const nativeShown = await call("assignment_show", { id: nativeAssignment.id })
      expect(cliShown).toContain("objective: Compare paths")
      expect(nativeShown).toMatchObject({
        state: "Ready",
        objective: draft.objective,
        roleTask: draft.roleTask,
      })
      await native.shutdown()
    } finally {
      await rm(left, { recursive: true, force: true })
      await rm(right, { recursive: true, force: true })
    }
  })

  test("Node bundle executes direct and codemode tools without spawning the CLI", async () => {
    const local = await mkdtemp(join(tmpdir(), "holyagent-native-node-host-"))
    const project = await mkdtemp(join(tmpdir(), "holyagent-native-node-project-"))
    try {
      assertOutsideGit(local)
      assertOutsideGit(project)
      for (const peer of [
        "@holyagent/core",
        "@earendil-works/pi-coding-agent",
        "effect",
        "typebox",
      ]) {
        const directory = join(local, "node_modules", peer)
        await mkdir(directory, { recursive: true })
        await writeFile(
          join(directory, "package.json"),
          JSON.stringify({ type: "module", exports: "./index.js" }),
        )
        const target = pathToFileURL(Bun.resolveSync(peer, import.meta.dir)).href
        await writeFile(join(directory, "index.js"), `export * from ${JSON.stringify(target)}\n`)
      }
      const runner = join(local, "fixture.mjs")
      await copyFile(join(import.meta.dir, "node-native-fixture.mjs"), runner)
      const built = await Bun.build({
        entrypoints: [fileURLToPath(new URL("../src/native-tools.ts", import.meta.url))],
        target: "node",
        format: "esm",
        external: ["@earendil-works/pi-coding-agent"],
      })
      if (!built.success || built.outputs[0] === undefined)
        throw new Error(JSON.stringify(built.logs))
      const bundle = join(local, "native.mjs")
      await writeFile(bundle, await built.outputs[0].text())
      const result = spawnSync("node", [runner, bundle, project], {
        encoding: "utf8",
        env: { ...process.env, HOME: project, HOLYAGENT_HOME: project },
      })
      if (result.status !== 0) throw new Error(result.stderr || result.stdout)
      expect(result.status).toBe(0)
      expect(result.stderr).toBe("")
      expect(result.stdout).toContain("only Git subprocesses spawned")
    } finally {
      await rm(project, { recursive: true, force: true })
      await rm(local, { recursive: true, force: true })
    }
  }, 20000)

  test("session registration requires both readable enabled configurations", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "holyagent-native-config-"))
    try {
      assertOutsideGit(cwd)
      const project = join(cwd, "project")
      const home = join(cwd, "home")
      const userConfig = join(home, ".holyagent", "config.json")
      const projectConfig = join(project, ".holyagent", "config.json")
      await mkdir(join(home, ".holyagent"), { recursive: true })
      await mkdir(join(project, ".holyagent"), { recursive: true })
      let flag = true
      const tools = new Map<string, ToolDefinition>()
      const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
      const fake = new Proxy(
        {
          getFlag: (name: string) => (name === NATIVE_ROOT_FLAG ? flag : undefined),
          registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
          on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
            handlers.set(name, [...(handlers.get(name) ?? []), handler]),
          getActiveTools: () => [],
          getAllTools: () => [],
          getSessionName: () => undefined,
          exec: (program: string) =>
            Promise.resolve(
              program === "git"
                ? {
                    stdout: "",
                    stderr: "fatal: not a git repository",
                    code: 128,
                    killed: false,
                    truncated: false,
                  }
                : { stdout: "", stderr: "unavailable", code: 1, killed: false, truncated: false },
            ),
        },
        {
          get: (target, key): unknown =>
            key in target ? (Reflect.get(target, key) as unknown) : () => undefined,
        },
      ) as unknown as ExtensionAPI
      createExtension({
        env: { ...process.env, HOME: home, HOLYAGENT_HOME: home },
        packageRoot: cwd,
      })(fake)
      const emit = async (name: string, event: unknown) => {
        for (const handler of handlers.get(name) ?? []) await handler(event, { cwd: project })
      }
      await writeFile(userConfig, JSON.stringify({ pi: { enable: true } }))
      await writeFile(projectConfig, JSON.stringify({ pi: { enable: false } }))
      await emit("session_start", { reason: "startup" })
      expect(tools.has("holyagent_status")).toBe(false)
      await writeFile(userConfig, JSON.stringify({ pi: { enable: false } }))
      await writeFile(projectConfig, JSON.stringify({ pi: { enable: true } }))
      await emit("session_compact", {})
      expect(tools.has("holyagent_status")).toBe(false)
      await writeFile(userConfig, "{")
      await emit("session_compact", {})
      expect(tools.has("holyagent_status")).toBe(false)
      await writeFile(userConfig, JSON.stringify({ pi: { enable: true } }))
      await writeFile(projectConfig, "{")
      await emit("session_compact", {})
      expect(tools.has("holyagent_status")).toBe(false)
      await writeFile(projectConfig, JSON.stringify({ pi: { enable: true } }))
      await emit("session_compact", {})
      expect(tools.get("holyagent_status")?.exposure).toBe("codemode")
      const stale = tools.get("holyagent_status")
      await writeFile(userConfig, JSON.stringify({ pi: { enable: false } }))
      await emit("session_compact", {})
      expect(tools.get("holyagent_status")?.exposure).toBe("hidden")
      expect(
        (await stale?.execute("stale", {}, undefined, undefined, { cwd: project } as never))
          ?.isError,
      ).toBe(true)
      await writeFile(userConfig, JSON.stringify({ pi: { enable: true } }))
      await emit("session_compact", {})
      flag = false
      const result = await tools
        .get("holyagent_status")
        ?.execute("stale", {}, undefined, undefined, { cwd: project } as never)
      expect(result?.isError).toBe(true)
      await emit("session_shutdown", {})
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }, 15000)
})
