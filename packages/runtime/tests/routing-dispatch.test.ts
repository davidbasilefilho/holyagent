import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { run } from "../src/cli/program.ts"
import { readState } from "../src/state/store.ts"

const now = new Date().toISOString()
const row = (harness: "pi" | "claude", model: string, quality: number, taskCostUsd: number) => ({
  role: "Reviewer.code",
  harness,
  provider: harness === "pi" ? "openai-codex" : "anthropic",
  model,
  effort: "high",
  plan: "plus",
  region: "US",
  monthlyUsd: 20,
  allowance: "weekly",
  utilization: "full",
  cacheAssumptions: "none",
  tier: "fast",
  benchmark: "review",
  benchmarkVersion: "1",
  benchmarkHarness: "proxy-harness",
  qualityUnit: "fraction",
  direction: "higher",
  quality,
  taskCostUsd,
  costKind: "subscription",
  measuredAt: now,
  sourceUrl: "https://example.test/benchmark",
  planSourceUrl: "https://example.test/plan",
  planSourceDate: now,
  confidence: "fixture",
})
const candidate = (harness: "pi" | "claude", model: string) => ({
  role: "Reviewer.code",
  harness,
  provider: harness === "pi" ? "openai-codex" : "anthropic",
  model,
  effort: "high",
  plan: "plus",
  tier: "fast",
  availability: "yes",
  capabilities: { tools: "yes" },
  requiredCapabilities: [],
  identityStable: true,
})
const routing = {
  version: 1,
  maxAgeDays: 30,
  evidence: {
    version: 1,
    revision: "fixture-v1",
    retrievedAt: now,
    generatedAt: now,
    rows: [
      row("pi", "gpt-6.1-terra", 0.9, 2),
      row("pi", "gpt-6.1-sol", 0.7, 1),
      row("claude", "sonnet", 0.9, 2),
      row("claude", "haiku", 0.7, 1),
    ],
  },
  benchmarks: ["pi", "claude"].map((harness) => ({
    role: "Reviewer.code",
    harness,
    benchmark: "review",
    benchmarkVersion: "1",
    benchmarkHarness: "proxy-harness",
    qualityUnit: "fraction",
    requiredCapabilities: [],
  })),
  candidates: [
    candidate("pi", "gpt-6.1-terra"),
    candidate("pi", "gpt-6.1-sol"),
    candidate("claude", "sonnet"),
    candidate("claude", "haiku"),
  ],
}
const draft = {
  roleTask: "Reviewer.code",
  objective: "Review fixture",
  criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
}

const fixture = async (host: "pi" | "claude", config: unknown, profile?: "fast" | "normal") => {
  const base = await mkdtemp(join(tmpdir(), "holyagent-routing-"))
  const root = join(base, "project")
  const home = join(base, "home")
  await mkdir(join(root, ".holyagent"), { recursive: true })
  await mkdir(home)
  await writeFile(join(root, ".holyagent", "config.json"), JSON.stringify(config))
  const env = {
    HOME: home,
    HOLYAGENT_HOME: home,
    HOLYAGENT_HOST: host,
    HOLYAGENT_WORKFLOWS: "1",
    ...(profile === undefined ? {} : { HOLYAGENT_ROUTING_PROFILE: profile }),
  }
  const call = (args: ReadonlyArray<string>, stdin = "") =>
    Effect.runPromise(run(args, { cwd: root, env, stdin: Effect.succeed(stdin) }))
  const fields = async (args: ReadonlyArray<string>, input?: unknown) => {
    const result = await call(
      args,
      input === undefined ? "" : typeof input === "string" ? input : JSON.stringify(input),
    )
    if (result.code !== 0) throw new Error(result.stderr)
    return decode(result.stdout.split("\nprompt:\n")[0] ?? "") as Record<string, unknown>
  }
  await fields(["intent", "create"], { objective: "Routing fixture" })
  return { base, root, home, env, call, fields }
}

