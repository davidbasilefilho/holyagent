import { createHash } from "node:crypto"

import { Data, Effect, Schema } from "effect"

/**
 * The fields of an `agent()` call that `@tintinweb/pi-subagents` hashes into the key of a journal
 * entry; a field the script did not pass is absent.
 */
export interface JournalKeyInput {
  readonly prompt: string
  readonly label?: string
  readonly model?: string | undefined
  readonly agentType?: string
  readonly effort?: string | undefined
  readonly isolation?: string
  readonly gate?: string
  readonly resume?: string
  /** The serialized `agent({ schema })`, when the call asked for one. */
  readonly schema?: string
}

/** The number of hex characters of the SHA-256 digest the package keeps as the key. */
const KEY_LENGTH = 32

/**
 * The key of a call in the workflow journal, computed as `journalKey` of the package's
 * `src/workflow/journal.ts` computes it: the first 32 hex characters of the SHA-256 of the JSON of
 * `[prompt, label, model, agentType, effort, isolation, gate, resume]`, a field that is absent
 * written as `null`, with the serialized schema appended only when the call had one. The journal
 * carries no label, so this is how an entry is tied back to the call that made it.
 */
export const journalKey = (input: JournalKeyInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.prompt,
        input.label ?? null,
        input.model ?? null,
        input.agentType ?? null,
        input.effort ?? null,
        input.isolation ?? null,
        input.gate ?? null,
        input.resume ?? null,
        ...(input.schema !== undefined ? [input.schema] : []),
      ]),
    )
    .digest("hex")
    .slice(0, KEY_LENGTH)

