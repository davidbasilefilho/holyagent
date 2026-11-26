import { dirname, resolve } from "node:path"

import { Schema } from "effect"

const open = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])
const Id = Schema.NonEmptyString
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Milliseconds = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
const Manifest = Schema.Struct({
  runs: Schema.NonEmptyArray(
    Schema.Struct({
      id: Id,
      scenario: Id,
      variant: Schema.Literals(["before", "after"]),
      origin: Schema.Literals(["native", "loopback"]),
      accepted: Schema.optionalKey(Id),
      firstUsefulProgressMs: Schema.optionalKey(Milliseconds),
      elapsedMs: Schema.optionalKey(Milliseconds),
      visibleTurns: Schema.optionalKey(Count),
      sessions: Schema.Array(Schema.Struct({ path: Id, assignment: Schema.optionalKey(Id) })),
    }),
  ),
})
const Envelope = open({ type: Id, timestamp: Id, payload: Schema.Unknown })
const Kind = open({ type: Id })
const Session = open({
  id: Id,
  cli_version: Id,
  session_id: Schema.optionalKey(Id),
  parent_thread_id: Schema.optionalKey(Id),
  forked_from_id: Schema.optionalKey(Id),
})
const Counter = open({ input_tokens: Count, cached_input_tokens: Count, output_tokens: Count })
const Response = open({
  response_id: Id,
  thread_id: Id,
  session_id: Id,
  turn_id: Id,
  usage: Counter,
})
const TokenCount = open({
  info: Schema.NullOr(open({ total_token_usage: Counter })),
})
const Turn = open({
  turn_id: Id,
  duration_ms: Schema.optionalKey(Schema.NullOr(Count)),
  time_to_first_token_ms: Schema.optionalKey(Schema.NullOr(Count)),
})
const TurnContext = open({
  turn_id: Schema.optionalKey(Schema.NullOr(Id)),
  root_turn_id: Schema.optionalKey(Schema.NullOr(Id)),
  model: Schema.optionalKey(Schema.NullOr(Id)),
  effort: Schema.optionalKey(Schema.NullOr(Id)),
})
const Call = open({ call_id: Id, name: Id })
const CallOutput = open({ call_id: Id })

interface Tokens {
  readonly cacheRead: number
  readonly fresh: number
  readonly output: number
}

const zero: Tokens = { cacheRead: 0, fresh: 0, output: 0 }
const add = (left: Tokens, right: Tokens): Tokens => ({
  cacheRead: left.cacheRead + right.cacheRead,
  fresh: left.fresh + right.fresh,
  output: left.output + right.output,
})
const subtract = (end: Tokens, start: Tokens): Tokens => ({
  cacheRead: end.cacheRead - start.cacheRead,
  fresh: end.fresh - start.fresh,
  output: end.output - start.output,
})
const readCounter = (counter: typeof Counter.Type): Tokens => {
  if (counter.cached_input_tokens > counter.input_tokens)
    throw new Error("cache-read exceeds input")
  return {
    cacheRead: counter.cached_input_tokens,
    fresh: counter.input_tokens - counter.cached_input_tokens,
    output: counter.output_tokens,
  }
}
const sameTokens = (left: Tokens, right: Tokens) =>
  left.cacheRead === right.cacheRead && left.fresh === right.fresh && left.output === right.output

const usage = (tokens: Tokens | null) => {
  if (!tokens) return null
  const { cacheRead, fresh, output } = tokens
  const input = cacheRead + fresh
  const total = input + output
  return {
    ...tokens,
    input,
    total,
    cacheRate: input ? cacheRead / input : null,
    shares: total
      ? { cacheRead: cacheRead / total, fresh: fresh / total, output: output / total }
      : null,
  }
}

const summarize = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  // Nearest rank. Keeping n visible prevents reading p95 from one sample as a stable tail.
  const quantile = (p: number) => sorted[Math.ceil(sorted.length * p) - 1] ?? null
  return { n: sorted.length, p50: quantile(0.5), p95: quantile(0.95) }
}

const decode = <A, I>(schema: Schema.Codec<A, I>) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })

