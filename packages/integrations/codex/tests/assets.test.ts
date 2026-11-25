import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { version } from "../../../../package.json" with { type: "json" }
import { ROUTES } from "../../../core/src/domain/route.ts"
import {
  CODEX_MARKETPLACE,
  CODEX_PLUGIN,
  codexMarketplaceFiles,
  codexRoleFiles,
} from "../src/assets.ts"
import { CODEX_STARTUP_MARKETPLACE, codexStartupConfig, stageCodexStartup } from "../src/startup.ts"

test("the local marketplace points at the one packaged skill and release-versioned plugin", () => {
  const files = new Map(codexMarketplaceFiles().map(({ path, content }) => [path, content]))
  const plugin = "plugins/holyagent"
  expect(files.size).toBe(3)
  expect(JSON.parse(files.get(".agents/plugins/marketplace.json") ?? "")).toMatchObject({
    name: CODEX_MARKETPLACE,
    plugins: [{ name: "holyagent", source: { source: "local", path: `./${plugin}` } }],
  })
  expect(JSON.parse(files.get(`${plugin}/.codex-plugin/plugin.json`) ?? "")).toMatchObject({
    name: "holyagent",
    version,
    skills: "./skills/",
  })
  const skill = files.get(`${plugin}/skills/holyagent-workflow/SKILL.md`)
  expect(skill).toContain("Handle a straightforward change or answer directly.")
  expect(skill).toContain("Keep writes disjoint and reviews independent")
  expect(skill).not.toMatch(/holyagent-cli|openai-codex\/|AskUserQuestion|wait_agent/)
})

test("the native role files project the shared catalog and preserve host settings", () => {
  const files = codexRoleFiles()
  expect(files.map(({ path }) => path)).toEqual(
    ROUTES.map(({ agent }) => `agents/holyagent-${agent}.toml`),
  )
  expect(new Set(files.map(({ path }) => path)).size).toBe(ROUTES.length)
  const parsed = files.map(({ content }) => Bun.TOML.parse(content) as Record<string, string>)
  for (const [index, config] of parsed.entries()) {
    expect(config.name).toBe(`holyagent-${ROUTES[index]?.agent}`)
    expect(config.model).toBe("gpt-6.2-sol")
    expect(config.model_reasoning_effort).toMatch(/^(low|medium|high)$/)
    expect(config.developer_instructions).toContain(config.description ?? "")
    expect(Object.keys(config).sort()).toEqual([
      "description",
      "developer_instructions",
      "model",
      "model_reasoning_effort",
      "name",
    ])
  }
  const profile = (name: string) => parsed.find((config) => config.name === `holyagent-${name}`)
  expect(profile("explorer-lookup")?.model_reasoning_effort).toBe("low")
  expect(profile("worker-implementation")?.model_reasoning_effort).toBe("medium")
  expect(profile("reviewer-security")?.model_reasoning_effort).toBe("high")
  expect(profile("reviewer-security")?.developer_instructions).toContain("Review independently")
})

const codex = Bun.env.HOLYAGENT_TEST_CODEX