/** A pi session or workflow journal that cannot be read as the package writes it. */
export class InvalidPiRecord extends Data.TaggedError("InvalidPiRecord")<{
  /** The file that was read. */
  readonly source: string
  /** What is wrong, with the line number where one is to blame. */
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.source}: ${this.detail}`
  }
}

/** One settled `agent()` call of a workflow run, as the package appends it to the journal. */
const JournalEntry = Schema.Struct({
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  key: Schema.String,
  ok: Schema.Boolean,
  text: Schema.optionalKey(Schema.String),
  resumed: Schema.optionalKey(Schema.Literal(true)),
})
const JournalLine = Schema.fromJsonString(JournalEntry)

/** One settled `agent()` call of a workflow run. */
export type PiJournalEntry = typeof JournalEntry.Type

/**
 * The entries of a `<run id>.workflow.jsonl`, in position order. Each line is decoded strictly, so
 * a field the package adds later is refused rather than guessed at; a line that does not decode
 * refuses the whole journal, so no report is lost to a partial read.
 */
export const decodePiJournal = (journal: string, source: string) =>
  Effect.gen(function* () {
    const entries: Array<PiJournalEntry> = []
    for (const [at, line] of journal.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue
      entries.push(
        yield* Schema.decodeUnknownEffect(JournalLine)(line, { onExcessProperty: "error" }).pipe(
          Effect.mapError(
            (error) =>
              new InvalidPiRecord({
                source,
                detail: `line ${at + 1} is not a workflow journal entry: ${error.message}`,
              }),
          ),
        ),
      )
    }
    return entries.toSorted((a, b) => a.index - b.index)
  })

/** An Assignment and the key its dispatched call has in the journal. */
export interface ExpectedCall {
  readonly id: string
  readonly key: string
}

/** Why a journal entry yields no report. */
export type NoReport = "failed" | "empty" | "unmatched"

/** A journal entry that yields no report. */
export interface NotReported {
  readonly index: number
  /** The Assignment the entry belongs to; undefined when no dispatched call has its key. */
  readonly id: string | undefined
  readonly reason: NoReport
}

/** The report of one Assignment, from the last entry of its call. */
export interface MatchedReport {
  readonly id: string
  readonly index: number
  readonly report: string
}

const nonEmpty = (text: string | undefined): text is string =>
  text !== undefined && text.trim() !== ""

/**
 * Ties each journal entry to the Assignment whose dispatched call has its key. An Assignment's last
 * entry decides (a call that was retried or resumed keeps its last result, as the Claude journal's
 * repeated label does): an `ok` entry with text is its report, and a failed one, or an `ok` one
 * with no text, is listed as `failed` or `empty` under the Assignment. An entry no call matches is
 * listed as `unmatched` (`failed` when it did not succeed, `empty` when it has no text), because
 * its Assignment is unknown.
 */
export const matchJournal = (
  entries: ReadonlyArray<PiJournalEntry>,
  expected: ReadonlyArray<ExpectedCall>,
): {
  readonly reports: ReadonlyArray<MatchedReport>
  readonly notReported: ReadonlyArray<NotReported>
} => {
  const idOf = new Map(expected.map(({ id, key }) => [key, id]))
  const last = new Map<string, PiJournalEntry>()
  const unmatched: Array<NotReported> = []
  for (const entry of entries) {
    const id = idOf.get(entry.key)
    if (id !== undefined) last.set(id, entry)
    else
      unmatched.push({
        index: entry.index,
        id: undefined,
        reason: !entry.ok ? "failed" : nonEmpty(entry.text) ? "unmatched" : "empty",
      })
  }
  const reports: Array<MatchedReport> = []
  const notReported = [...unmatched]
  for (const [id, entry] of last)
    if (entry.ok && nonEmpty(entry.text))
      reports.push({ id, index: entry.index, report: entry.text })
    else notReported.push({ index: entry.index, id, reason: entry.ok ? "empty" : "failed" })
  return {
    reports: reports.toSorted((a, b) => a.index - b.index),
    notReported: notReported.toSorted((a, b) => a.index - b.index),
  }
}

/** The `customType` of the session entry a finished direct agent leaves in the root session. */
export const AGENT_RECORD_ENTRY_TYPE = "subagents:record"

/** The snapshot of a finished direct agent, as `subagents:record` holds it. */
const AgentRecordData = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  description: Schema.String,
  status: Schema.Literals([
    "queued",
    "running",
    "completed",
    "steered",
    "aborted",
    "stopped",
    "error",
  ]),
  result: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  startedAt: Schema.Number,
  completedAt: Schema.optionalKey(Schema.Number),
  sessionFile: Schema.optionalKey(Schema.String),
  handle: Schema.optionalKey(Schema.String),
  alias: Schema.optionalKey(Schema.String),
  worktreeLost: Schema.optionalKey(Schema.Boolean),
})

/** The envelope of a session file line, with the tree fields every entry has. */
const RecordEntry = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.Literal(AGENT_RECORD_ENTRY_TYPE),
  data: AgentRecordData,
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
})
const RecordLine = Schema.fromJsonString(RecordEntry)

/** Any line of a session file, read for the two fields that tell a record entry apart. */
const SessionLine = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, customType: Schema.optionalKey(Schema.String) }),
)

/** The persisted snapshot of a finished direct agent. */
export type PiAgentRecord = typeof AgentRecordData.Type

/** The root session holds no finished record of the agent. */
export class PiRecordMissing extends Data.TaggedError("PiRecordMissing")<{
  readonly source: string
  readonly agentId: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.source} holds no ${AGENT_RECORD_ENTRY_TYPE} entry for agent ${this.agentId}: it is still running, was evicted before it was persisted, or belongs to another session`
  }
}

/**
 * The record of a direct agent in a root session file (JSON lines): the last `subagents:record`
 * entry whose `id` is the agent's, since a resumed agent appends one on each finish. A record entry
 * is decoded strictly and refuses the file when it does not decode; every other line belongs to Pi
 * and is ignored.
 */
