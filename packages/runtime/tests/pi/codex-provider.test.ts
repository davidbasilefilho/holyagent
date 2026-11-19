import { describe, expect, test } from "bun:test"

import { Effect, Schema } from "effect"

import { piPackages } from "../../src/config/packages.ts"
import { Config, KIMI_ROUTES, PROVIDER_ROUTES } from "../../src/config/schema.ts"
import { RoleTask, routeFor } from "../../src/domain/route.ts"
import { checkModelCatalog } from "../../src/pi/catalog.ts"
import { APPLY_PATCH_TOOL } from "../../src/pi/codex/apply-patch.ts"
import { CODEX_ROUTES, LUNA, SOL, TERRA } from "../../src/pi/codex/routes.ts"
import {
  providerEnv,
  providerProfile,
  PROVIDERS,
  providerSource,
  routedModels,
  routeModel,
  webChoice,
} from "../../src/pi/provider.ts"
import { type CommandRunner, providerReadiness } from "../../src/pi/readiness.ts"
import { toolArgs, toolSettings } from "../../src/pi/tools.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

const decode = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(value))

const CODEX = await decode({ pi: { provider: "openai-codex" } })

/** The approved Codex table, row by row, as `--model` values. */
const APPROVED: Readonly<Record<string, string>> = {
  root: "openai-codex/gpt-6.1-sol:high",
  "Explorer.map": "openai-codex/gpt-6-luna:low",
  "Explorer.lookup": "openai-codex/gpt-6-luna:low",
  "Librarian.lookup": "openai-codex/gpt-6-luna:low",
  "Worker.validation": "openai-codex/gpt-6-luna:low",
  "Worker.mechanical": "openai-codex/gpt-6-luna:medium",
  "Worker.operations": "openai-codex/gpt-6-luna:medium",
  "Reviewer.audit": "openai-codex/gpt-6-luna:high",
  "Explorer.trace": "openai-codex/gpt-6.1-terra:medium",
  "Librarian.research": "openai-codex/gpt-6.1-terra:medium",
  "Worker.integration": "openai-codex/gpt-6.1-terra:medium",
  "Reviewer.testing": "openai-codex/gpt-6.1-terra:medium",
  "Reviewer.artifact": "openai-codex/gpt-6.1-terra:medium",
  "Worker.implementation": "openai-codex/gpt-6.1-terra:high",
  "Reviewer.code": "openai-codex/gpt-6.1-terra:high",
  "Worker.visual": "openai-codex/gpt-6.1-terra:high",
  "Reviewer.visual": "openai-codex/gpt-6.1-terra:high",
  "Worker.debugging": "openai-codex/gpt-6.1-terra:xhigh",
  "Reviewer.security": "openai-codex/gpt-6.1-terra:xhigh",
}

describe("the Codex route table", () => {
  test("the root and each of the 18 specialists resolve to the approved model and effort", () => {
    const keys = ["root", ...RoleTask.literals] as const
    expect(keys).toHaveLength(19)
    expect(Object.fromEntries(keys.map((key) => [key, routeModel(CODEX, key).spec]))).toEqual(
      APPROVED,
    )
    expect(
      routedModels(CODEX)
        .map(({ spec }) => spec)
        .sort(),
    ).toEqual(Object.values(APPROVED).sort())
  })

  test("the root runs on Sol at high, and Luna never runs at xhigh", () => {
    expect(CODEX_ROUTES.root).toEqual({ model: SOL, thinking: "high" })
    const rows = Object.entries(CODEX_ROUTES)
    expect(rows.filter(([, row]) => row.model === LUNA).length).toBe(7)
    expect(rows.filter(([, row]) => row.model === TERRA).length).toBe(11)
    for (const [, row] of rows.filter(([, entry]) => entry.model === LUNA))
      expect(["low", "medium", "high"]).toContain(row.thinking)
  })

  test("visual work and computer use run on Terra", () => {
    for (const key of ["Worker.visual", "Reviewer.visual"] as const)
      expect(CODEX_ROUTES[key].model).toBe(TERRA)
    // Computer use is a visual-inspection tool, so the roles that hold it are the visual ones.
    const holders = RoleTask.literals.filter((roleTask) =>
      routeFor(roleTask).capabilities.includes("VisualInspection"),
    )
    expect(holders).toEqual(["Worker.visual", "Reviewer.visual"])
    for (const roleTask of holders) expect(routeModel(CODEX, roleTask).model).toBe(TERRA)
  })

  test("a partial override keeps the Codex value for the key it leaves out", async () => {
    const config = await decode({
      pi: {
        provider: "openai-codex",
        routes: { "Worker.debugging": { thinking: "high" }, root: { model: "gpt-6.1-terra" } },
      },
    })
    expect(routeModel(config, "Worker.debugging").spec).toBe("openai-codex/gpt-6.1-terra:high")
    expect(routeModel(config, "root").spec).toBe("openai-codex/gpt-6.1-terra:high")
    expect(routeModel(config, "Reviewer.security").spec).toBe("openai-codex/gpt-6.1-terra:xhigh")
  })

  test("the Kimi provider and an empty config still resolve to the Kimi table", async () => {
    expect(DEFAULT_CONFIG.pi.routes).toEqual(KIMI_ROUTES)
    const named = await decode({ pi: { provider: "kimi-coding-global" } })
    expect(named.pi.routes).toEqual(KIMI_ROUTES)
    const override = await decode({ pi: { routes: { root: { thinking: "max" } } } })
    expect(override.pi.routes.root).toEqual({ model: "k3.1-pro", thinking: "max" })
    expect(PROVIDER_ROUTES["kimi-coding-global"]).toBe(KIMI_ROUTES)
  })

  test("a route row that names an unknown key or level still does not decode", async () => {
    await expect(
      decode({ pi: { provider: "openai-codex", routes: { root: { thinking: "ultra" } } } }),
    ).rejects.toThrow()
    await expect(
      decode({ pi: { provider: "openai-codex", routes: { "Worker.unknown": { model: "x" } } } }),
    ).rejects.toThrow()
  })
})

