import type { Assignment } from "../domain/assignment.ts"
import type { Intent } from "../domain/intent.ts"

/** Drops absent values and empty lists, so a record prints only what it holds. */
export const present = (record: Readonly<Record<string, unknown>>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0),
    ),
  )

/** Text on one line: runs of whitespace become a single space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

/** An Intent as the model reads it. */
export const intentView = (intent: Intent) =>
  present({
    id: intent.id,
    revision: intent.revision,
    state: intent.state,
    objective: intent.objective,
    requirements: intent.requirements,
    closeReason: intent.closeReason,
  })

/** An Assignment in full, with its acceptance. */
export const assignmentView = (assignment: Assignment) =>
  present({
    id: assignment.id,
    intent: assignment.intentId,
    revision: assignment.intentRevision,
    role: assignment.roleTask,
    state: assignment.state,
    objective: assignment.objective,
    scope: assignment.scope,
    constraints: assignment.constraints,
    criteria: assignment.criteria,
    evidence: assignment.evidence,
    paths: assignment.ownershipPaths,
    dependsOn: assignment.dependencies,
    independentFrom: assignment.independentFrom,
    followUpOf: assignment.followUpOf,
    agent: assignment.specialist?.agentId,
    startedAt: assignment.specialist?.startedAt,
    finishedAt: assignment.specialist?.finishedAt,
    result: assignment.result,
    acceptance:
      assignment.acceptance === undefined
        ? undefined
        : present({
            revision: assignment.acceptance.revision,
            carriedFrom: assignment.acceptance.carriedFrom,
            rationale: assignment.acceptance.rationale,
            criteria: assignment.acceptance.criteria,
            evidence: assignment.acceptance.evidence,
          }),
  })

/** One line of a list of Assignments. */
export const assignmentRow = (assignment: Assignment) => ({
  id: assignment.id,
  role: assignment.roleTask,
  state: assignment.state,
  rev: assignment.intentRevision,
  accepted: assignment.acceptance !== undefined,
  agent: assignment.specialist?.agentId ?? null,
  objective: oneLine(assignment.objective),
})

/** One line of a list of Intents. */
export const intentRow = (intent: Intent, inUse: boolean) => ({
  id: intent.id,
  state: intent.state,
  revision: intent.revision,
  inUse,
  objective: oneLine(intent.objective),
})

/** Orders records by id; generated ids start with their creation time, so this is creation order. */
export const byId = <T extends { readonly id: string }>(rows: ReadonlyArray<T>): Array<T> =>
  rows.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
