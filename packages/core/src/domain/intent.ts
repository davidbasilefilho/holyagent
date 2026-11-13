import { Effect, Schema } from "effect"

import { type Assignment, settle } from "./assignment.ts"
import { DuplicateRecord, IntentHasOpenWork, InvalidTransition } from "./errors.ts"
import { IntentId } from "./ids.ts"
import { decodeInput } from "./input.ts"
import { Revision, Text, TextList, Timestamp } from "./primitives.ts"
import { type Change, findIntent, type Project, requireOpen } from "./project.ts"
import { Slug, slugOf } from "./slug.ts"
import { type Registry, releaseSpecialist } from "./specialists.ts"

/** Whether an Intent still authorizes work. */
export const IntentState = Schema.Literals(["Open", "Closed"])
/** One Intent state. */
export type IntentState = typeof IntentState.Type

/**
 * The user's accepted task. The revision starts at 1 and moves only on a material change or a
 * reopen, so every Assignment can tell whether it was written against what is still wanted. A
 * closed Intent carries the reason it was closed.
 */
export const Intent = Schema.Struct({
  id: IntentId,
  slug: Slug,
  objective: Text,
  requirements: TextList,
  revision: Revision,
  state: IntentState,
  closeReason: Schema.optionalKey(Text),
  createdAt: Timestamp,
}).check(
  Schema.makeFilter((intent) =>
    (intent.state === "Closed") === (intent.closeReason !== undefined)
      ? undefined
      : "a closed Intent records why it closed, and an open one does not",
  ),
)
/** An accepted task with its live revision. */
export type Intent = typeof Intent.Type

/** Who creates an Intent and when; the id comes from `newId("intent")`. */
export const IntentDraft = Schema.Struct({
  id: IntentId,
  objective: Text,
  requirements: Schema.optionalKey(TextList),
  now: Timestamp,
})
/** A decoded Intent draft. */
export type IntentDraft = typeof IntentDraft.Type

/** A new open Intent at revision 1. The id must not be in use. */
export const createIntent = (project: Project, input: IntentDraft) =>
  Effect.gen(function* () {
    const draft = yield* decodeInput(IntentDraft, input)
    if (project.intents.some((existing) => existing.id === draft.id))
      return yield* new DuplicateRecord({ kind: "intent", id: draft.id })
    const intent: Intent = {
      id: draft.id,
      slug: slugOf(draft.objective),
      objective: draft.objective,
      requirements: draft.requirements ?? [],
      revision: 1,
      state: "Open",
      createdAt: draft.now,
    }
    return { intent, intents: [intent] } satisfies Change & { intent: Intent }
  })

/** A change to an open Intent. Only a `material` one moves the revision. */
export const IntentUpdate = Schema.Struct({
  objective: Schema.optionalKey(Text),
  requirements: Schema.optionalKey(TextList),
  material: Schema.Boolean,
})
/** A decoded Intent update. */
export type IntentUpdate = typeof IntentUpdate.Type

/**
 * Edits an open Intent. A material change bumps the revision, which makes every Assignment written
 * against the old one stale; a wording fix leaves it. The name of its folder does not change.
 */
export const updateIntent = (project: Project, intentId: string, input: IntentUpdate) =>
  Effect.gen(function* () {
    const update = yield* decodeInput(IntentUpdate, input)
    const current = yield* findIntent(project, intentId)
    yield* requireOpen(current)
    const intent: Intent = {
      ...current,
      objective: update.objective ?? current.objective,
      requirements: update.requirements ?? current.requirements,
      revision: update.material ? current.revision + 1 : current.revision,
    }
    return { intent, intents: [intent] } satisfies Change & { intent: Intent }
  })

/** Why an Intent closes, and the reason to drop the work that would otherwise block it. */
export const IntentClosing = Schema.Struct({
  reason: Text,
  /** Cancels Ready and Running Assignments with this reason instead of refusing to close. */
  drop: Schema.optionalKey(Text),
})
/** A decoded Intent closing. */
export type IntentClosing = typeof IntentClosing.Type

/**
 * Closes an open Intent. It is refused while an Assignment is Running or Succeeded but not
 * accepted, unless `drop` gives a reason, in which case the Ready and Running Assignments are
 * Cancelled with it and their specialists freed.
 */
export const closeIntent = (
  project: Project,
  registry: Registry,
  intentId: string,
  input: IntentClosing,
  now: string,
) =>
  Effect.gen(function* () {
    const closing = yield* decodeInput(IntentClosing, input)
    yield* decodeInput(Timestamp, now)
    const current = yield* findIntent(project, intentId)
    yield* requireOpen(current)
    const own = project.assignments.filter((row) => row.intentId === current.id)
    const running = own.filter((row) => row.state === "Running").map((row) => row.id)
    const unaccepted = own
      .filter((row) => row.state === "Succeeded" && row.acceptance === undefined)
      .map((row) => row.id)
    if (closing.drop === undefined && (running.length > 0 || unaccepted.length > 0))
      return yield* new IntentHasOpenWork({ intentId, running, unaccepted })
    const dropped: ReadonlyArray<Assignment> =
      closing.drop === undefined
        ? []
        : own
            .filter((row) => row.state === "Ready" || row.state === "Running")
            .map((row) => settle(row, "Cancelled", closing.drop ?? "", now))
    const intent: Intent = { ...current, state: "Closed", closeReason: closing.reason }
    return {
      intent,
      intents: [intent],
      assignments: dropped,
      registry: dropped.reduce(
        (kept, row) =>
          row.specialist?.agentId === undefined
            ? kept
            : releaseSpecialist(kept, row.specialist.agentId, { finishedAt: now }),
        registry,
      ),
    } satisfies Change & { intent: Intent }
  })

/** Reopens a closed Intent at the next revision, so work written before it is stale. */
export const reopenIntent = (project: Project, intentId: string) =>
  Effect.gen(function* () {
    const { closeReason: _reason, ...current } = yield* findIntent(project, intentId)
    if (current.state !== "Closed")
      return yield* new InvalidTransition({ id: intentId, state: current.state, action: "reopen" })
    const intent: Intent = { ...current, state: "Open", revision: current.revision + 1 }
    return { intent, intents: [intent] } satisfies Change & { intent: Intent }
  })