describe("the Codex provider profile", () => {
  test("is Pi's own openai-codex provider on the GPT-6 family, with no package to pin", () => {
    const profile = providerProfile(CODEX)
    expect(profile).toMatchObject({
      id: "openai-codex",
      family: "gpt-6",
      writeTools: ["apply_patch"],
    })
    expect(profile.package).toBeUndefined()
    expect(providerSource(CODEX)).toBeUndefined()
    expect(providerEnv(CODEX)).toEqual({})
    expect(providerProfile(DEFAULT_CONFIG).family).toBe("kimi-k3.1")
    expect(PROVIDERS["kimi-coding-global"].writeTools).toEqual([])
  })

  test("selecting Codex loads no provider package or implicit fallback", () => {
    expect(piPackages(CODEX)).not.toContain(piPackages(DEFAULT_CONFIG)[0])
    expect(piPackages(CODEX)[0]).toStartWith("npm:@tintinweb/pi-subagents@")
    expect(piPackages(CODEX).filter((source) => source.includes("pi-provider-kimi-code"))).toEqual(
      [],
    )
    expect(webChoice(providerProfile(CODEX), "provider").source).toBe("provider")
    expect(piPackages(CODEX).some((source) => source.includes("pi-web-kit"))).toBe(false)
    expect(toolSettings(CODEX).some((patch) => patch.file.includes("providers/"))).toBe(false)
  })

  test("the catalog check names the route models Pi's openai-codex catalog lacks", async () => {
    const listed = [SOL, TERRA, LUNA].map((model) => ({ provider: "openai-codex", model }))
    await Effect.runPromise(checkModelCatalog(CODEX, listed))
    const failure = await Effect.runPromise(
      Effect.flip(checkModelCatalog(CODEX, listed.slice(0, 1))),
    )
    expect(failure.missing.map(({ model }) => model).sort()).toEqual([LUNA, TERRA].sort())
  })
})

describe("apply_patch beside Pi's own tools", () => {
  const WRITERS = [
    "Worker.mechanical",
    "Worker.implementation",
    "Worker.integration",
    "Worker.debugging",
    "Worker.visual",
  ] as const

  test("the specialists that write keep read, write, edit and bash and add apply_patch", () => {
    for (const roleTask of WRITERS) {
      const { tools, excludeTools } = toolArgs(CODEX, roleTask)
      for (const tool of ["read", "write", "edit", "bash", APPLY_PATCH_TOOL])
        expect(tools).toContain(tool)
      expect(excludeTools).not.toContain(APPLY_PATCH_TOOL)
    }
  })

  test("every other specialist and the root have no apply_patch, and the root cannot call it", () => {
    for (const roleTask of RoleTask.literals.filter((entry) => !WRITERS.includes(entry as never))) {
      const { tools, excludeTools } = toolArgs(CODEX, roleTask)
      expect(tools).not.toContain(APPLY_PATCH_TOOL)
      expect(excludeTools).toContain(APPLY_PATCH_TOOL)
    }
    const root = toolArgs(CODEX, "root")
    for (const tool of ["write", "edit", APPLY_PATCH_TOOL])
      expect(root.excludeTools).toContain(tool)
  })

  test("under Kimi no tool list changes", () => {
    for (const key of ["root", ...RoleTask.literals] as const) {
      const { tools, excludeTools } = toolArgs(DEFAULT_CONFIG, key)
      expect([...tools, ...excludeTools]).not.toContain(APPLY_PATCH_TOOL)
    }
  })
})

describe("auth handling", () => {
  const answering =
    (exitCode: number, stdout = "", stderr = ""): CommandRunner =>
    () =>
      Effect.succeed({ exitCode, stdout, stderr })

  test("asks Pi about openai-codex only, and never reads a credential", async () => {
    const calls: Array<ReadonlyArray<string>> = []
    const run: CommandRunner = (command, args) => {
      calls.push([command, ...args])
      return Effect.succeed({ exitCode: 0, stdout: '{"status":"ready"}', stderr: "" })
    }
    expect(await Effect.runPromise(providerReadiness(run, CODEX))).toEqual({
      status: "ready",
      provider: "openai-codex",
    })
    expect(calls).toEqual([["pi", "auth", "check", "--provider", "openai-codex", "--json"]])
  })

  test("a login that is missing says to sign in with ChatGPT, not to set a key", async () => {
    const result = await Effect.runPromise(
      providerReadiness(answering(1, '{"status":"not_ready"}'), CODEX),
    )
    expect(result).toMatchObject({ status: "not_ready", provider: "openai-codex" })
    const text = JSON.stringify(result)
    expect(text).toContain("/login openai-codex")
    expect(text).toContain("ChatGPT")
    expect(text).not.toContain("KIMI")
  })

  test("an invalid state or a Pi that did not start is invalid, with what Pi printed", async () => {
    expect(
      await Effect.runPromise(providerReadiness(answering(2, "", "error: bad auth.json"), CODEX)),
    ).toEqual({ status: "invalid", provider: "openai-codex", detail: "error: bad auth.json" })
    expect(
      await Effect.runPromise(providerReadiness(answering(127, "", "pi: not found"), CODEX)),
    ).toMatchObject({ status: "invalid", provider: "openai-codex" })
  })
})
