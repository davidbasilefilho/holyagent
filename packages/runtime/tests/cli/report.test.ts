import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { Effect } from "effect"

import {
  dispatchedCall,
  dispatchPrompt,
  piJournalReports,
  piRecordReports,
} from "../../src/cli/report.ts"
import { PI_WORDS } from "../../src/domain/host.ts"
import { assignment } from "../fixtures.ts"

const lines = (...entries: ReadonlyArray<unknown>) =>
  entries.map((e) => JSON.stringify(e)).join("\n")

/** The key as the package computes it (`journalKey` in its src/workflow/journal.ts), written out. */
const packageKey = (fields: ReadonlyArray<string | null>): string =>
  createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 32)

const AGENT = "holyagent:worker-implementation"
const BRIEF = "/clone/.git/holyagent/briefs/assignment-a.md"
const first = assignment({ id: "assignment-a" })
const second = assignment({ id: "assignment-b", roleTask: "Reviewer.code" })

describe("dispatchedCall", () => {
  test("keys the call a pi script makes from the dispatch: prompt, label, agent, model, effort", () => {
    const prompt =
      "Role: Worker.implementation (holyagent:worker-implementation). Assignment: assignment-a.\nRead the brief at /clone/.git/holyagent/briefs/assignment-a.md with the read tool and follow it as your full task."
    expect(dispatchPrompt(first, AGENT, BRIEF, PI_WORDS)).toBe(prompt)
    expect(dispatchedCall(first, AGENT, BRIEF)).toEqual({
      id: "assignment-a",
      key: packageKey([
        prompt,
        "assignment-a",
        "sonnet",
        "worker-implementation",
        "high",
        null,
        null,
        null,
      ]),
    })
  })

  test("differs per Assignment and per route", () => {
    const keys = [
      dispatchedCall(first, AGENT, BRIEF).key,
      dispatchedCall(second, "holyagent:reviewer-code", BRIEF).key,
    ]
    expect(new Set(keys).size).toBe(2)
  })
})

describe("piJournalReports", () => {
  const calls = [
    dispatchedCall(first, AGENT, BRIEF),
    dispatchedCall(
      second,
      "holyagent:reviewer-code",
      "/clone/.git/holyagent/briefs/assignment-b.md",
    ),
  ]
  const source = "/tmp/wf_0123456789ab.workflow.jsonl"
  const run = (journal: string) => Effect.runPromise(piJournalReports(journal, source, calls))

  test("returns each matched report by Assignment id and lists the rest as the Claude path does", async () => {
    const result = await run(
      lines(
        { index: 0, key: calls[0]?.key, ok: true, text: "result: done\nevidence:\nworks: ran it" },
        { index: 1, key: calls[1]?.key, ok: false },
        { index: 2, key: "0".repeat(32), ok: true, text: "stray" },
        { index: 3, key: "1".repeat(32), ok: true, text: "" },
      ),
    )
    expect(result.reports).toEqual([
      { id: "assignment-a", report: "result: done\nevidence:\nworks: ran it" },
    ])
    expect(result.notAssignmentIds).toEqual([
      { label: "assignment-b", agentId: "wf_0123456789ab#1 failed" },
      { label: "", agentId: "wf_0123456789ab#2 unmatched" },
      { label: "", agentId: "wf_0123456789ab#3 empty" },
    ])
  })

  test("counts an ok entry with empty text as no report", async () => {
    const result = await run(lines({ index: 0, key: calls[0]?.key, ok: true, text: "\n " }))
    expect(result.reports).toEqual([])
    expect(result.notAssignmentIds).toEqual([
      { label: "assignment-a", agentId: "wf_0123456789ab#0 empty" },
    ])
  })

  test("refuses a journal with a bad line as a usage error and reports nothing", async () => {
    await expect(
      run(`${lines({ index: 0, key: calls[0]?.key, ok: true, text: "x" })}\n{`),
    ).rejects.toThrow(/line 2 is not a workflow journal entry/)
  })
})

describe("piRecordReports", () => {
  const record = (id: string, over: object = {}) => ({
    type: "custom",
    customType: "subagents:record",
    id: `e-${id}`,
    parentId: null,
    timestamp: "2026-11-08T10:00:00.000Z",
    data: {
      id,
      type: "worker-implementation",
      description: "assignment-a",
      status: "completed",
      result: `report of ${id}`,
      startedAt: 1,
      ...over,
    },
  })
  const run = (session: string) =>
    Effect.runPromise(
      piRecordReports(session, "session.jsonl", [
        { id: "assignment-a", agentId: "pi:agent-1" },
        { id: "assignment-b", agentId: "pi:agent-2" },
        { id: "assignment-c", agentId: "pi:agent-3" },
      ]),
    )

  test("reads the report of each pi:<agent-id> and lists the agents without one", async () => {
    const result = await run(
      lines(
        { type: "session", version: 3 },
        record("agent-1"),
        record("agent-2", { status: "error", result: undefined, error: "boom" }),
      ),
    )
    expect(result.reports).toEqual([{ id: "assignment-a", report: "report of agent-1" }])
    expect(result.notAssignmentIds).toEqual([
      { label: "assignment-b", agentId: "pi:agent-2 error" },
      { label: "assignment-c", agentId: "pi:agent-3 missing" },
    ])
  })

  test("refuses a record that does not decode", async () => {
    await expect(run(lines(record("agent-1", { status: "done" })))).rejects.toThrow(
      /line 1 is not a subagents:record entry/,
    )
  })
})
