import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import {
  agentRecordIn,
  assignmentStatusOf,
  decodePiJournal,
  journalKey,
  matchJournal,
  outcomeOfRecord,
  type PiAgentRecord,
  type PiAssignmentStatus,
  type PiJournalEntry,
  type PiOutcome,
  piRecordReport,
} from "../../src/pi/journal.ts"

const lines = (...entries: ReadonlyArray<unknown>) =>
  entries.map((e) => JSON.stringify(e)).join("\n")

describe("journalKey", () => {
  // Each key below was computed by `journalKey` of @tintinweb/pi-subagents 0.23.1
  // (dist/workflow/journal.js) for the same input, so a change in the serialization shows here.
  test("is the key the package computes: a bare prompt, with absent fields as null", () => {
    expect(journalKey({ prompt: "Read it" })).toBe("4500564177deb40825f6aa0e4559903c")
  })

  test("is the key the package computes for a dispatched call", () => {
    expect(
      journalKey({
        prompt:
          "Role: Worker.implementation (holyagent:worker-implementation). Assignment: assignment-0mw7gtfu7-bypr.\nRead the brief at /tmp/b/briefs/assignment-0mw7gtfu7-bypr.md with the read tool and follow it as your full task.",
        label: "assignment-0mw7gtfu7-bypr",
        model: "sonnet",
        agentType: "worker-implementation",
        effort: "medium",
      }),
    ).toBe("adfd81949cfd9fd3175a704da8600616")
  })

  test("is the key the package computes with every field, the schema last", () => {
    expect(
      journalKey({
        prompt: "p",
        label: "l",
        model: "m",
        agentType: "a",
        effort: "e",
        isolation: "worktree",
        gate: "bun test",
        resume: "r",
        schema: '{"type":"object"}',
      }),
    ).toBe("16f9dfa031d925159d218e3dc98e2e8c")
  })

  test("appends the schema only when there is one, so a schema changes the key", () => {
    expect(journalKey({ prompt: "p", schema: '{"type":"object"}' })).toBe(
      "be6628aa01e4704e72947c2a972d32ab",
    )
    expect(journalKey({ prompt: "p" })).not.toBe(journalKey({ prompt: "p", schema: "null" }))
  })
})

describe("decodePiJournal", () => {
  const run = (text: string) => Effect.runPromise(decodePiJournal(text, "run.workflow.jsonl"))

  test("reads the entries in position order, with blank lines skipped", async () => {
    const entries = await run(
      `${lines(
        { index: 1, key: "b", ok: false, resumed: true },
        { index: 0, key: "a", ok: true, text: "result: done" },
      )}\n\n`,
    )
    expect(entries.map(({ index }) => index)).toEqual([0, 1])
    expect(entries[0]?.text).toBe("result: done")
    expect(entries[1]?.resumed).toBe(true)
  })

  test("refuses a field the package does not write", async () => {
    await expect(run(lines({ index: 0, key: "a", ok: true, label: "x" }))).rejects.toThrow(
      /run\.workflow\.jsonl: line 1 is not a workflow journal entry/,
    )
  })

  test("refuses a line that is not JSON, or lacks a field, naming the line", async () => {
    await expect(run(`${lines({ index: 0, key: "a", ok: true })}\nnot json`)).rejects.toThrow(
      /line 2 is not a workflow journal entry/,
    )
    await expect(run(lines({ index: -1, key: "a", ok: true }))).rejects.toThrow(/line 1/)
    await expect(run(lines({ index: 0, key: "a" }))).rejects.toThrow(/line 1/)
  })
})

describe("matchJournal", () => {
  const entry = (over: Partial<PiJournalEntry> & Pick<PiJournalEntry, "index" | "key">) => ({
    ok: true,
    text: "report",
    ...over,
  })
  /** A call that did not succeed: the package writes no text for it. */
  const failed = (index: number, key: string): PiJournalEntry => ({ index, key, ok: false })
  const expected = [
    { id: "assignment-a", key: "key-a" },
    { id: "assignment-b", key: "key-b" },
    { id: "assignment-c", key: "key-c" },
  ]

  test("gives the report of each Assignment by its key and lists what has none", () => {
    const { reports, notReported } = matchJournal(
      [
        entry({ index: 0, key: "key-a", text: "A" }),
        failed(1, "key-b"),
        entry({ index: 2, key: "key-c", text: "  " }),
        entry({ index: 3, key: "other", text: "stray" }),
        failed(4, "other"),
        entry({ index: 5, key: "blank", text: "" }),
      ],
      expected,
    )
    expect(reports).toEqual([{ id: "assignment-a", index: 0, report: "A" }])
    expect(notReported).toEqual([
      { index: 1, id: "assignment-b", reason: "failed" },
      { index: 2, id: "assignment-c", reason: "empty" },
      { index: 3, id: undefined, reason: "unmatched" },
      { index: 4, id: undefined, reason: "failed" },
      { index: 5, id: undefined, reason: "empty" },
    ])
  })

  test("lets the last entry of an Assignment decide, as a repeated label does", () => {
    const retried = matchJournal(
      [failed(0, "key-a"), entry({ index: 1, key: "key-a", text: "second" })],
      expected,
    )
    expect(retried.reports).toEqual([{ id: "assignment-a", index: 1, report: "second" }])
    expect(retried.notReported).toEqual([])
    const lost = matchJournal([entry({ index: 0, key: "key-a" }), failed(1, "key-a")], expected)
    expect(lost.reports).toEqual([])
    expect(lost.notReported).toEqual([{ index: 1, id: "assignment-a", reason: "failed" }])
  })
})