const trace = (raw: string, label: string) => {
  let threadId: string | undefined
  let version: string | undefined
  let sessionId: string | undefined
  let parentThreadId: string | undefined
  let forkedFromThreadId: string | undefined
  const responses = new Map<string, { timestamp: string; turnId: string; tokens: Tokens }>()
  const turns = new Map<string, { state: string; duration: number | null; ttft: number | null }>()
  const turnContexts = new Map<
    string,
    { contexts: number; rootTurnId: string | null; model: string | null; effort: string | null }
  >()
  const waitStarts = new Map<string, number>()
  const waits = new Map<string, number>()
  const events: { timestamp: string; kind: string; id?: string; name?: string }[] = []
  let invalidWaitOutputs = 0
  let duplicateResponses = 0
  let cumulative: Tokens | null = null
  let deltaTotal: Tokens | null = null
  let snapshots = 0
  let resetIntervals = 0
  const lines = raw.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    try {
      const { type, timestamp, payload } = decode(Envelope)(JSON.parse(line))
      if (type === "session_meta") {
        const session = decode(Session)(payload)
        if (threadId && threadId !== session.id) throw new Error("multiple rollout threads")
        if (sessionId && session.session_id && sessionId !== session.session_id)
          throw new Error("multiple rollout sessions")
        threadId = session.id
        sessionId ??= session.session_id
        version = session.cli_version
        parentThreadId ??= session.parent_thread_id
        forkedFromThreadId ??= session.forked_from_id
        events.push({ timestamp, kind: type, id: threadId })
      } else if (type === "token_usage_record") {
        const record = decode(Response)(payload)
        if (record.thread_id !== threadId || (sessionId && record.session_id !== sessionId))
          throw new Error("usage record does not match rollout thread/session")
        sessionId = record.session_id
        const tokens = readCounter(record.usage)
        const prior = responses.get(record.response_id)
        if (prior) {
          if (prior.turnId !== record.turn_id || !sameTokens(prior.tokens, tokens))
            throw new Error("conflicting duplicate response")
          duplicateResponses++
        } else responses.set(record.response_id, { timestamp, turnId: record.turn_id, tokens })
      } else if (type === "turn_context") {
        const context = decode(TurnContext)(payload)
        events.push({ timestamp, kind: type, ...(context.turn_id ? { id: context.turn_id } : {}) })
        if (context.turn_id)
          turnContexts.set(context.turn_id, {
            contexts: (turnContexts.get(context.turn_id)?.contexts ?? 0) + 1,
            rootTurnId: context.root_turn_id ?? null,
            model: context.model ?? null,
            effort: context.effort ?? null,
          })
      } else if (type === "event_msg") {
        const event = decode(Kind)(payload)
        switch (event.type) {
          case "token_count": {
            const { info } = decode(TokenCount)(payload)
            if (!info) break
            const next = readCounter(info.total_token_usage)
            snapshots++
            if (cumulative) {
              const diff = subtract(next, cumulative)
              if (diff.cacheRead < 0 || diff.fresh < 0 || diff.output < 0) resetIntervals++
              else deltaTotal = add(deltaTotal ?? zero, diff)
            }
            cumulative = next
            break
          }
          case "task_started":
          case "task_complete":
          case "turn_aborted": {
            const turn = decode(Turn)(payload)
            if (event.type !== "task_started" || !turns.has(turn.turn_id)) {
              turns.set(turn.turn_id, {
                state: event.type,
                duration: turn.duration_ms ?? null,
                ttft: turn.time_to_first_token_ms ?? null,
              })
            }
            events.push({ timestamp, kind: event.type, id: turn.turn_id })
            break
          }
          case "stream_error":
            events.push({ timestamp, kind: event.type })
            break
        }
      } else if (type === "response_item") {
        const item = decode(Kind)(payload)
        if (item.type === "function_call") {
          const call = decode(Call)(payload)
          events.push({ timestamp, kind: "function_call", id: call.call_id, name: call.name })
          if (call.name === "wait_agent") {
            const start = Date.parse(timestamp)
            if (!Number.isFinite(start)) throw new Error("invalid wait start time")
            waitStarts.set(call.call_id, waitStarts.get(call.call_id) ?? start)
          }
        } else if (item.type === "function_call_output") {
          const { call_id: id } = decode(CallOutput)(payload)
          events.push({ timestamp, kind: "function_call_output", id })
          const start = waitStarts.get(id)
          if (start !== undefined && !waits.has(id)) {
            const duration = Date.parse(timestamp) - start
            if (!Number.isFinite(duration) || duration < 0) invalidWaitOutputs++
            else waits.set(id, duration)
          }
        }
      } else if (type === "compacted") events.push({ timestamp, kind: type })
    } catch {
      // An exported trace can contain prompts and tool output. Do not echo raw validation inputs.
      throw new Error(`${label}:${index + 1}: invalid Codex rollout record`)
    }
  }
  if (!threadId || !version) throw new Error(`${label}: missing Codex session metadata`)
  const tokenObservations = [...responses.entries()].map(([responseId, value]) => ({
    responseId,
    ...value,
  }))
  const tokens = responses.size
    ? tokenObservations.reduce((sum, record) => add(sum, record.tokens), zero)
    : deltaTotal
  const perTurn = new Map<string, Tokens>()
  for (const { turnId, tokens } of tokenObservations)
    perTurn.set(turnId, add(perTurn.get(turnId) ?? zero, tokens))
  const identifiers = new Set([...turns.keys(), ...turnContexts.keys(), ...perTurn.keys()])
  const turnStates = [...turns.values()]
  return {
    threadId,
    // Child threads can share the root session ID. Older exports may not establish it.
    sessionId: sessionId ?? null,
    parentThreadId: parentThreadId ?? null,
    forkedFromThreadId: forkedFromThreadId ?? null,
    version,
    tokens,
    usage: usage(tokens),
    coverage: {
      method: responses.size
        ? "response-records"
        : deltaTotal
          ? "cumulative-deltas"
          : "unavailable",
      completedResponsesWithUsage: tokenObservations.length,
      duplicateResponses,
      cumulativeSnapshots: snapshots,
      initialCounterUnobserved: !responses.size && snapshots > 0,
      resetIntervals: responses.size ? 0 : resetIntervals,
      // Missing failed attempts, compaction usage, or unstaged threads cannot be recovered here.
      totalModelInvocations: null,
      retryAttempts: null,
      contextResends: null,
    },
    turns: {
      observed: turns.size,
      completed: turnStates.filter((turn) => turn.state === "task_complete").length,
      aborted: turnStates.filter((turn) => turn.state === "turn_aborted").length,
    },
    turnElapsedMs: turnStates.flatMap((turn) => (turn.duration === null ? [] : [turn.duration])),
    firstTokenMs: turnStates.flatMap((turn) => (turn.ttft === null ? [] : [turn.ttft])),
    waitMs: [...waits.values()],
    unmatchedWaits: waitStarts.size - waits.size,
    invalidWaitOutputs,
    tokenObservations,
    turnObservations: [...identifiers].map((id) => {
      const context = turnContexts.get(id)
      return {
        id,
        rootTurnId: context?.rootTurnId ?? null,
        model: context?.model ?? null,
        effort: context?.effort ?? null,
        contextRecords: context?.contexts ?? 0,
        state: turns.get(id)?.state ?? null,
        observedUsage: usage(perTurn.get(id) ?? null),
      }
    }),
    observedCompactions: events.filter(({ kind }) => kind === "compacted").length,
    events,
  }
}

