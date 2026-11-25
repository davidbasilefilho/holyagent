import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"

import { AA_PI_COMPARISON } from "@holyagent/core/routing/evidence.ts"
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

const fixture = async (
  host: "pi" | "claude",
  config: unknown,
  profile?: "fast" | "normal",
  models?: ReadonlyArray<string>,
) => {
  const base = await mkdtemp(join(tmpdir(), "holyagent-routing-"))
  const root = join(base, "project")
  const home = join(base, "home")
  await mkdir(join(root, ".holyagent"), { recursive: true })
  await mkdir(home)
  await writeFile(join(root, ".holyagent", "config.json"), JSON.stringify(config))
  const bin = join(base, "bin")
  const commands = join(base, "catalog-calls")
  if (models !== undefined) {
    await mkdir(bin)
    // Use the real CLI entry point and subprocess adapter with a test-only catalog.
    await writeFile(
      join(bin, "pi"),
      `#!/bin/sh
[ "$#" -eq 1 ] && [ "$1" = "--list-models" ] && [ "$PWD" = "$HOME" ] && [ "$PI_OFFLINE" = 1 ] || exit 2
printf '%s\\n' "$1" >> "$CATALOG_CALLS"
printf '%s\\n' 'provider model context' ${models.map((row) => `'${row}'`).join(" ")}
`,
      { mode: 0o755 },
    )
  }
  const env = {
    ...(models !== undefined
      ? { PATH: [bin, process.env.PATH ?? ""].join(delimiter), CATALOG_CALLS: commands }
      : {}),
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
  return { base, root, home, env, call, fields, commands }
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

const twoProviders = ["openai-codex", "kimi-coding-global"]
const aaCandidates = [
  {
    ...candidate("pi", "gpt-6.2-sol"),
    tier: "normal",
  },
  {
    ...candidate("pi", "kimi-for-coding"),
    provider: "kimi-coding-global",
    tier: "normal",
    plan: "k-combo",
    effort: "max",
  },
]
// These scores are synthetic and used only to assert selection, not published observations.
const aaRows = aaCandidates.map(({ role, harness, provider, model, effort, plan, tier }, i) => ({
  role,
  harness,
  provider,
  model,
  effort,
  plan,
  tier,
  ...AA_PI_COMPARISON,
  direction: "higher",
  quality: i === 0 ? 0.55 : 0.7,
  costKind: "quality-only",
  sourceUrl: "https://artificialanalysis.ai/agents/coding-agents",
  confidence: "test fixture",
  measuredAt: now,
}))
const aaCatalog = ["kimi-coding kimi-for-coding 1000000", "openai-codex gpt-6.2-sol 400000"]
const aaRouting = {
  ...routing,
  benchmarks: [],
  candidates: aaCandidates,
  evidence: { ...routing.evidence, rows: aaRows },
}

describe("actual mixed Pi dispatch", () => {
  test.skipIf(process.platform === "win32")(
    "matches exact official Pi quality evidence without inventing subscription prices",
    async () => {
      const f = await fixture(
        "pi",
        { pi: { provider: "openai-codex", providers: twoProviders }, routing: aaRouting },
        undefined,
        aaCatalog,
      )
      try {
        const dispatched = await f.fields(["assignment", "dispatch"], draft)
        expect(dispatched.model).toBe("kimi-coding/kimi-for-coding")
        expect(dispatched.routing).toMatchObject({ kind: "ranked", score: 1, coverage: "complete" })
        expect(dispatched.routing).not.toHaveProperty("taskCostUsd")
        expect(dispatched.routing).not.toHaveProperty("monthlyUsd")
        const assignment = (await Effect.runPromise(readState(join(f.root, ".holyagent")))).project
          .assignments[0]
        expect(assignment?.specialist?.intendedLaunch).toMatchObject({
          profile: "normal",
          provider: "kimi-coding",
          model: "kimi-coding/kimi-for-coding",
          effort: "max",
        })
      } finally {
        await rm(f.base, { recursive: true, force: true })
      }
    },
  )

  test("fails closed when a mixed dispatch has evidence but no current catalog", async () => {
    const f = await fixture("pi", { pi: { providers: twoProviders }, routing: aaRouting })
    try {
      const result = await f.call(["assignment", "dispatch"], JSON.stringify(draft))
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("current Pi model catalog could not be read")
      const snapshot = await Effect.runPromise(readState(join(f.root, ".holyagent")))
      expect(snapshot.project.assignments).toEqual([])
    } finally {
      await rm(f.base, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")(
    "rejects proxy harnesses, wrong efforts, unofficial sources and unavailable providers",
    async () => {
      const f = await fixture(
        "pi",
        {
          pi: { providers: twoProviders },
          routing: {
            ...aaRouting,
            candidates: [aaCandidates[0], { ...aaCandidates[1], availability: "no" }],
            evidence: {
              ...aaRouting.evidence,
              rows: [
                { ...aaRows[0], benchmarkHarness: "Codex CLI" },
                { ...aaRows[0], effort: "max" },
                { ...aaRows[0], sourceUrl: "https://example.test/agents/coding-agents" },
                aaRows[1],
              ],
            },
          },
        },
        undefined,
        aaCatalog,
      )
      try {
        const result = await f.call(["assignment", "dispatch"], JSON.stringify(draft))
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain("exact role model available")
        const snapshot = await Effect.runPromise(readState(join(f.root, ".holyagent")))
        expect(snapshot.project.assignments).toEqual([])
      } finally {
        await rm(f.base, { recursive: true, force: true })
      }
    },
  )

  test("preserves exact role overrides and rejects explicitly disabled providers", async () => {
    const routes = {
      "Reviewer.code": { provider: "openai-codex", model: "gpt-6.2-sol", thinking: "high" },
    }
    const both = await fixture("pi", {
      pi: { providers: twoProviders, routes },
      routing: aaRouting,
    })
    const one = await fixture("pi", { pi: { providers: ["kimi-coding-global"], routes } })
    try {
      const dispatched = await both.fields(["assignment", "dispatch"], draft)
      expect(dispatched.model).toBe("openai-codex/gpt-6.2-sol")
      expect(dispatched.effort).toBe("high")
      const rejected = await one.call(["assignment", "dispatch"], JSON.stringify(draft))
      expect(rejected.code).not.toBe(0)
      expect(rejected.stderr).toContain("explicit Pi route uses a disabled provider")
    } finally {
      await Promise.all([both, one].map((f) => rm(f.base, { recursive: true, force: true })))
    }
  })

  test.skipIf(process.platform === "win32")(
    "unscored official CLI fallback uses only exact, available Pi models and does not prompt",
    async () => {
      const f = await fixture("pi", { pi: { providers: twoProviders } }, undefined, [
        "kimi-coding kimi-for-coding 1000000",
        "openai-codex gpt-6.1-terra 400000",
      ])
      try {
        const first = await f.fields(["assignment", "dispatch"], draft)
        const second = await f.fields(["assignment", "dispatch"], {
          ...draft,
          roleTask: "Reviewer.testing",
        })
        expect(first.routing).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
        expect(first.routing).not.toHaveProperty("score")
        expect(second.routing).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
        expect(new Set([first.model, second.model])).toEqual(
          new Set(["openai-codex/gpt-6.1-terra", "kimi-coding/kimi-for-coding"]),
        )
        expect(await Bun.file(f.commands).text()).toBe("--list-models\n--list-models\n")
      } finally {
        await rm(f.base, { recursive: true, force: true })
      }
    },
  )
})
