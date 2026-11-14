import { Schema } from "effect"

import type { Config } from "../../config/schema.ts"
import { CODEX_PROVIDER_ID } from "./routes.ts"

/**
 * The share of the context window at which the server compacts, as Codex does (it compacts at 90%
 * of the window).
 */
export const COMPACT_THRESHOLD_SHARE = 0.9

/**
 * The window assumed when Pi does not say which model runs: the smaller of the two figures that
 * sources give for GPT-6.1, so the server compacts early rather than late.
 */
export const FALLBACK_CONTEXT_WINDOW = 272_000

/** The smallest `compact_threshold` the Responses API accepts. */
export const MINIMUM_THRESHOLD = 1000

/**
 * The `compact_threshold` for a context window: {@link COMPACT_THRESHOLD_SHARE} of it, never below
 * the API's minimum. Without a window the {@link FALLBACK_CONTEXT_WINDOW} stands in.
 */
export const compactThreshold = (contextWindow: number | undefined): number =>
  Math.max(
    MINIMUM_THRESHOLD,
    Math.floor((contextWindow ?? FALLBACK_CONTEXT_WINDOW) * COMPACT_THRESHOLD_SHARE),
  )

/**
 * Whether the Codex provider sends `context_management` for a config. Billion Context
 * (`pi.features.contextCompression`) is preferred: it compresses the history on the client and
 * keeps it retrievable, while the server-side compaction replaces the history with an opaque
 * encrypted item that cannot be searched or expanded, and the two would both rewrite the same
 * request. So the parameter is sent only for the Codex provider while Billion Context is off, and
 * its own switch (`pi.features.contextManagement`, on by default) is on.
 */
export const contextManagementOn = (config: Config): boolean =>
  (config.pi.provider === "openai-codex" ||
    Object.values(config.pi.routes).some((row) => row.provider === "openai-codex")) &&
  config.pi.features.contextManagement &&
  !config.pi.features.contextCompression

/** The part of a Responses request that the compaction reads: the model and the input items. */
const Request = Schema.Struct({ model: Schema.String, input: Schema.Array(Schema.Unknown) })

/** The compaction item the server emits: opaque, to be sent back as it came. */
const CompactionItem = Schema.Struct({
  type: Schema.Literal("compaction"),
  encrypted_content: Schema.String,
})

/** A finished output item in a Responses stream. */
const OutputItemDone = Schema.Struct({
  type: Schema.Literal("response.output_item.done"),
  item: CompactionItem,
})

const isRequest = Schema.is(Request)
const isCompactionDone = Schema.is(OutputItemDone)

/**
 * The compaction the session keeps: the opaque item, the number of Pi's own input items it stands
 * for (`anchor`, counted in Pi's full input, the one before any replacement), and the JSON of the
 * last of those items (`tail`), which shows that Pi's history still begins the same way.
 */
export interface Checkpoint {
  readonly item: unknown
  readonly anchor: number
  readonly tail: string
}

/**
 * What the module remembers between requests of one session. `pending` is the length of Pi's full
 * input in the request now in flight: a compaction item that arrives in its stream stands for that
 * many items, since the server compacts before it answers.
 */
export interface CompactionState {
  readonly checkpoint?: Checkpoint
  readonly pending?: { readonly anchor: number; readonly tail: string }
}

/** The state of a session that has compacted nothing. */
export const NO_COMPACTION: CompactionState = {}

/** A request after the module has handled it, with the state to keep for the next one. */
export interface PreparedRequest {
  readonly payload: unknown
  readonly state: CompactionState
}

const fingerprint = (item: unknown): string => JSON.stringify(item) ?? ""

/**
 * Adds `context_management: [{ type: "compaction", compact_threshold }]` to a Codex Responses
 * request and replays the compaction the server last made: the opaque item takes the place of the
 * Pi input items it stands for, so a long session carries the item and the recent items instead of
 * the whole history. A checkpoint is used only while Pi's history still starts with the items it
 * covered (same count, same last item); after a Pi compaction or a branch change it is dropped and
 * the full input goes. A payload that is not a Responses request is returned as it came, since the
 * hook sees every provider's payload.
 */
export const prepareRequest = (
  payload: unknown,
  state: CompactionState,
  threshold: number,
): PreparedRequest => {
  if (!isRequest(payload)) return { payload, state: NO_COMPACTION }
  const { input } = payload
  const { checkpoint } = state
  const valid =
    checkpoint !== undefined &&
    input.length >= checkpoint.anchor &&
    fingerprint(input[checkpoint.anchor - 1]) === checkpoint.tail
  const sent = valid ? [checkpoint.item, ...input.slice(checkpoint.anchor)] : input
  return {
    payload: {
      ...payload,
      input: sent,
      context_management: [{ type: "compaction", compact_threshold: threshold }],
    },
    state: {
      ...(valid ? { checkpoint } : {}),
      pending: { anchor: input.length, tail: fingerprint(input.at(-1)) },
    },
  }
}

/**
 * Records a compaction item from a Responses stream event. Only a finished `compaction` output item
 * counts, and only when a request is in flight; it replaces any earlier checkpoint, since the
 * server compacted the earlier item together with what followed it. Any other event leaves the
 * state as it was.
 */
export const observeStreamEvent = (state: CompactionState, data: unknown): CompactionState =>
  state.pending !== undefined && isCompactionDone(data)
    ? {
        checkpoint: { item: data.item, anchor: state.pending.anchor, tail: state.pending.tail },
        pending: state.pending,
      }
    : state

/** Whether a request or stream event belongs to the Codex provider, by Pi's provider id. */
export const isCodexProvider = (provider: string | undefined): boolean =>
  provider === CODEX_PROVIDER_ID