interface ObservedUnit {
  readonly tokens: Tokens | null
  readonly coverage: { readonly method: string; readonly completedResponsesWithUsage: number }
  readonly turns: {
    readonly observed: number
    readonly completed: number
    readonly aborted: number
  }
  readonly turnElapsedMs: readonly number[]
  readonly firstTokenMs: readonly number[]
  readonly waitMs: readonly number[]
  readonly unmatchedWaits: number
}

const aggregate = (units: readonly ObservedUnit[]) => {
  let total: Tokens | null = null
  for (const { tokens } of units) if (tokens) total = add(total ?? zero, tokens)
  return {
    observedUsage: usage(total),
    threads: units.length,
    threadsWithResponseUsage: units.filter((unit) => unit.coverage.method === "response-records")
      .length,
    threadsWithCounterDeltas: units.filter((unit) => unit.coverage.method === "cumulative-deltas")
      .length,
    threadsWithoutUsage: units.filter((unit) => unit.coverage.method === "unavailable").length,
    completedResponsesWithUsage: units.reduce(
      (sum, unit) => sum + unit.coverage.completedResponsesWithUsage,
      0,
    ),
    nativeTurns: units.reduce(
      (sum, { turns }) => ({
        observed: sum.observed + turns.observed,
        completed: sum.completed + turns.completed,
        aborted: sum.aborted + turns.aborted,
      }),
      { observed: 0, completed: 0, aborted: 0 },
    ),
    turnElapsedMs: summarize(units.flatMap((unit) => unit.turnElapsedMs)),
    firstTokenMs: summarize(units.flatMap((unit) => unit.firstTokenMs)),
    waitMs: summarize(units.flatMap((unit) => unit.waitMs)),
    unmatchedWaits: units.reduce((sum, unit) => sum + unit.unmatchedWaits, 0),
  }
}

