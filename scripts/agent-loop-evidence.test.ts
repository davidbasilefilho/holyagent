import { describe, expect, test } from "bun:test"

import { evaluateAgentLoops } from "./agent-loop-evidence.ts"

const stamp = (ms: number) => new Date(ms).toISOString()
const line = (type: string, payload: unknown, ms = 0) =>
  JSON.stringify({ timestamp: stamp(ms), type, payload })
const meta = (id: string, session_id = id) =>
  line("session_meta", { id, session_id, cli_version: "0.172.0-alpha.2" })
const tokens = (input_tokens: number, cached_input_tokens: number, output_tokens: number) => ({
  input_tokens,
  cached_input_tokens,
  output_tokens,
  cache_write_input_tokens: 9_000,
  reasoning_output_tokens: 1,
  total_tokens: 40_000,
})
const usage = (
  thread_id: string,
  turn_id: string,
  response_id: string,
  usage: ReturnType<typeof tokens>,
  session_id = thread_id,
) =>
  line("token_usage_record", {
    thread_id,
    session_id,
    turn_id,
    response_id,
    usage,
    turn_token_usage: tokens(150, 50, 25),
    thread_token_usage: tokens(1_500, 500, 250),
  })
const event = (type: string, payload: Record<string, unknown> = {}, ms = 0) =>
  line("event_msg", { type, ...payload }, ms)
const snapshot = (total_token_usage: ReturnType<typeof tokens>) =>
  event("token_count", { info: { total_token_usage, last_token_usage: tokens(111, 11, 22) } })
const read = (files: Record<string, string[]>) => async (path: string) => {
  const lines = files[path]
  if (!lines) throw new Error(`missing fixture ${path}`)
  return lines.join("\n")
}
const run = (id: string, variant: "before" | "after", options = {}) => ({
  id,
  variant,
  scenario: "same specified task",
  origin: "loopback",
  accepted: "assertion green",
  sessions: [{ path: id }],
  ...options,
})

