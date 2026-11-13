import { describe, expect, test } from "bun:test"

import { Effect, Schema } from "effect"

import { Config } from "../src/config/schema.ts"
import { nativeSearchInventory, routeModel } from "../src/pi/provider.ts"
import { toolArgs } from "../src/pi/tools.ts"
import {
  type Candidate,
  importEvidence,
  rankCandidates,
  selectRoute,
} from "../src/routing/evidence.ts"

const date = "2026-11-13T00:00:00Z"
const row = (model: string, quality: number, taskCostUsd: number) => ({
  role: "Worker.integration",
  harness: "pi",
  provider: "codex",
  model,
  effort: "high",
  plan: "plus",
  region: "US",
  monthlyUsd: 20,
  allowance: "weekly",
  utilization: "full",
  cacheAssumptions: "none",
  tier: "fast" as const,
  benchmark: "task",
  benchmarkVersion: "1",
  benchmarkHarness: "mini-swe-agent",
  qualityUnit: "fraction",
  direction: "higher" as const,
  quality,
  taskCostUsd,
  costKind: "subscription" as const,
  measuredAt: date,
  sourceUrl: "https://example.test/benchmark",
  planSourceUrl: "https://example.test/plan",
  planSourceDate: date,
  confidence: "sampled",
})
const candidate = (model: string): Candidate => ({
  role: "Worker.integration",
  harness: "pi",
  provider: "codex",
  model,
  effort: "high",
  plan: "plus",
  tier: "fast",
  availability: "yes",
  identityStable: true,
  capabilities: { tools: "yes" },
  requiredCapabilities: ["tools"],
})
const comparison = {
  role: "Worker.integration",
  harness: "pi",
  tier: "fast" as const,
  benchmark: "task",
  benchmarkVersion: "1",
  benchmarkHarness: "mini-swe-agent",
  qualityUnit: "fraction",
  now: date,
  maxAgeDays: 30,
  requiredCapabilities: ["tools"],
}

describe("subscription evidence", () => {
  test("ranks comparable subscription values and leaves missing candidates unscored", async () => {
    const dataset = await Effect.runPromise(
      importEvidence({
        version: 1,
        revision: "fixture",
        retrievedAt: date,
        generatedAt: date,
        rows: [row("a", 0.8, 2), row("b", 0.6, 1)],
      }),
    )
    const result = rankCandidates(
      dataset,
      [candidate("a"), candidate("b"), candidate("missing")],
      comparison,
    )
    expect(result.optimization).toBe("pending")
    expect(result.candidates[0]?.score).toBeCloseTo(2 / 3)
    expect(result.candidates[1]?.score).toBe(1)
    expect(result.candidates[2]).toMatchObject({
      eligibility: "excluded",
      reasons: ["missing_evidence"],
    })
    expect(result.candidates[2]).not.toHaveProperty("score")
    expect(
      selectRoute(dataset, [candidate("a"), candidate("b")], comparison, candidate("a")),
    ).toMatchObject({ kind: "ranked", candidate: { model: "b" }, score: 1 })
    expect(selectRoute(dataset, [candidate("missing")], comparison, candidate("a"))).toMatchObject({
      kind: "unscored-policy",
      candidate: { model: "a" },
    })
    expect(
      selectRoute(dataset, [candidate("missing")], comparison, {
        ...candidate("a"),
        capabilities: {},
      }),
    ).toMatchObject({ kind: "unavailable", reasons: ["capability_tools_unknown"] })
  })
  test("refuses stale, API fallback, unknown capability and incompatible harness", async () => {
    const dataset = await Effect.runPromise(
      importEvidence({
        version: 1,
        revision: "fixture",
        retrievedAt: date,
        generatedAt: date,
        rows: [row("a", 1, 1), { ...row("b", 1, 1), costKind: "api-fallback" }],
      }),
    )
    const unknown = { ...candidate("a"), capabilities: {} }
    const incompatible = { ...candidate("a"), harness: "other" }
    const result = rankCandidates(dataset, [unknown, candidate("b"), incompatible], {
      ...comparison,
      now: "2027-01-01T00:00:00Z",
    })
    expect(result.candidates[0]).toMatchObject({
      eligibility: "unknown",
      reasons: ["capability_tools_unknown", "stale_evidence"],
    })
    expect(result.candidates[1]?.reasons).toContain("api_price_fallback")
    expect(result.candidates[2]?.reasons).toContain("noncomparable_candidate")
    expect(result.candidates.every((item) => !("score" in item))).toBe(true)
    await expect(
      Effect.runPromise(
        importEvidence({
          version: 1,
          revision: "x",
          retrievedAt: date,
          generatedAt: date,
          rows: [],
          extra: true,
        }),
      ),
    ).rejects.toThrow()
  })
  test("excludes over-target plans, unverified access and mismatched proxy harness", async () => {
    const dataset = await Effect.runPromise(
      importEvidence({
        version: 1,
        revision: "fixture",
        retrievedAt: date,
        generatedAt: date,
        rows: [
          { ...row("a", 1, 1), monthlyUsd: 21 },
          { ...row("b", 1, 1), benchmarkHarness: "other-proxy" },
          row("c", 1, 1),
        ],
      }),
    )
    const result = rankCandidates(
      dataset,
      [candidate("a"), candidate("b"), { ...candidate("c"), availability: "unknown" }],
      comparison,
    )
    expect(result.candidates[0]?.reasons).toContain("plan_exceeds_target")
    expect(result.candidates[1]?.reasons).toContain("missing_evidence")
    expect(result.candidates[2]?.reasons).toContain("availability_unknown")
    expect(result.candidates.every((item) => !("score" in item))).toBe(true)
  })
})

