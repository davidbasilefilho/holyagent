import { Effect, Schema } from "effect"

import type { Acceptance, Assignment } from "./assignment.ts"
import { InsufficientAcceptance, InvalidTransition, StaleRevision } from "./errors.ts"
import { decodeInput } from "./input.ts"
import type { Intent } from "./intent.ts"
import { Text } from "./primitives.ts"
import { type Change, findAssignment, findIntent, type Project, requireOpen } from "./project.ts"

/** The root's acceptance of an Assignment, with the support it found for each check. */
export const AcceptanceInput = Schema.Struct({
  rationale: Text,
  criteria: Schema.Array(Schema.Struct({ criterion: Text, support: Text })),
  evidence: Schema.Array(Schema.Struct({ label: Text, support: Text })),
  /** Accept work done at an earlier revision at the live one; the rationale says why it holds. */
  carryForward: Schema.optionalKey(Schema.Boolean),
})
/** A decoded acceptance input. */
export type AcceptanceInput = typeof AcceptanceInput.Type

/** What stops the supports from covering the rubric, or undefined when they cover it. */
const coverageProblem = (assignment: Assignment, input: AcceptanceInput): string | undefined => {
  const checks = [
    {
      what: "criterion",
      declared: assignment.criteria.map((criterion) => criterion.text),
      required: assignment.criteria.filter((c) => c.blocking).map((c) => c.text),
      given: input.criteria.map(({ criterion }) => criterion),
    },
    {
      what: "evidence label",
      declared: assignment.evidence,
      required: assignment.evidence,
      given: input.evidence.map(({ label }) => label),
    },
  ]
  for (const { what, declared, required, given } of checks) {
    const unknown = given.find((key) => !declared.includes(key))
    if (unknown !== undefined) return `${unknown} is not a declared ${what}`
    const unsupported = required.find((key) => !given.includes(key))
    if (unsupported) return `${what} "${unsupported}" has no support`
  }
  return undefined
}

/**
 * Accepts a Succeeded Assignment at the Intent's live revision. The support must cover every
 * blocking criterion and every required evidence label; blank support is refused as invalid input.
 * Work done at an earlier revision (or accepted at one) is accepted only with `carryForward`, which
 * the record notes.
 */
export const acceptOn = (assignment: Assignment, intent: Intent, raw: AcceptanceInput) =>
  Effect.gen(function* () {
    const input = yield* decodeInput(AcceptanceInput, raw)
    if (assignment.state !== "Succeeded")
      return yield* new InvalidTransition({
        id: assignment.id,
        state: assignment.state,
        action: "accept",
      })
    yield* requireOpen(intent)
    const from = assignment.acceptance?.revision ?? assignment.intentRevision
    // A repeated carry-forward still points at the revision the work was done at.
    const workedAt = assignment.acceptance?.carriedFrom ?? from
    if (from === intent.revision && assignment.acceptance !== undefined)
      return yield* new InvalidTransition({
        id: assignment.id,
        state: "accepted at the live revision",
        action: "accept",
      })
    if (from !== intent.revision && input.carryForward !== true)
      return yield* new StaleRevision({ given: from, live: intent.revision })
    const problem = coverageProblem(assignment, input)
    if (problem !== undefined)
      return yield* new InsufficientAcceptance({ id: assignment.id, detail: problem })
    const acceptance: Acceptance = {
      revision: intent.revision,
      ...(from === intent.revision ? {} : { carriedFrom: workedAt }),
      rationale: input.rationale,
      criteria: input.criteria,
      evidence: input.evidence,
    }
    return { ...assignment, acceptance } satisfies Assignment
  })

/** Accepts the Assignment named by `assignmentId` (see {@link acceptOn}). */
export const accept = (project: Project, assignmentId: string, input: AcceptanceInput) =>
  Effect.gen(function* () {
    const assignment = yield* findAssignment(project, assignmentId)
    const intent = yield* findIntent(project, assignment.intentId)
    const accepted = yield* acceptOn(assignment, intent, input)
    return { assignment: accepted, assignments: [accepted] } satisfies Change & {
      assignment: Assignment
    }
  })
