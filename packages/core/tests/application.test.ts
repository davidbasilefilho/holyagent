import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Deferred, Effect, Fiber } from "effect"

import type { Capability, Context } from "../src/api/context.ts"
import { createIntent } from "../src/domain/intent.ts"
import { assignment, handoff, intent, makeContext, migrate, plan } from "../src/index.ts"
import { WorkTree } from "../src/state/local.ts"
import { withFileLock } from "../src/state/lock.ts"
import { spawn } from "../src/state/process.ts"
import { readState, updateState } from "../src/state/store.ts"
import { resolveState } from "../src/state/tree.ts"

const fixture = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "holyagent-core-bun-"))
  const context: Context = {
    cwd,
    env: { HOME: cwd },
    host: "claude",
    execution: { host: "claude", ttlMinutes: 55, workflowsAvailable: false },
    authorize: () => true,
  }
  return { cwd, context, close: () => rm(cwd, { recursive: true, force: true }) }
}
const draft = {
  roleTask: "Reviewer.testing",
  objective: "Review fixture",
  criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
} as const

describe("direct shared application operations", () => {
  test("Node executes real lifecycle, brief and handoff without Bun", () => {
    const run = spawnSync(
      "node",
      ["--experimental-strip-types", join(import.meta.dir, "node-fixture.mjs")],
      { encoding: "utf8" },
    )
    expect(run.status).toBe(0)
    expect(run.stdout).toContain("node direct lifecycle, brief and handoff passed")
    expect(run.stderr).toBe("")
  })
  test("Bun creates, dispatches, records, closes, accepts and lists state", async () => {
    const f = await fixture()
    try {
      const run = Effect.runPromise
      await run(
        intent.create(f.context, { objective: "Bun fixture", requirements: ["keep evidence"] }),
      )
      const started = await run(assignment.dispatch(f.context, draft))
      expect(await readFile(started.briefPath, "utf8")).toContain("Review fixture")
      await run(assignment.record(f.context, { id: started.assignment.id, agent: "fixture-agent" }))
      await run(
        assignment.close(f.context, {
          id: started.assignment.id,
          outcome: "success",
          report: "evidence:\nworks: verified",
        }),
      )
      const accepted = await run(
        assignment.accept(f.context, { id: started.assignment.id, rationale: "checked" }),
      )
      expect(accepted.acceptance?.rationale).toBe("checked")
      const snapshot = await run(handoff(f.context, {}))
      expect(snapshot.intents[0]?.requirements).toEqual(["keep evidence"])
      expect(snapshot.intents[0]?.assignments[0]?.id).toBe(started.assignment.id)
    } finally {
      await f.close()
    }
  })
  test("strict inputs and denied authority fail without creating state", async () => {
    const f = await fixture()
    try {
      const denied: Context = { ...f.context, authorize: () => false }
      const refused = await Effect.runPromise(
        intent.create(denied, { objective: "denied" }).pipe(Effect.flip),
      )
      expect(refused._tag).toBe("Unauthorized")
      const invalid = await Effect.runPromise(
        intent.create(f.context, { objective: "invalid", extra: true } as never).pipe(Effect.flip),
      )
      expect(invalid._tag).toBe("InvalidDraft")
      expect(await Bun.file(join(f.cwd, ".holyagent", "local", "lock")).exists()).toBe(false)
    } finally {
      await f.close()
    }
  })
  test("revoked authority is rechecked under the state lock", async () => {
    const f = await fixture()
    try {
      let checks = 0
      const context: Context = { ...f.context, authorize: (_: Capability) => ++checks === 1 }
      const result = await Effect.runPromiseExit(intent.create(context, { objective: "revoked" }))
      expect(result._tag).toBe("Failure")
      expect((await Effect.runPromise(intent.list(f.context, {}))).intents).toHaveLength(0)
    } finally {
      await f.close()
    }
  })
  test("read authority does not initialize or migrate staged worktree state", async () => {
    const f = await fixture()
    try {
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: f.cwd, encoding: "utf8" })
        if (result.status !== 0) throw new Error(result.stderr)
        return result.stdout
      }
      expect(spawnSync("git", ["-C", f.cwd, "rev-parse", "--show-toplevel"]).status).not.toBe(0)
      git("init", "-b", "main")
      git("config", "user.name", "Fixture")
      git("config", "user.email", "fixture@example.test")
      git("commit", "--allow-empty", "-m", "fixture")
      await mkdir(join(f.cwd, ".holyagent"), { recursive: true })
      await writeFile(join(f.cwd, ".holyagent", "fixture"), "state")
      git("add", ".holyagent/fixture")
      const before = git("status", "--porcelain")
      const readOnly: Context = {
        ...f.context,
        authorize: (capability) => capability === "intent.list",
      }
      await Effect.runPromiseExit(intent.list(readOnly, {}))
      expect(git("status", "--porcelain")).toBe(before)
      expect(await readFile(join(f.cwd, ".holyagent", "fixture"), "utf8")).toBe("state")
      expect(git("worktree", "list", "--porcelain")).not.toContain("holyagent/state")
      expect(git("branch", "--list", "holyagent/state").trim()).toBe("")
    } finally {
      await f.close()
    }
  })

  test("initialization rechecks authority after waiting for the worktree lock", async () => {
    const f = await fixture()
    try {
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: f.cwd, encoding: "utf8" })
        if (result.status !== 0) throw new Error(result.stderr)
        return result.stdout
      }
      expect(spawnSync("git", ["-C", f.cwd, "rev-parse", "--show-toplevel"]).status).not.toBe(0)
      git("init", "-b", "main")
      git("config", "user.name", "Fixture")
      git("config", "user.email", "fixture@example.test")
      git("commit", "--allow-empty", "-m", "fixture")
      const started = await Effect.runPromise(Deferred.make<void>())
      const finish = await Effect.runPromise(Deferred.make<void>())
      const holder = Effect.runFork(
        withFileLock(
          join(f.cwd, ".git", "holyagent", "worktree.lock"),
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
        ),
      )
      await Effect.runPromise(Deferred.await(started))
      let allowed = true
      const context: Context = { ...f.context, authorize: () => allowed }
      const operation = Effect.runFork(intent.create(context, { objective: "revoked" }))
      await new Promise((resolve) => setTimeout(resolve, 150))
      allowed = false
      await Effect.runPromise(Deferred.succeed(finish, undefined))
      await Effect.runPromise(Fiber.join(holder))
      expect((await Effect.runPromise(Fiber.await(operation)))._tag).toBe("Failure")
      expect(git("worktree", "list", "--porcelain")).not.toContain("holyagent/state")
      expect(git("branch", "--list", "holyagent/state").trim()).toBe("")
      expect(git("status", "--porcelain")).toBe("")
    } finally {
      await f.close()
    }
  })
  test("context construction resolves trusted host settings without state writes", async () => {
    const f = await fixture()
    try {
      const context = await Effect.runPromise(
        makeContext({
          cwd: f.cwd,
          env: {
            ...f.context.env,
            HOLYAGENT_ROUTING_PROFILE: "fast",
            HOLYAGENT_REUSE_TTL_MINUTES: "12",
          },
          host: "pi",
          workflowsAvailable: true,
          authorize: () => true,
        }),
      )
      expect(context.execution).toMatchObject({
        host: "pi",
        ttlMinutes: 12,
        profileRouting: true,
        workflowsAvailable: false,
      })
      expect(await Bun.file(join(f.cwd, ".holyagent", "local", "lock")).exists()).toBe(false)
      const bad = await Effect.runPromiseExit(
        makeContext({
          cwd: f.cwd,
          env: { ...f.context.env, HOLYAGENT_ROUTING_PROFILE: "invalid" },
          host: "pi",
          authorize: () => true,
        }),
      )
      expect(bad._tag).toBe("Failure")
    } finally {
      await f.close()
    }
  })
  test("profiled Pi plan declines the fuzzy workflow path", async () => {
    const f = await fixture()
    try {
      const pi: Context = {
        ...f.context,
        env: { ...f.context.env, HOLYAGENT_ROUTING_PROFILE: "fast" },
        host: "pi",
        execution: { ...f.context.execution, host: "pi", workflowsAvailable: true },
      }
      await Effect.runPromise(intent.create(pi, { objective: "Pi fixture" }))
      await Effect.runPromise(assignment.create(pi, draft))
      await Effect.runPromise(assignment.create(pi, { ...draft, objective: "Second review" }))
      const recommendation = await Effect.runPromise(plan(pi, {}))
      expect(recommendation.action).toBe("subagent")
    } finally {
      await f.close()
    }
  })
  test("evidence selects the actual Pi launch and records intended identity", async () => {
    const f = await fixture()
    try {
      const pi: Context = {
        ...f.context,
        env: { ...f.context.env, HOLYAGENT_ROUTING_PROFILE: "fast" },
        host: "pi",
        execution: { ...f.context.execution, host: "pi", workflowsAvailable: false },
      }
      await Effect.runPromise(intent.create(pi, { objective: "Ranked fixture" }))
      const now = new Date().toISOString()
      const models = ["gpt-6.1-terra", "gpt-6.1-sol"]
      const candidates = models.map((model) => ({
        role: "Reviewer.testing",
        harness: "pi",
        provider: "openai-codex",
        model,
        effort: "high",
        plan: "fixture",
        tier: "fast",
        availability: "yes",
        capabilities: { tools: "yes" },
        requiredCapabilities: [],
        identityStable: true,
      }))
      const rows = models.map((model, i) => ({
        role: "Reviewer.testing",
        harness: "pi",
        provider: "openai-codex",
        model,
        effort: "high",
        plan: "fixture",
        region: "US",
        monthlyUsd: 20,
        allowance: "weekly",
        utilization: "full",
        cacheAssumptions: "none",
        tier: "fast",
        benchmark: "review",
        benchmarkVersion: "1",
        benchmarkHarness: "proxy",
        qualityUnit: "fraction",
        direction: "higher",
        quality: i ? 0.8 : 0.9,
        taskCostUsd: i ? 1 : 2,
        costKind: "subscription",
        measuredAt: now,
        sourceUrl: "https://example.test/benchmark",
        planSourceUrl: "https://example.test/plan",
        planSourceDate: now,
        confidence: "fixture",
      }))
      const routing = {
        version: 1,
        maxAgeDays: 30,
        candidates,
        evidence: { version: 1, revision: "fixture", retrievedAt: now, generatedAt: now, rows },
        benchmarks: [
          {
            role: "Reviewer.testing",
            harness: "pi",
            benchmark: "review",
            benchmarkVersion: "1",
            benchmarkHarness: "proxy",
            qualityUnit: "fraction",
            requiredCapabilities: [],
          },
        ],
      }
      await writeFile(
        join(f.cwd, ".holyagent", "config.json"),
        JSON.stringify({ pi: { provider: "openai-codex" }, routing }),
      )
      const started = await Effect.runPromise(assignment.dispatch(pi, draft))
      expect(started.launch).toMatchObject({
        kind: "ranked",
        model: "openai-codex/gpt-6.1-sol",
        score: 1,
      })
      expect(started.assignment.specialist?.intendedLaunch).toMatchObject({
        model: "openai-codex/gpt-6.1-sol",
        profile: "fast",
      })
      await writeFile(
        join(f.cwd, ".holyagent", "config.json"),
        JSON.stringify({
          pi: {
            provider: "openai-codex",
            routes: { "Reviewer.testing": { model: "gpt-6.1-terra" } },
          },
          routing,
        }),
      )
      const override = await Effect.runPromise(
        assignment.dispatch(pi, { ...draft, objective: "Override" }),
      )
      expect(override.launch).toMatchObject({ kind: "ranked", model: "openai-codex/gpt-6.1-terra" })
      await writeFile(
        join(f.cwd, ".holyagent", "config.json"),
        JSON.stringify({
          pi: { provider: "openai-codex" },
          routing: { ...routing, evidence: { ...routing.evidence, rows: [] } },
        }),
      )
      const missing = await Effect.runPromise(
        assignment.dispatch(pi, { ...draft, objective: "Missing data" }),
      )
      expect(missing.launch).toMatchObject({ kind: "unscored-policy", coverage: "pending" })
      expect(missing.launch).not.toHaveProperty("score")
    } finally {
      await f.close()
    }
  })
  test("interruption waits for the post-commit artifact and releases the lock", async () => {
    const f = await fixture()
    try {
      const git = (...args: ReadonlyArray<string>) => {
        const result = spawnSync("git", args, {
          cwd: f.cwd,
          encoding: "utf8",
          env: { ...process.env, HOME: f.cwd },
        })
        if (result.status !== 0) throw new Error(result.stderr)
        return result.stdout
      }
      git("init", "-b", "main")
      git("config", "user.name", "Fixture")
      git("config", "user.email", "fixture@example.test")
      git("commit", "--allow-empty", "-m", "fixture")
      const state = await Effect.runPromise(resolveState(f.cwd, f.context.env, "create"))
      const directory = state.directory
      const started = await Effect.runPromise(Deferred.make<void>())
      const finish = await Effect.runPromise(Deferred.make<void>())
      const operation = updateState(
        directory,
        ({ project }) =>
          createIntent(project, {
            id: "intent-critical",
            objective: "critical",
            now: new Date().toISOString(),
          }),
        {},
        undefined,
        state.resolved,
        () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ).pipe(Effect.provideService(WorkTree, f.cwd))
      const fiber = Effect.runFork(operation)
      await Effect.runPromise(Deferred.await(started))
      const interruption = Effect.runPromise(Fiber.interrupt(fiber))
      await Effect.runPromise(Deferred.succeed(finish, undefined))
      await interruption
      const snapshot = await Effect.runPromise(
        readState(directory).pipe(Effect.provideService(WorkTree, f.cwd)),
      )
      expect(snapshot.project.intents.map((item) => item.id)).toContain("intent-critical")
      expect(git("log", "holyagent/state", "--format=%s", "-1")).toContain("intent-critical")
      expect(await Bun.file(join(directory, "local", "lock")).exists()).toBe(false)
    } finally {
      await f.close()
    }
  })
  test("interruption before persistence releases the lock without a write", async () => {
    const f = await fixture()
    try {
      const directory = join(f.cwd, ".holyagent")
      const started = await Effect.runPromise(Deferred.make<void>())
      const operation = updateState(
        directory,
        () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        {},
        undefined,
        { mode: "local" },
      ).pipe(Effect.provideService(WorkTree, f.cwd))
      const fiber = Effect.runFork(operation)
      await Effect.runPromise(Deferred.await(started))
      await Effect.runPromise(Fiber.interrupt(fiber))
      const snapshot = await Effect.runPromise(
        readState(directory).pipe(Effect.provideService(WorkTree, f.cwd)),
      )
      expect(snapshot.project.intents).toHaveLength(0)
      expect(await Bun.file(join(directory, "local", "lock")).exists()).toBe(false)
    } finally {
      await f.close()
    }
  })
  test.skipIf(process.platform === "win32")(
    "interrupting a Node subprocess kills its helper process group",
    async () => {
      const f = await fixture()
      try {
        const marker = join(f.cwd, "process.json")
        const script = `const fs=require("node:fs");const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(process.argv[1],JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000)`
        const env = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
        const fiber = Effect.runFork(spawn("node", ["-e", script, marker], { cwd: f.cwd, env }))
        for (let attempt = 0; attempt < 100 && !(await Bun.file(marker).exists()); attempt++)
          await Bun.sleep(20)
        const pids = JSON.parse(await readFile(marker, "utf8")) as { parent: number; child: number }
        expect(pids.parent).toBeGreaterThan(1)
        expect(pids.child).toBeGreaterThan(1)
        await Effect.runPromise(Fiber.interrupt(fiber))
        const alive = (pid: number) => {
          const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" })
          const state = result.stdout.trim()
          return state !== "" && !state.startsWith("Z")
        }
        for (let attempt = 0; attempt < 100 && (alive(pids.parent) || alive(pids.child)); attempt++)
          await Bun.sleep(20)
        expect(alive(pids.parent)).toBe(false)
        expect(alive(pids.child)).toBe(false)
      } finally {
        await f.close()
      }
    },
  )
  test("direct ownership checks reject operational targets inside a linked worktree", async () => {
    const f = await fixture()
    const linked = `${f.cwd}-linked`
    try {
      const git = (...args: ReadonlyArray<string>) => {
        const result = spawnSync("git", args, {
          cwd: f.cwd,
          encoding: "utf8",
          env: { ...process.env, HOME: f.cwd },
        })
        if (result.status !== 0) throw new Error(result.stderr)
      }
      git("init", "-b", "main")
      git("config", "user.name", "Fixture")
      git("config", "user.email", "fixture@example.test")
      git("commit", "--allow-empty", "-m", "fixture")
      git("worktree", "add", "-b", "fixture-linked", linked)
      await Effect.runPromise(intent.create(f.context, { objective: "Ownership fixture" }))
      const result = await Effect.runPromiseExit(
        assignment.create(f.context, {
          roleTask: "Worker.implementation",
          objective: "Write",
          criteria: [{ text: "works", blocking: true, dimension: "behavior" }],
          operationalResources: [{ kind: "local-path", target: join(linked, "owned.txt") }],
        }),
      )
      expect(result._tag).toBe("Failure")
      expect(await Effect.runPromise(assignment.list(f.context, {}))).toHaveLength(0)
    } finally {
      await rm(linked, { recursive: true, force: true })
      await f.close()
    }
  })
  test("direct migration preserves legacy state and makes its records readable", async () => {
    const f = await fixture()
    try {
      const folder = join(f.cwd, ".holyclaude", "intents", "legacy-intent-0001")
      await mkdir(folder, { recursive: true })
      await writeFile(
        join(folder, "intent.json"),
        JSON.stringify({
          id: "intent-0001",
          objective: "Legacy objective",
          requirements: "legacy requirement",
          revision: 1,
          state: "open",
        }),
      )
      const dry = await Effect.runPromise(migrate(f.context, { dryRun: true }))
      expect(dry).toMatchObject({ dryRun: true, problems: [] })
      const moved = await Effect.runPromise(migrate(f.context, {}))
      expect(moved).toMatchObject({ migrated: true })
      expect((await Effect.runPromise(intent.list(f.context, {}))).intents[0]?.objective).toBe(
        "Legacy objective",
      )
      expect(await Bun.file(join(folder, "intent.json")).exists()).toBe(true)
    } finally {
      await f.close()
    }
  })
  test("reports use validated Assignment ids for artifact names", async () => {
    const f = await fixture()
    try {
      await Effect.runPromise(intent.create(f.context, { objective: "Report fixture" }))
      const created = await Effect.runPromise(assignment.create(f.context, draft))
      const source = join(f.cwd, "journal.jsonl")
      await writeFile(
        source,
        [
          JSON.stringify({ type: "started", key: "a", agentId: "agent", label: created.id }),
          JSON.stringify({ type: "result", key: "a", agentId: "agent", result: "report text" }),
        ].join("\n"),
      )
      const result = await Effect.runPromise(assignment.reports(f.context, { source }))
      expect(result.reports[0]?.id).toBe(created.id)
      expect(await readFile(result.reports[0]?.path ?? "", "utf8")).toContain("report text")
    } finally {
      await f.close()
    }
  })
})