describe("agent records", () => {
  const record = (over: Partial<PiAgentRecord> = {}): PiAgentRecord => ({
    id: "agent-1",
    type: "worker-implementation",
    description: "assignment-a",
    status: "completed",
    result: "result: done\nevidence:\nworks: ran it",
    startedAt: 1,
    completedAt: 2,
    ...over,
  })
  const entryLine = (data: PiAgentRecord, id = "e1") => ({
    type: "custom",
    customType: "subagents:record",
    data,
    id,
    parentId: null,
    timestamp: "2026-11-08T10:00:00.000Z",
  })
  const header = {
    type: "session",
    version: 3,
    id: "s",
    timestamp: "2026-11-08T09:00:00.000Z",
    cwd: "/p",
  }
  // A message that mentions the entry type must not be mistaken for a record.
  const chatter = {
    type: "message",
    id: "m1",
    parentId: null,
    message: { role: "user", content: "see subagents:record entries" },
  }
  const read = (session: string, agentId = "agent-1") =>
    Effect.runPromise(piRecordReport(session, "session.jsonl", agentId))

  test("reads the full result of the agent, the last record winning", async () => {
    const session = lines(
      header,
      chatter,
      entryLine(record({ result: "first" }), "e1"),
      entryLine(record({ id: "agent-2", result: "other" }), "e2"),
      entryLine(record({ result: "second, after a resume" }), "e3"),
    )
    expect(await read(session)).toMatchObject({
      ended: "ok",
      status: "done",
      report: "second, after a resume",
    })
  })

  test("gives no report unless the agent ended ok, and says how it ended", async () => {
    const ended = (over: Partial<PiAgentRecord>) =>
      read(
        lines(
          header,
          entryLine({
            id: "agent-1",
            type: "worker-implementation",
            description: "assignment-a",
            status: "completed",
            startedAt: 1,
            ...over,
          }),
        ),
      )
    expect(await ended({ status: "error", error: "provider down" })).toMatchObject({
      ended: "error",
      status: "failed",
      report: undefined,
      error: "provider down",
    })
    expect(await ended({ status: "completed", result: "  " })).toMatchObject({
      ended: "empty",
      report: undefined,
    })
    expect(await ended({ status: "aborted" })).toMatchObject({
      ended: "aborted",
      status: "failed",
    })
    expect(await ended({ status: "running" })).toMatchObject({ ended: "exit", status: "failed" })
  })

  test("fails with PiRecordMissing for an agent with no record", async () => {
    await expect(read(lines(header, chatter), "agent-9")).rejects.toThrow(
      /holds no subagents:record entry for agent agent-9/,
    )
    await expect(
      Effect.runPromise(
        agentRecordIn(lines(header), "session.jsonl", "agent-1").pipe(
          Effect.catchTag("PiRecordMissing", (error) => Effect.succeed(error._tag)),
        ),
      ),
    ).resolves.toBe("PiRecordMissing")
  })

  test("refuses a record entry that does not decode, naming the line", async () => {
    const bad = { ...entryLine(record()), data: { ...record(), extra: true } }
    await expect(read(lines(header, bad))).rejects.toThrow(
      /session\.jsonl: line 2 is not a subagents:record entry/,
    )
    const noStatus = { ...entryLine(record()), data: { id: "agent-1", type: "t", startedAt: 1 } }
    await expect(read(lines(header, noStatus))).rejects.toThrow(/line 2/)
  })
})

describe("assignmentStatusOf", () => {
  const cases: ReadonlyArray<
    readonly [PiOutcome, PiAssignmentStatus["status"], PiAssignmentStatus["close"]]
  > = [
    ["ok", "done", "success"],
    ["error", "failed", "errored"],
    ["length", "failed", "errored"],
    ["empty", "failed", "errored"],
    ["exit", "failed", "errored"],
    ["aborted", "failed", "errored"],
    ["stopped", "interrupted", "stopped"],
  ]
  test.each(cases)("%s is %s, closed as %s", (outcome, status, close) => {
    expect(assignmentStatusOf(outcome)).toEqual({ status, close })
  })

  test("maps the package's record statuses", () => {
    const of = (status: PiAgentRecord["status"], result?: string) =>
      outcomeOfRecord({
        id: "a",
        type: "t",
        description: "d",
        status,
        startedAt: 1,
        ...(result === undefined ? {} : { result }),
      })
    expect(of("completed", "text")).toBe("ok")
    expect(of("steered", "text")).toBe("ok")
    expect(of("completed")).toBe("empty")
    expect(of("error")).toBe("error")
    expect(of("aborted")).toBe("aborted")
    expect(of("stopped")).toBe("stopped")
    expect(of("queued")).toBe("exit")
  })
})
