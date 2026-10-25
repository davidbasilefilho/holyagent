import { Effect, Schema } from "effect"

import { AcceptanceInput, acceptOn } from "./acceptance.ts"
import { type Assignment, Outcome, settle } from "./assignment.ts"
import { type Directive, directiveFor, type ExecutionConfig } from "./directive.ts"
import { InvalidTransition, SpecialistNotRecorded } from "./errors.ts"
import { AgentId } from "./ids.ts"
import { decodeInput } from "./input.ts"
import { Text, Timestamp } from "./primitives.ts"
import { type Change, findAssignment, findIntent, type Project } from "./project.ts"
import { dispatchBlock } from "./readiness.ts"
import { Effort, Model, routeFor } from "./route.ts"
import { bindSpecialist, type Registry, releaseSpecialist } from "./specialists.ts"

/** The result of {@link dispatch}: the Running Assignment and how to run it. */
export interface Dispatched extends Change {
  readonly assignment: Assignment
  readonly directive: Directive
}

/**
 * Validates an Assignment (see {@link dispatchBlock}) and reserves it: Ready becomes Running and,
 * when the directive continues a warm specialist, that specialist is bound to it at once, so a
 * second dispatch cannot take it and its history is complete even if the launch is never recorded.
 * A refusal changes nothing.
 */
export const dispatch = (
  project: Project,
  registry: Registry,
  assignmentId: string,
  now: string,
  config: ExecutionConfig,
) =>
  Effect.gen(function* () {
    yield* decodeInput(Timestamp, now)
    const assignment = yield* findAssignment(project, assignmentId)
    const block = dispatchBlock(project, assignment)
    if (block !== undefined) return yield* block
    const directive = directiveFor(assignment, registry, now, config)
    const route = routeFor(assignment.roleTask)
    const running: Assignment = {
      ...assignment,
      state: "Running",
      specialist: {
        ...(directive.action === "continue" ? { agentId: directive.agentId } : {}),
        model: route.model,
        effort: route.effort,
        startedAt: now,
      },
    }
    return {
      assignment: running,
      directive,
      assignments: [running],
      ...(directive.action === "continue"
        ? {
            registry: yield* bindSpecialist(registry, running, {
              agentId: directive.agentId,
              model: route.model,
              effort: route.effort,
            }),
          }
        : {}),
    } satisfies Dispatched
  })

/** What the root learned from launching a Running Assignment's specialist. */
export const Launch = Schema.Union([
  Schema.Struct({
    launched: Schema.Literal(true),
    agentId: AgentId,
    model: Model,
    effort: Effort,
  }),
  Schema.Struct({ launched: Schema.Literal(false) }),
])
/** A decoded launch report. */
export type Launch = typeof Launch.Type

/**
 * Records the launch of a Running Assignment: binds the agent id, model and effort and updates the
 * registry, or, when the launch failed, rolls the Assignment back to Ready and frees the specialist
 * the dispatch had taken. A different agent than the one dispatch took replaces it.
 */
export const record = (project: Project, registry: Registry, assignmentId: string, input: Launch) =>
  Effect.gen(function* () {
    const launch = yield* decodeInput(Launch, input)
    const assignment = yield* findAssignment(project, assignmentId)
    if (assignment.state !== "Running" || assignment.specialist === undefined)
      return yield* new InvalidTransition({
        id: assignment.id,
        state: assignment.state,
        action: "record the launch of",
      })
    const taken = assignment.specialist.agentId
    const dropTaken = (agentId: string) =>
      releaseSpecialist(registry, agentId, { forget: assignment.id })
    if (!launch.launched) {
      const { specialist: _specialist, ...rest } = assignment
      const ready: Assignment = { ...rest, state: "Ready" }
      return {
        assignment: ready,
        assignments: [ready],
        registry: taken === undefined ? registry : dropTaken(taken),
      } satisfies Change & { assignment: Assignment }
    }
    const base = taken === undefined || taken === launch.agentId ? registry : dropTaken(taken)
    const bound = yield* bindSpecialist(base, assignment, launch)
    const recorded: Assignment = {
      ...assignment,
      specialist: {
        ...assignment.specialist,
        agentId: launch.agentId,
        model: launch.model,
        effort: launch.effort,
      },
    }
    return { assignment: recorded, assignments: [recorded], registry: bound } satisfies Change & {
      assignment: Assignment
    }
  })

/** How the root finishes an Assignment. */
export const Closing = Schema.Struct({
  outcome: Outcome,
  result: Text,
  /** Accept the work in the same step; only a Succeeded Assignment can be accepted. */
  accept: Schema.optionalKey(AcceptanceInput),
})
/** A decoded closing. */
export type Closing = typeof Closing.Type

/**
 * Finishes an Assignment with its outcome and result, frees its specialist (starting the cache
 * window), and, when asked, accepts it in the same step. A Running Assignment can end any way, but
 * Succeeded needs a specialist whose registry entry lists the Assignment; a Ready one can only be
 * Cancelled. If the acceptance is refused, nothing is closed. A Succeeded Assignment that was not
 * accepted yet can be closed as Succeeded again with a corrected report (the evidence gap that
 * refused its acceptance is the usual reason): the report is replaced, the specialist is not
 * touched again, and the acceptance may come with it.
 */
export const closeAssignment = (
  project: Project,
  registry: Registry,
  assignmentId: string,
  input: Closing,
  now: string,
) =>
  Effect.gen(function* () {
    const closing = yield* decodeInput(Closing, input)
    yield* decodeInput(Timestamp, now)
    const assignment = yield* findAssignment(project, assignmentId)
    const corrects =
      assignment.state === "Succeeded" &&
      assignment.acceptance === undefined &&
      closing.outcome === "Succeeded"
    const open =
      assignment.state === "Running" ||
      (assignment.state === "Ready" && closing.outcome === "Cancelled") ||
      corrects
    if (!open)
      return yield* new InvalidTransition({
        id: assignment.id,
        state: assignment.state,
        action: `close as ${closing.outcome}`,
      })
    if (corrects) {
      const corrected: Assignment = { ...assignment, result: closing.result }
      const closed =
        closing.accept === undefined
          ? corrected
          : yield* acceptOn(
              corrected,
              yield* findIntent(project, assignment.intentId),
              closing.accept,
            )
      return { assignment: closed, assignments: [closed] } satisfies Change & {
        assignment: Assignment
      }
    }
    const agentId = assignment.specialist?.agentId
    const listed = registry.some(
      (entry) => entry.agentId === agentId && entry.assignments.includes(assignment.id),
    )
    if (closing.outcome === "Succeeded" && !listed)
      return yield* new SpecialistNotRecorded({ id: assignment.id })
    const settled = settle(assignment, closing.outcome, closing.result, now)
    const closed =
      closing.accept === undefined
        ? settled
        : yield* acceptOn(settled, yield* findIntent(project, assignment.intentId), closing.accept)
    return {
      assignment: closed,
      assignments: [closed],
      ...(agentId === undefined
        ? {}
        : { registry: releaseSpecialist(registry, agentId, { finishedAt: now }) }),
    } satisfies Change & { assignment: Assignment }
  })