describe("actual subscription dispatch", () => {
  for (const host of ["pi", "claude"] as const) {
    test(`${host} dispatch launches the highest scored configured role candidate`, async () => {
      const f = await fixture(host, { pi: { provider: "openai-codex" }, routing }, "fast")
      try {
        const dispatched = await f.fields(["assignment", "dispatch"], draft)
        expect(dispatched.model).toBe(host === "pi" ? "openai-codex/gpt-6.1-sol" : "haiku")
        expect(dispatched.effort).toBe("high")
        expect(dispatched.routing).toMatchObject({
          kind: "ranked",
          score: 1,
          coverage: "complete",
          evidenceRevision: "fixture-v1",
        })
        const snapshot = await Effect.runPromise(readState(join(f.root, ".holyagent")))
        expect(snapshot.project.assignments[0]?.specialist?.intendedLaunch).toMatchObject({
          host,
          model: dispatched.model,
          profile: "fast",
        })
        expect(snapshot.project.assignments[0]?.specialist).not.toHaveProperty("observedLaunch")
      } finally {
        await rm(f.base, { recursive: true, force: true })
      }
    })
  }
  test("Pi explicit route model wins over a higher-scoring alternative", async () => {
    const f = await fixture("pi", {
      pi: {
        provider: "openai-codex",
        profile: "fast",
        routes: { "Reviewer.code": { model: "gpt-6.1-terra" } },
      },
      routing,
    })
    try {
      const dispatched = await f.fields(["assignment", "dispatch"], draft)
      expect(dispatched.model).toBe("openai-codex/gpt-6.1-terra")
      expect(dispatched.routing).toMatchObject({ kind: "ranked", coverage: "pending" })
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })
  test("missing evidence falls back explicitly without an invented score", async () => {
    const f = await fixture(
      "claude",
      { routing: { ...routing, evidence: { ...routing.evidence, rows: [] } } },
      "fast",
    )
    try {
      const dispatched = await f.fields(["assignment", "dispatch"], draft)
      expect(dispatched.model).toBe("sonnet")
      expect(dispatched.routing).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
      expect(dispatched.routing).not.toHaveProperty("score")
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })
  test("profile plan uses direct agents while legacy Pi plan still uses workflows", async () => {
    for (const profile of [undefined, "fast"] as const) {
      const f = await fixture("pi", { pi: { provider: "openai-codex" }, routing }, profile)
      try {
        await f.fields(["assignment", "create"], draft)
        await f.fields(["assignment", "create"], {
          ...draft,
          roleTask: "Reviewer.testing",
          objective: "Review tests",
        })
        const plan = await f.fields(["plan"])
        expect(plan.action).toBe(profile === undefined ? "workflow" : "subagent")
      } finally {
        await rm(f.base, { recursive: true, force: true })
      }
    }
  })
  test("unverified model identity does not reuse a profile worker after a route change", async () => {
    const f = await fixture("pi", { pi: { provider: "openai-codex" }, routing }, "fast")
    try {
      const first = await f.fields(["assignment", "dispatch"], draft)
      const id = String(first.id)
      await f.fields(["assignment", "record", id, "--agent", "pi:agent-1"])
      await f.fields(["assignment", "close", id, "--outcome", "success"], "fixture report")
      const changed = {
        ...routing,
        evidence: {
          ...routing.evidence,
          rows: routing.evidence.rows.map((item) =>
            item.model === "gpt-6.1-sol" ? { ...item, quality: 0.1 } : item,
          ),
        },
      }
      await writeFile(
        join(f.root, ".holyagent", "config.json"),
        JSON.stringify({ pi: { provider: "openai-codex" }, routing: changed }),
      )
      const second = await f.fields(["assignment", "dispatch"], {
        ...draft,
        objective: "Another review",
        followUpOf: id,
      })
      expect(second.model).toBe("openai-codex/gpt-6.1-terra")
      expect(second).not.toHaveProperty("continue")
      const snapshot = await Effect.runPromise(readState(join(f.root, ".holyagent")))
      expect(snapshot.specialists.map((entry) => entry.agentId)).toContain("pi:agent-1")
      expect(snapshot.specialists[0]?.intendedLaunch).toMatchObject({
        model: "openai-codex/gpt-6.1-sol",
        profile: "fast",
      })
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })
  test("an explicit incompatible screen route fails before dispatch", async () => {
    const f = await fixture(
      "pi",
      {
        pi: {
          provider: "openai-codex",
          routes: { "Reviewer.code": { model: "gpt-6-luna", thinking: "low" } },
        },
        routing,
      },
      "fast",
    )
    try {
      const result = await f.call(
        ["assignment", "dispatch"],
        JSON.stringify({ ...draft, screen: true }),
      )
      expect(result.code).toBe(2)
      expect(result.stderr).toContain("conflicts with the screen")
      const snapshot = await Effect.runPromise(readState(join(f.root, ".holyagent")))
      expect(snapshot.project.assignments).toHaveLength(0)
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })
  test("a candidate with unknown required capabilities is never scored", async () => {
    const changed = {
      ...routing,
      candidates: routing.candidates.map((item) =>
        item.harness === "claude" ? { ...item, capabilities: {} } : item,
      ),
    }
    const f = await fixture("claude", { routing: changed }, "fast")
    try {
      const result = await f.fields(["assignment", "dispatch"], draft)
      expect(result.model).toBe("sonnet")
      expect(result.routing).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
      expect(result.routing).not.toHaveProperty("score")
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })

  test("Claude rejects model IDs outside its installed Agent tool contract", async () => {
    const unsupported = "claude-unlisted-model"
    const changed = {
      ...routing,
      candidates: [{ ...candidate("claude", unsupported) }],
      evidence: { ...routing.evidence, rows: [row("claude", unsupported, 1, 1)] },
    }
    const f = await fixture("claude", { routing: changed }, "fast")
    try {
      const result = await f.fields(["assignment", "dispatch"], draft)
      expect(result.model).toBe("sonnet")
      expect(result.routing).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })

  test("Pi ranks another provider only when explicitly configured", async () => {
    const kimiCandidate = { ...candidate("pi", "k3.1-pro"), provider: "kimi-coding-global" }
    const kimiRow = { ...row("pi", "k3.1-pro", 1, 0.1), provider: "kimi-coding-global" }
    const changed = {
      ...routing,
      candidates: [...routing.candidates, kimiCandidate],
      evidence: { ...routing.evidence, rows: [...routing.evidence.rows, kimiRow] },
    }
    for (const enabled of [false, true]) {
      const pi = {
        provider: "openai-codex",
        ...(enabled ? { routes: { "Reviewer.testing": { provider: "kimi-coding-global" } } } : {}),
      }
      const f = await fixture("pi", { pi, routing: changed }, "fast")
      try {
        const result = await f.fields(["assignment", "dispatch"], draft)
        expect(result.model).toBe(enabled ? "kimi-coding/k3.1-pro" : "openai-codex/gpt-6.1-sol")
      } finally {
        await rm(f.base, { recursive: true, force: true })
      }
    }
  })

  test("explicit provider, model and effort stay authoritative", async () => {
    const f = await fixture(
      "pi",
      {
        pi: {
          provider: "openai-codex",
          routes: {
            "Reviewer.code": { provider: "kimi-coding-global", model: "k3.1-pro", thinking: "low" },
          },
        },
        routing,
      },
      "fast",
    )
    try {
      const result = await f.fields(["assignment", "dispatch"], draft)
      expect(result.model).toBe("kimi-coding/k3.1-pro")
      expect(result.effort).toBe("low")
      expect(result.routing).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })

  test("normal profile also drives independent Pi and Claude role selection", async () => {
    const normal = {
      ...routing,
      candidates: routing.candidates.map((item) => ({ ...item, tier: "normal" })),
      evidence: {
        ...routing.evidence,
        rows: routing.evidence.rows.map((item) => ({ ...item, tier: "normal", monthlyUsd: 100 })),
      },
    }
    for (const host of ["pi", "claude"] as const) {
      const f = await fixture(host, { pi: { provider: "openai-codex" }, routing: normal }, "normal")
      try {
        const selected = await f.fields(["assignment", "dispatch"], draft)
        expect(selected.model).toBe(host === "pi" ? "openai-codex/gpt-6.1-sol" : "haiku")
        expect(selected.routing).toMatchObject({ kind: "ranked", monthlyUsd: 100 })
      } finally {
        await rm(f.base, { recursive: true, force: true })
      }
    }
  })
  test("Claude without profile keeps legacy dispatch even if unrelated config is invalid", async () => {
    const f = await fixture("claude", { unsupportedOldSetting: true })
    try {
      const selected = await f.fields(["assignment", "dispatch"], draft)
      expect(selected.model).toBe("sonnet")
      expect(selected).not.toHaveProperty("routing")
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })
  test("session profile overrides the configured Pi profile", async () => {
    const f = await fixture(
      "pi",
      { pi: { provider: "openai-codex", profile: "fast" }, routing },
      "normal",
    )
    try {
      const selected = await f.fields(["assignment", "dispatch"], draft)
      expect(selected.routing).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
      const snapshot = await Effect.runPromise(readState(join(f.root, ".holyagent")))
      expect(snapshot.project.assignments[0]?.specialist?.intendedLaunch?.profile).toBe("normal")
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })
})
