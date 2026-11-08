import { describe, expect, test } from "bun:test"

import { Effect, Schema } from "effect"

import { Config, KIMI_ROUTES } from "../../src/config/schema.ts"
import { RoleTask } from "../../src/domain/route.ts"
import { DEFAULT_CONFIG } from "./defaults.ts"

/** The Kimi table of docs/pi/providers.md, written out row by row. */
const DOCUMENTED_ROUTES = {
  root: { model: "k3.1-pro", thinking: "high" },
  "Worker.implementation": { model: "kimi-for-coding", thinking: "max" },
  "Worker.debugging": { model: "kimi-for-coding", thinking: "max" },
  "Worker.integration": { model: "kimi-for-coding", thinking: "max" },
  "Reviewer.code": { model: "kimi-for-coding", thinking: "max" },
  "Reviewer.security": { model: "kimi-for-coding", thinking: "max" },
  "Reviewer.testing": { model: "kimi-for-coding", thinking: "max" },
  "Reviewer.artifact": { model: "kimi-for-coding", thinking: "max" },
  "Worker.mechanical": { model: "kimi-for-coding", thinking: "high" },
  "Worker.validation": { model: "kimi-for-coding", thinking: "high" },
  "Worker.operations": { model: "kimi-for-coding", thinking: "high" },
  "Explorer.map": { model: "kimi-for-coding", thinking: "high" },
  "Explorer.lookup": { model: "kimi-for-coding", thinking: "high" },
  "Explorer.trace": { model: "kimi-for-coding", thinking: "high" },
  "Librarian.lookup": { model: "kimi-for-coding", thinking: "high" },
  "Librarian.research": { model: "kimi-for-coding", thinking: "high" },
  "Reviewer.audit": { model: "kimi-for-coding", thinking: "high" },
  "Worker.visual": { model: "k3.1-pro", thinking: "low" },
  "Reviewer.visual": { model: "k3.1-pro", thinking: "low" },
} as const

describe("default config", () => {
  test("the route table is the Kimi table of providers.md, for the root and all 18 specialists", () => {
    expect(DEFAULT_CONFIG.pi.routes).toEqual(DOCUMENTED_ROUTES)
    expect(Object.keys(DEFAULT_CONFIG.pi.routes).sort()).toEqual(
      ["root", ...RoleTask.literals].sort(),
    )
  })

  test("no specialist but the two visual ones runs at low, and only they run on k3.1-pro", () => {
    const rows: ReadonlyArray<readonly [string, { model: string; thinking: string }]> =
      Object.entries(DEFAULT_CONFIG.pi.routes).filter(([key]) => key !== "root")
    expect(rows).toHaveLength(18)
    for (const [key, choice] of rows) {
      const visual = key.endsWith(".visual")
      expect(choice.thinking === "low").toBe(visual)
      expect(choice.model === "k3.1-pro").toBe(visual)
    }
  })

  test("the exported route defaults are what an empty config resolves to", () => {
    expect(DEFAULT_CONFIG.pi.routes).toEqual(KIMI_ROUTES)
  })

  test("the other settings default as configuration.md documents", () => {
    expect(DEFAULT_CONFIG.pi.enable).toBe(true)
    expect(DEFAULT_CONFIG.pi.provider).toBe("kimi-coding-global")
    expect(DEFAULT_CONFIG.pi.features).toEqual({
      web: "provider",
      processes: true,
      todo: true,
      ask: true,
      mcp: true,
      computerUse: true,
      contextCompression: true,
      subagents: true,
    })
    expect(DEFAULT_CONFIG.pi.codemode).toEqual({ mode: "only", maxWorkers: 4 })
    expect(DEFAULT_CONFIG.pi.t3).toEqual({
      scope: "global",
      worktrees: true,
      deviceAccess: true,
    })
    expect(DEFAULT_CONFIG.claude).toEqual({})
    expect(DEFAULT_CONFIG.vcs).toEqual({})
  })
})

describe("a route's model id", () => {
  const decode = (model: string) =>
    Effect.runPromise(
      Effect.result(
        Schema.decodeUnknownEffect(Config)(
          { pi: { routes: { root: { model } } } },
          { onExcessProperty: "error" },
        ),
      ),
    )

  test.each([
    "kimi-for-coding",
    "k3.1-pro",
    "kimi-coding/kimi-for-coding",
    "anthropic.claude-sonnet-v1:0",
    "meta-llama/Llama-3.1-70B:free",
    "gpt_5",
    "claude-sonnet-4@20250514",
    "gpt-5+reasoning",
    "a".repeat(128),
  ])("%s is accepted", async (model) => {
    const result = await decode(model)
    expect(result._tag).toBe("Success")
  })

  test.each([
    ["empty", ""],
    ["an escape sequence", "kimi\u001b[2J"],
    ["a C1 control", "kimi\u009b2J"],
    ["a newline", "kimi\nfor-coding"],
    ["a bell", "kimi\u0007"],
    ["a space", "kimi for-coding"],
    ["a leading dash, which reads as a flag", "--model"],
    ["a leading @", "@kimi"],
    ["a leading +", "+kimi"],
    ["a space after an @", "kimi@ 1"],
    ["markup", "x](https://example.test)"],
    ["a backtick", "`kimi`"],
    ["a bidi override", "kimi\u202egnidoc"],
    ["a non-ASCII letter", "kimi-k\u00e4"],
    ["too long", "a".repeat(129)],
  ])("%s is refused", async (_label, model) => {
    const result = await decode(model)
    expect(result._tag).toBe("Failure")
  })
})
