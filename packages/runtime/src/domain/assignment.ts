import { Effect, Schema } from "effect"

import {
  DuplicateRecord,
  InvalidDraft,
  InvalidPath,
  MissingOwnership,
  UnknownRecord,
} from "./errors.ts"
import { AgentId, AssignmentId, IntentId } from "./ids.ts"
import { decodeInput } from "./input.ts"
import { pathProblem, PortablePath } from "./paths.ts"
import { Revision, Text, TextList, Timestamp } from "./primitives.ts"
import { type Change, findIntent, type Project, requireLive, requireOpen } from "./project.ts"
import { Effort, isWriter, Model, RoleTask } from "./route.ts"
import { Slug, slugOf } from "./slug.ts"

/** What a mergeability check looks at. */
export const Dimension = Schema.Literals([
  "behavior",
  "regressions",
  "tests",
  "scope",
  "style",
  "repo-standards",
])
/** One mergeability dimension. */
export type Dimension = typeof Dimension.Type

/** One acceptance criterion of the mergeability rubric. A blocking criterion must be supported. */
export const Criterion = Schema.Struct({
  text: Text,
  blocking: Schema.Boolean,
  dimension: Dimension,
})
/** One acceptance criterion. */
export type Criterion = typeof Criterion.Type

/** The root's review of one Succeeded Assignment, with the support it found for each check. */
export const Acceptance = Schema.Struct({
  /** The live Intent revision it was accepted at. */
  revision: Revision,
  /** The revision the work was done at, when it was carried forward to a later one. */
  carriedFrom: Schema.optionalKey(Revision),
  rationale: Text,
  criteria: Schema.Array(Schema.Struct({ criterion: Text, support: Text })),
  evidence: Schema.Array(Schema.Struct({ label: Text, support: Text })),
})
/** An acceptance record. */
export type Acceptance = typeof Acceptance.Type

/** The specialist an Assignment runs on. The agent id is known once the launch is recorded. */
export const Specialist = Schema.Struct({
  agentId: Schema.optionalKey(AgentId),
  model: Model,
  effort: Effort,
  startedAt: Timestamp,
  finishedAt: Schema.optionalKey(Timestamp),
})
/** A bound specialist. */
export type Specialist = typeof Specialist.Type

/** Lifecycle of an Assignment. Succeeded means executed; acceptance is a separate record. */
export const AssignmentState = Schema.Literals([
  "Ready",
  "Running",
  "Succeeded",
  "Failed",
  "Cancelled",
])
/** One Assignment state. */
export type AssignmentState = typeof AssignmentState.Type