test("new startup profiles disable delegation at the native common entry point", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "holyagent-codex-stage-"))
  try {
    await Bun.write(join(scratch, "config.toml"), "# original profile\n")
    const profile = await Effect.runPromise(stageCodexStartup(scratch))
    expect(profile).not.toBe(scratch)
    expect(await Bun.file(join(scratch, "config.toml")).text()).toBe("# original profile\n")
    const config = await Bun.file(join(profile, "config.toml")).text()
    expect(config).toBe(codexStartupConfig())
    expect(Bun.TOML.parse(config)).toEqual({
      model: "gpt-6.2-sol",
      model_reasoning_effort: "medium",
      agents: { enabled: false, max_depth: 1 },
      features: {
        multi_agent_v2: false,
        default_mode_request_user_input: true,
        context_management: true,
      },
    })
    expect(await Bun.file(join(profile, "agents", "holyagent-reviewer-code.toml")).exists()).toBe(
      true,
    )
    expect(await Bun.file(join(profile, "auth.json")).exists()).toBe(false)
    await expect(Effect.runPromise(stageCodexStartup("relative"))).rejects.toThrow()
    await expect(Effect.runPromise(stageCodexStartup(scratch, "relative.json"))).rejects.toThrow()
    const changed = join(scratch, "changed.json")
    await Bun.write(changed, '{"models":[{"slug":"gpt-6.2-sol","multi_agent_version":"v2"}]}')
    expect(await Effect.runPromise(Effect.flip(stageCodexStartup(scratch, changed)))).toMatchObject(
      {
        detail: "Expected the unmodified Codex 0.172.0 catalog",
      },
    )
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test("the optional V1 profile exposes the root namespace and withholds V2 native tools", () => {
  expect(Bun.TOML.parse(codexStartupConfig("/staging/root-only-models.json"))).toEqual({
    model: "gpt-6.2-sol",
    model_reasoning_effort: "medium",
    model_catalog_json: "/staging/root-only-models.json",
    agents: { enabled: true, max_depth: 1 },
    features: {
      default_mode_request_user_input: true,
      context_management: true,
      multi_agent_v2: { enabled: false, disable_native_tools: true },
      code_mode: { direct_only_tool_namespaces: ["multi_agent_v1"] },
    },
  })
})

test.skipIf(codex === undefined)(
  "native Codex loads the packaged skill and disabled delegation from a staged profile",
  async () => {
    if (codex === undefined)
      throw new Error("Set HOLYAGENT_TEST_CODEX to the installed Codex executable")
    const scratch = await mkdtemp(join(tmpdir(), "holyagent-native-codex-"))
    try {
      const home = join(scratch, "home")
      const codexHome = await Effect.runPromise(stageCodexStartup(scratch))
      const cwd = join(scratch, "project")
      const marketplace = join(codexHome, CODEX_STARTUP_MARKETPLACE)
      await mkdir(home)
      await mkdir(cwd)
      const run = async (...args: string[]): Promise<string> => {
        const result = await $`${codex} ${args}`
          .cwd(cwd)
          .env({
            HOME: home,
            CODEX_HOME: codexHome,
            PATH: Bun.env.PATH,
            TERM: "dumb",
            HTTP_PROXY: "http://127.0.0.1:1",
            HTTPS_PROXY: "http://127.0.0.1:1",
            ALL_PROXY: "http://127.0.0.1:1",
          })
          .quiet()
          .nothrow()
        expect(result.exitCode, result.stderr.toString()).toBe(0)
        return result.text()
      }
      expect(await run("--version")).toContain("codex-cli 0.172.0")
      expect(
        JSON.parse(await run("plugin", "marketplace", "add", marketplace, "--json")),
      ).toMatchObject({
        marketplaceName: CODEX_MARKETPLACE,
      })
      expect(JSON.parse(await run("plugin", "add", CODEX_PLUGIN, "--json"))).toMatchObject({
        pluginId: CODEX_PLUGIN,
        version,
      })
      const prompt = JSON.stringify(
        JSON.parse(await run("debug", "prompt-input", "Check the scope")),
      )
      expect(prompt).toContain("holyagent:holyagent-workflow")
      expect(prompt).not.toContain("spawn_agent")
      const features = await run("features", "list")
      expect(features).toMatch(/^default_mode_request_user_input[ \t]+[^\r\n]+[ \t]+true$/m)
      expect(features).toMatch(/^context_management[ \t]+[^\r\n]+[ \t]+true$/m)
      expect(features).toMatch(/^multi_agent_v2[ \t]+[^\r\n]+[ \t]+false$/m)
      expect(await Bun.file(join(codexHome, "auth.json")).exists()).toBe(false)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  },
  60_000,
)