describe("offline Codex agent-loop evidence", () => {
  test("uses completed-response increments once, includes an observed retry, and groups by native session and Assignment", async () => {
    const initial = usage("root", "interrupted", "one", tokens(100, 15, 7))
    const result = await evaluateAgentLoops(
      {
        runs: [
          run("task", "after", {
            visibleTurns: 1,
            sessions: [{ path: "root" }, { path: "child", assignment: "assignment-one" }],
          }),
        ],
      },
      read({
        root: [
          meta("root"),
          event("task_started", { turn_id: "interrupted" }),
          initial,
          initial,
          event("turn_aborted", { turn_id: "interrupted", duration_ms: 50 }),
          event("task_started", { turn_id: "retry" }),
          line("turn_context", { turn_id: "retry", model: "gpt-6.2-sol", effort: "high" }),
          line("compacted", { message: "secret" }),
          line("turn_context", {
            turn_id: "retry",
            model: "gpt-6.2-sol",
            effort: "high",
            root_turn_id: "retry",
          }),
          usage("root", "retry", "two", tokens(200, 150, 8)),
          snapshot(tokens(1_500, 500, 250)),
          event("task_complete", { turn_id: "retry", duration_ms: 70, time_to_first_token_ms: 20 }),
        ],
        child: [
          line("session_meta", {
            id: "child",
            session_id: "root",
            parent_thread_id: "root",
            cli_version: "0.172.0-alpha.2",
          }),
          line("turn_context", { turn_id: "child-turn" }),
          usage("child", "child-turn", "one", tokens(100, 35, 5), "root"),
          event("task_complete", { turn_id: "child-turn", duration_ms: 10 }),
        ],
      }),
    )
    expect(result.runs[0]).toMatchObject({
      visibleTurns: 1,
      threads: 2,
      completedResponsesWithUsage: 3,
      observedUsage: {
        cacheRead: 200,
        fresh: 200,
        output: 20,
        input: 400,
        total: 420,
        cacheRate: 0.5,
        shares: { cacheRead: 200 / 420, fresh: 200 / 420, output: 20 / 420 },
      },
      sessions: [{ id: "root", threads: 2, observedUsage: { total: 420 } }],
      assignments: [
        { id: null, threads: 1, observedUsage: { total: 315 } },
        { id: "assignment-one", threads: 1, observedUsage: { total: 105 } },
      ],
      turnElapsedMs: { n: 3, p50: 50, p95: 70 },
      firstTokenMs: { n: 1, p50: 20, p95: 20 },
      nativeThreads: [
        {
          threadId: "root",
          coverage: {
            method: "response-records",
            duplicateResponses: 1,
            cumulativeSnapshots: 1,
            retryAttempts: null,
            totalModelInvocations: null,
            contextResends: null,
          },
          turns: { observed: 2, completed: 1, aborted: 1 },
          observedCompactions: 1,
          turnObservations: [
            { id: "interrupted", model: null, effort: null, observedUsage: { input: 100 } },
            {
              id: "retry",
              rootTurnId: "retry",
              model: "gpt-6.2-sol",
              effort: "high",
              contextRecords: 2,
              observedUsage: { input: 200 },
            },
          ],
        },
        {
          threadId: "child",
          parentThreadId: "root",
          turns: { observed: 1, completed: 1, aborted: 0 },
          events: [
            { kind: "session_meta", id: "child" },
            { kind: "turn_context", id: "child-turn" },
            { kind: "task_complete", id: "child-turn" },
          ],
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("uses cumulative deltas only when response records are missing and flags unknown intervals", async () => {
    const result = await evaluateAgentLoops(
      { runs: [run("fallback", "before"), run("partial", "after")] },
      read({
        fallback: [
          meta("fallback"),
          snapshot(tokens(100, 40, 10)),
          snapshot(tokens(100, 40, 10)),
          snapshot(tokens(125, 55, 12)),
          snapshot(tokens(10, 5, 1)),
          snapshot(tokens(20, 8, 3)),
        ],
        partial: [meta("partial"), snapshot(tokens(500, 200, 50))],
      }),
    )
    expect(result.runs[0]).toMatchObject({
      observedUsage: { cacheRead: 18, fresh: 17, output: 4, total: 39 },
      nativeThreads: [
        {
          coverage: {
            method: "cumulative-deltas",
            cumulativeSnapshots: 5,
            initialCounterUnobserved: true,
            resetIntervals: 1,
            completedResponsesWithUsage: 0,
          },
        },
      ],
    })
    expect(result.runs[1]).toMatchObject({
      observedUsage: null,
      threadsWithoutUsage: 1,
      nativeThreads: [{ coverage: { method: "unavailable", initialCounterUnobserved: true } }],
    })
  })

  test("compares accepted equivalent outcomes of the same origin and reports latency sample coverage", async () => {
    const result = await evaluateAgentLoops(
      {
        runs: [
          run("b1", "before", { firstUsefulProgressMs: 3, elapsedMs: 8, sessions: [] }),
          run("b2", "before", { firstUsefulProgressMs: 4, elapsedMs: 20, sessions: [] }),
          run("a", "after", {
            firstUsefulProgressMs: 2,
            elapsedMs: 5,
            visibleTurns: 1,
            sessions: [],
          }),
          {
            id: "not-accepted",
            scenario: "same specified task",
            variant: "after",
            origin: "loopback",
            elapsedMs: 5000,
            sessions: [],
          },
          run("different", "after", { accepted: "different", elapsedMs: 100, sessions: [] }),
          run("native", "after", { origin: "native", elapsedMs: 200, sessions: [] }),
        ],
      },
      read({}),
    )
    expect(result.comparisons).toHaveLength(1)
    expect(result.comparisons[0]).toMatchObject({
      origin: "loopback",
      before: {
        completedTasks: 2,
        firstUsefulProgressMs: { n: 2, p50: 3, p95: 4 },
        elapsedMs: { n: 2, p50: 8, p95: 20 },
        observedUsage: null,
        visibleTurns: { n: 0, p50: null, p95: null },
      },
      after: { completedTasks: 1, elapsedMs: { n: 1, p50: 5, p95: 5 } },
    })
  })

  test("pairs only wait_agent outputs and does not expose call arguments or returned content", async () => {
    const call = (id: string, name: string, ms: number) =>
      line("response_item", { type: "function_call", call_id: id, name, arguments: "secret" }, ms)
    const output = (id: string, ms: number) =>
      line("response_item", { type: "function_call_output", call_id: id, output: "secret" }, ms)
    const result = await evaluateAgentLoops(
      { runs: [run("waits", "after")] },
      read({
        waits: [
          meta("waits"),
          call("a", "wait_agent", 10),
          output("a", 100),
          call("b", "wait_agent", 110),
          call("c", "request_user_input", 120),
          output("c", 200),
          call("d", "wait_agent", 300),
          output("d", 310),
        ],
      }),
    )
    expect(result.runs[0]).toMatchObject({
      waitMs: { n: 2, p50: 10, p95: 90 },
      unmatchedWaits: 1,
    })
    expect(JSON.stringify(result)).not.toContain("secret")
  })

  test("rejects duplicate rollout exports and inconsistent response counts without echoing payloads", async () => {
    await expect(
      evaluateAgentLoops(
        { runs: [run("first", "before"), run("second", "after")] },
        read({ first: [meta("same")], second: [meta("same")] }),
      ),
    ).rejects.toThrow("duplicate rollout thread: same")
    await expect(
      evaluateAgentLoops(
        { runs: [run("conflict", "after")] },
        read({
          conflict: [
            meta("conflict"),
            usage("conflict", "turn", "same", tokens(100, 30, 7)),
            usage("conflict", "turn", "same", tokens(100, 30, 8)),
          ],
        }),
      ),
    ).rejects.toThrow("conflict:3: invalid Codex rollout record")
    await expect(
      evaluateAgentLoops(
        { runs: [run("malformed", "after")] },
        read({ malformed: [meta("malformed"), '{"payload":{"content":"secret!invalid'] }),
      ),
    ).rejects.toThrow(/^malformed:2: invalid Codex rollout record$/)
  })
})