export const agentRecordIn = (session: string, source: string, agentId: string) =>
  Effect.gen(function* () {
    let found: PiAgentRecord | undefined
    for (const [at, line] of session.split(/\r?\n/).entries()) {
      // A cheap test first: a session file is mostly messages, which this never needs to parse.
      if (!line.includes(AGENT_RECORD_ENTRY_TYPE)) continue
      const probe = yield* Schema.decodeUnknownEffect(SessionLine)(line).pipe(Effect.option)
      if (
        probe._tag === "None" ||
        probe.value.type !== "custom" ||
        probe.value.customType !== AGENT_RECORD_ENTRY_TYPE
      )
        continue
      const { data } = yield* Schema.decodeUnknownEffect(RecordLine)(line, {
        onExcessProperty: "error",
      }).pipe(
        Effect.mapError(
          (error) =>
            new InvalidPiRecord({
              source,
              detail: `line ${at + 1} is not a ${AGENT_RECORD_ENTRY_TYPE} entry: ${error.message}`,
            }),
        ),
      )
      if (data.id === agentId) found = data
    }
    return found ?? (yield* new PiRecordMissing({ source, agentId }))
  })

/**
 * How a pi child ended, as far as the Assignment is concerned: `ok` (a settled run with a report),
 * `error` (the package's `error` status, a provider failure or `stopReason` `error`), `aborted`
 * (the package's `aborted` status, `agent_settled` with `aborted: true`), `stopped` (the root
 * stopped it), `length` (the final turn stopped on the token limit), `empty` (it settled with no
 * report text) and `exit` (the process ended before it settled).
 */
export type PiOutcome = "ok" | "error" | "aborted" | "stopped" | "length" | "empty" | "exit"

/** The Assignment status of the table in `docs/pi/orchestration.md`, and how to close it. */
export interface PiAssignmentStatus {
  /** The row of the table: `done` (reported), `failed` or `interrupted`. */
  readonly status: "done" | "failed" | "interrupted"
  /** The `--outcome` of `assignment close` that records it. */
  readonly close: "success" | "errored" | "interrupted" | "stopped"
}

const STATUS_OF: Readonly<Record<PiOutcome, PiAssignmentStatus>> = {
  ok: { status: "done", close: "success" },
  error: { status: "failed", close: "errored" },
  length: { status: "failed", close: "errored" },
  empty: { status: "failed", close: "errored" },
  exit: { status: "failed", close: "errored" },
  aborted: { status: "failed", close: "errored" },
  stopped: { status: "interrupted", close: "stopped" },
}

/**
 * The Assignment status of an outcome, per the table of events in `docs/pi/orchestration.md`: `ok`
 * is done; `error`, `length`, `empty`, `exit` and `aborted` are failed, closed as `errored` because
 * no usable report came back; `aborted` is failed too (the package's hard abort after the turn
 * limit is a failed run, not one the root should resume); only `stopped`, the root's own stop, is
 * interrupted. The package counts a `length` stop that produced text as completed, so a record
 * cannot show it: whoever sees the stop reason passes `length`.
 */
export const assignmentStatusOf = (outcome: PiOutcome): PiAssignmentStatus => STATUS_OF[outcome]

/**
 * The outcome of a persisted direct agent: `completed` and `steered` (it was asked to wrap up and
 * did) are `ok` with a report and `empty` without one; `error`, `aborted` and `stopped` are
 * themselves; a record still `queued` or `running` ended with the process (`exit`).
 */
export const outcomeOfRecord = (record: PiAgentRecord): PiOutcome => {
  switch (record.status) {
    case "completed":
    case "steered":
      return nonEmpty(record.result) ? "ok" : "empty"
    case "error":
    case "aborted":
    case "stopped":
      return record.status
    case "queued":
    case "running":
      return "exit"
  }
}

/**
 * The report of a direct agent from the root session file, with the Assignment status of how it
 * ended (`ended`); `report` is the record's full result and is undefined unless it ended `ok`.
 */
export const piRecordReport = (session: string, source: string, agentId: string) =>
  agentRecordIn(session, source, agentId).pipe(
    Effect.map((record) => {
      const outcome = outcomeOfRecord(record)
      return {
        ended: outcome,
        ...assignmentStatusOf(outcome),
        report: outcome === "ok" ? record.result : undefined,
        error: record.error,
      }
    }),
  )