const groupBy = <A, K>(items: readonly A[], key: (item: A) => K) => {
  const groups = new Map<K, A[]>()
  for (const item of items) {
    const id = key(item)
    const existing = groups.get(id)
    if (existing) existing.push(item)
    else groups.set(id, [item])
  }
  return [...groups.entries()]
}

/** Analyze explicitly supplied Codex rollout exports without opening any other session files. */
export const evaluateAgentLoops = async (
  input: unknown,
  read: (path: string) => Promise<string>,
) => {
  const { runs } = Schema.decodeUnknownSync(Manifest, { onExcessProperty: "error" })(input)
  const runIds = new Set<string>()
  const threadIds = new Set<string>()
  const observeRun = async (run: (typeof runs)[number]) => {
    if (runIds.has(run.id)) throw new Error(`duplicate run ID: ${run.id}`)
    runIds.add(run.id)
    if (
      run.firstUsefulProgressMs !== undefined &&
      run.elapsedMs !== undefined &&
      run.firstUsefulProgressMs > run.elapsedMs
    )
      throw new Error(`useful progress exceeds elapsed time: ${run.id}`)
    const threads = await Promise.all(
      run.sessions.map(async ({ path, assignment }) => {
        const roll = trace(await read(path), path)
        if (threadIds.has(roll.threadId))
          throw new Error(`duplicate rollout thread: ${roll.threadId}`)
        threadIds.add(roll.threadId)
        return { ...roll, assignment: assignment ?? null }
      }),
    )
    return {
      id: run.id,
      scenario: run.scenario,
      variant: run.variant,
      origin: run.origin,
      accepted: run.accepted ?? null,
      completedTasks: run.accepted === undefined ? 0 : 1,
      firstUsefulProgressMs: run.firstUsefulProgressMs ?? null,
      elapsedMs: run.elapsedMs ?? null,
      visibleTurns: run.visibleTurns ?? null,
      ...aggregate(threads),
      sessions: groupBy(threads, (thread) => thread.sessionId ?? thread.threadId).map(
        ([id, members]) => ({
          id,
          ...aggregate(members),
        }),
      ),
      assignments: groupBy(threads, (thread) => thread.assignment).map(([id, members]) => ({
        id,
        ...aggregate(members),
      })),
      nativeThreads: threads,
    }
  }
  const observed: Awaited<ReturnType<typeof observeRun>>[] = []
  for (const run of runs) observed.push(await observeRun(run))
  const summarizeRuns = (cohort: typeof observed) => ({
    completedTasks: cohort.length,
    firstUsefulProgressMs: summarize(cohort.flatMap((run) => run.firstUsefulProgressMs ?? [])),
    elapsedMs: summarize(cohort.flatMap((run) => run.elapsedMs ?? [])),
    visibleTurns: summarize(cohort.flatMap((run) => run.visibleTurns ?? [])),
    observedTokensPerTask: summarize(cohort.flatMap((run) => run.observedUsage?.total ?? [])),
    ...aggregate(cohort.flatMap((run) => run.nativeThreads)),
  })
  const comparisons = groupBy(
    observed.filter((run) => run.accepted !== null),
    (run) => JSON.stringify([run.origin, run.scenario, run.accepted]),
  ).flatMap(([, cohort]) => {
    const first = cohort[0]
    const before = cohort.filter((run) => run.variant === "before")
    const after = cohort.filter((run) => run.variant === "after")
    return first && before.length && after.length
      ? [
          {
            origin: first.origin,
            scenario: first.scenario,
            accepted: first.accepted,
            before: summarizeRuns(before),
            after: summarizeRuns(after),
          },
        ]
      : []
  })
  return { runs: observed, comparisons }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3) {
    process.stderr.write("Usage: bun scripts/agent-loop-evidence.ts <manifest.json>\n")
    process.exitCode = 1
  } else {
    try {
      const manifest: unknown = JSON.parse(await Bun.file(path).text())
      const result = await evaluateAgentLoops(manifest, (file) =>
        Bun.file(resolve(dirname(path), file)).text(),
      )
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Unable to evaluate traces"}\n`,
      )
      process.exitCode = 1
    }
  }
}