describe("Pi policy routes", () => {
  const decode = (value: unknown) =>
    Effect.runPromise(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(value))
  test("uses the row provider for a mixed route and screen conversion", async () => {
    const config = await decode({
      pi: {
        provider: "kimi-coding-global",
        routes: { "Explorer.map": { provider: "openai-codex" } },
      },
    })
    expect(routeModel(config, "Explorer.map").spec).toBe("openai-codex/gpt-6-luna:low")
    expect(routeModel(config, "Explorer.map", { screen: true }).spec).toBe(
      "openai-codex/gpt-6.1-terra:medium",
    )
    expect(routeModel(config, "root").provider).toBe("kimi-coding")
  })
  test("activates fast root only on explicit profile and honors row overrides", async () => {
    const normal = await decode({ pi: { provider: "openai-codex" } })
    const fast = await decode({ pi: { provider: "openai-codex", profile: "fast" } })
    const overridden = await decode({
      pi: {
        provider: "openai-codex",
        profile: "fast",
        routes: { root: { model: "gpt-6.1-sol", thinking: "medium" } },
      },
    })
    expect(routeModel(normal, "root").model).toBe("gpt-6.1-sol")
    expect(routeModel(fast, "root").model).toBe("gpt-6.1-terra")
    expect(routeModel(overridden, "root").spec).toBe("openai-codex/gpt-6.1-sol:medium")
  })
  test("distinguishes exposed, disabled and unobserved native search", () => {
    expect(nativeSearchInventory(["moonshot_search"], ["moonshot_search"]).state).toBe("exposed")
    expect(nativeSearchInventory(["moonshot_search"], []).state).toBe("disabled")
    expect(nativeSearchInventory([], []).state).toBe("unknown")
  })
  test("declared model capabilities do not enable disabled search tools", async () => {
    const config = await decode({ pi: { profile: "fast", features: { web: "off" } } })
    expect(toolArgs(config, "Librarian.lookup").tools).not.toContain("moonshot_search")
    expect(toolArgs(config, "Librarian.lookup").tools).not.toContain("web_search")
  })
})