/** What the root provides to plan an Assignment. */
export const AssignmentDraft = Schema.Struct({
  intentId: IntentId,
  intentRevision: Revision,
  roleTask: RoleTask,
  objective: Text,
  scope: TextList.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  constraints: TextList.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  criteria: Schema.NonEmptyArray(Criterion),
  evidence: TextList.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  // Checked by createAssignment, which names the offending path.
  ownershipPaths: TextList.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  dependencies: Schema.Array(AssignmentId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  independentFrom: Schema.Array(AssignmentId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  followUpOf: Schema.optionalKey(AssignmentId),
})
/** A decoded Assignment draft. */
export type AssignmentDraft = typeof AssignmentDraft.Type

const fields = {
  id: AssignmentId,
  intentId: IntentId,
  intentRevision: Revision,
  roleTask: RoleTask,
  slug: Slug,
  objective: Text,
  state: AssignmentState,
  scope: TextList,
  constraints: TextList,
  criteria: Schema.NonEmptyArray(Criterion),
  evidence: TextList,
  ownershipPaths: Schema.Array(PortablePath),
  dependencies: Schema.Array(AssignmentId),
  independentFrom: Schema.Array(AssignmentId),
  followUpOf: Schema.optionalKey(AssignmentId),
  specialist: Schema.optionalKey(Specialist),
  result: Schema.optionalKey(Text),
  acceptance: Schema.optionalKey(Acceptance),
  createdAt: Timestamp,
}

/** What a stored state requires of the record's other fields, or undefined when it is coherent. */
const coherenceProblem = (row: Schema.Struct.Type<typeof fields>): string | undefined => {
  const { state, specialist, result, acceptance } = row
  if (state === "Ready")
    return specialist || result || acceptance ? "a Ready Assignment has no run yet" : undefined
  if (state === "Running")
    return specialist && !specialist.finishedAt && !result && !acceptance
      ? undefined
      : "a Running Assignment has a started specialist and no result"
  if (!result) return `a ${state} Assignment records its result`
  if (acceptance && state !== "Succeeded") return "only a Succeeded Assignment can be accepted"
  return undefined
}

/** A persisted unit of delegated work. */
export const Assignment = Schema.Struct(fields).check(
  Schema.makeFilter((row) => coherenceProblem(row)),
)
/** A persisted Assignment. */
export type Assignment = typeof Assignment.Type

/** The Assignments whose work this one builds on or must be judged apart from. */
export const relatedIds = (assignment: Assignment | AssignmentDraft): ReadonlyArray<string> => [
  ...assignment.dependencies,
  ...assignment.independentFrom,
  ...(assignment.followUpOf === undefined ? [] : [assignment.followUpOf]),
]

/** Who creates an Assignment and when; the id comes from `newId("assignment")`. */
export const Creation = Schema.Struct({ id: AssignmentId, now: Timestamp })
/** A decoded creation. */
export type Creation = typeof Creation.Type

/**
 * Plans an Assignment as Ready. The inputs must match their schemas and the id must not be in use.
 * The Intent must be open and the draft written against its live revision; a writing route needs at
 * least one ownership path; paths must be portable; criteria and evidence labels must be unique;
 * and every Assignment it names must belong to the Intent.
 */
export const createAssignment = (
  project: Project,
  rawDraft: AssignmentDraft,
  rawCreation: Creation,
) =>
  Effect.gen(function* () {
    const draft = yield* decodeInput(AssignmentDraft, rawDraft)
    const creation = yield* decodeInput(Creation, rawCreation)
    if (project.assignments.some((row) => row.id === creation.id))
      return yield* new DuplicateRecord({ kind: "assignment", id: creation.id })
    const intent = yield* findIntent(project, draft.intentId)
    yield* requireOpen(intent)
    yield* requireLive(intent, draft.intentRevision)
    if (isWriter(draft.roleTask) && draft.ownershipPaths.length === 0)
      return yield* new MissingOwnership({ roleTask: draft.roleTask })
    for (const path of draft.ownershipPaths) {
      const reason = pathProblem(path)
      if (reason !== undefined) return yield* new InvalidPath({ path, reason })
    }
    for (const [what, labels] of [
      ["criterion", draft.criteria.map((criterion) => criterion.text)],
      ["evidence label", draft.evidence],
    ] as const) {
      const repeated = labels.find((label, index) => labels.indexOf(label) !== index)
      if (repeated !== undefined)
        return yield* new InvalidDraft({ message: `Duplicate ${what}: ${repeated}` })
    }
    const siblings = new Set(
      project.assignments.filter((row) => row.intentId === intent.id).map((row) => row.id),
    )
    const unknown = relatedIds(draft).find((id) => !siblings.has(id))
    if (unknown !== undefined) return yield* new UnknownRecord({ kind: "assignment", id: unknown })
    const assignment: Assignment = {
      id: creation.id,
      intentId: draft.intentId,
      intentRevision: draft.intentRevision,
      roleTask: draft.roleTask,
      slug: slugOf(draft.objective),
      objective: draft.objective,
      state: "Ready",
      scope: draft.scope,
      constraints: draft.constraints,
      criteria: draft.criteria,
      evidence: draft.evidence,
      ownershipPaths: draft.ownershipPaths,
      dependencies: draft.dependencies,
      independentFrom: draft.independentFrom,
      ...(draft.followUpOf === undefined ? {} : { followUpOf: draft.followUpOf }),
      createdAt: creation.now,
    }
    return { assignment, assignments: [assignment] } satisfies Change & { assignment: Assignment }
  })

/** How an Assignment ends. */
export const Outcome = Schema.Literals(["Succeeded", "Failed", "Cancelled"])
/** One way an Assignment ends. */
export type Outcome = typeof Outcome.Type

/** Moves an Assignment to a terminal state with its result, stamping when its specialist finished. */
export const settle = (
  assignment: Assignment,
  outcome: Outcome,
  result: string,
  now: string,
): Assignment => ({
  ...assignment,
  state: outcome,
  result,
  ...(assignment.specialist === undefined
    ? {}
    : { specialist: { ...assignment.specialist, finishedAt: now } }),
})
