import type { Assignment } from "./assignment.ts"
import { directiveFor, type ExecutionConfig } from "./directive.ts"
import { firstOverlap } from "./paths.ts"
import type { Project } from "./project.ts"
import { dispatchBlock } from "./readiness.ts"
import { isReviewer, isWriter } from "./route.ts"
import type { Registry } from "./specialists.ts"

/** The prebuilt workflows the plugin offers, named without the plugin namespace. */
export const WORKFLOW_NAMES = ["implement-review", "review-diff", "run-assignments"] as const
/** One workflow name. */
export type WorkflowName = (typeof WORKFLOW_NAMES)[number]

/** An Assignment that continues a warm specialist, which only SendMessage can reach. */
export interface Continuation {
  readonly assignmentId: string
  readonly agentId: string
}

/** How the root should run a set of Ready Assignments. */
export type Recommendation =
  | {
      readonly action: "workflow"
      readonly name: WorkflowName
      readonly assignmentIds: ReadonlyArray<string>
      /**
       * The same work as direct subagents, for a session where the Workflow tool is disabled or
       * unavailable: the Assignments to launch together, and for `implement-review` the reviews to
       * launch once those have closed.
       */
      readonly fallback: {
        readonly assignmentIds: ReadonlyArray<string>
        readonly afterwards: ReadonlyArray<string>
      }
      /** Ready work beside the workflow that continues a warm specialist, by SendMessage. */
      readonly continues: ReadonlyArray<Continuation>
      readonly reason: string
    }
  | {
      readonly action: "continue"
      readonly assignmentIds: ReadonlyArray<string>
      readonly continues: ReadonlyArray<Continuation>
      readonly reason: string
    }
  | {
      readonly action: "subagent"
      readonly assignmentIds: ReadonlyArray<string>
      readonly reason: string
    }

const dependsOn = (a: Assignment, b: Assignment) => a.dependencies.includes(b.id)

/** Two Assignments can run side by side: neither builds on the other and no two writers collide. */
const independent = (a: Assignment, b: Assignment) =>
  !dependsOn(a, b) &&
  !dependsOn(b, a) &&
  !(
    isWriter(a.roleTask) &&
    isWriter(b.roleTask) &&
    firstOverlap(a.ownershipPaths, b.ownershipPaths) !== undefined
  )

/** The Assignments of a kind that can all run side by side, taken in order. */
const parallelSet = (ready: ReadonlyArray<Assignment>, kind: (a: Assignment) => boolean) =>
  ready
    .filter(kind)
    .reduce<ReadonlyArray<Assignment>>(
      (chosen, next) =>
        chosen.every((other) => independent(other, next)) ? [...chosen, next] : chosen,
      [],
    )

/**
 * The Ready or Running work a review has to wait for: the Assignments it must be independent from
 * that have not finished. A review of unfinished work would judge the wrong tree.
 */
const awaited = (project: Project, review: Assignment): ReadonlyArray<string> =>
  isReviewer(review.roleTask)
    ? review.independentFrom.filter((id) => {
        const state = project.assignments.find((row) => row.id === id)?.state
        return state === "Ready" || state === "Running"
      })
    : []

/** What a workflow picks from: the Ready Assignments that can start now, and all Ready ones. */
interface Pool {
  readonly project: Project
  readonly dispatchable: ReadonlyArray<Assignment>
  readonly ready: ReadonlyArray<Assignment>
}

/**
 * Each dispatchable writer, independent of the earlier ones, with a Ready review that names it in
 * independentFrom and waits for nothing else, as writer and review one after the other. The review
 * does not depend on the writer, since a dependency needs the writer's acceptance first.
 */
const reviewedWriters = ({ project, dispatchable, ready }: Pool): ReadonlyArray<Assignment> => {
  const pairs: Array<Assignment> = []
  const writers: Array<Assignment> = []
  for (const writer of dispatchable.filter((row) => isWriter(row.roleTask))) {
    if (!writers.every((other) => independent(other, writer))) continue
    const review = ready.find(
      (row) =>
        !pairs.includes(row) &&
        isReviewer(row.roleTask) &&
        row.independentFrom.includes(writer.id) &&
        awaited(project, row).every((id) => id === writer.id) &&
        dispatchBlock(project, row) === undefined,
    )
    if (review === undefined) continue
    writers.push(writer)
    pairs.push(writer, review)
  }
  return pairs
}

/** Each workflow with the Assignments it would run, when the pool fits it. */
const WORKFLOWS: ReadonlyArray<
  readonly [WorkflowName, string, (pool: Pool) => ReadonlyArray<Assignment>]
> = [
  ["implement-review", "a writer and the review of its work are both ready", reviewedWriters],
  [
    "review-diff",
    "independent reviews can start together",
    ({ dispatchable }) => parallelSet(dispatchable, (row) => isReviewer(row.roleTask)),
  ],
  [
    "run-assignments",
    "independent Assignments can start together",
    ({ dispatchable }) => parallelSet(dispatchable, () => true),
  ],
]

/**
 * The Assignments among `rows` that continue a warm specialist and can run beside `beside` and each
 * other, with the agent to message.
 */
const continuations = (
  rows: ReadonlyArray<Assignment>,
  beside: ReadonlyArray<Assignment>,
  registry: Registry,
  now: string,
  config: ExecutionConfig,
): ReadonlyArray<Continuation> =>
  parallelSet(
    rows.filter((row) => beside.every((other) => independent(other, row))),
    () => true,
  ).flatMap((row) => {
    const directive = directiveFor(row, registry, now, config)
    return directive.action === "continue"
      ? [{ assignmentId: row.id, agentId: directive.agentId }]
      : []
  })

/**
 * Recommends how to run the project's Ready Assignments that can start now (the others are left
 * out, see {@link dispatchBlock}; a review waits for the unfinished work it names in
 * independentFrom), or undefined when none can. With workflows available it names the first
 * workflow the set fits: writers with the reviews of their work, as writer and review ids in turn
 * (`implement-review`), at least two independent reviews (`review-diff`) or independent Assignments
 * (`run-assignments`, which takes a single one), each with its direct-subagent fallback. Work that
 * would continue a warm specialist, which a workflow cannot message, is listed beside it as
 * `continues`, or is the whole `continue` recommendation when nothing else is ready. Without
 * workflows it takes the Assignments that can run side by side as `subagent` work.
 */
export const recommend = (
  project: Project,
  registry: Registry,
  now: string,
  config: ExecutionConfig,
): Recommendation | undefined => {
  const ready = project.assignments.filter((row) => row.state === "Ready")
  const dispatchable = ready.filter(
    (row) => dispatchBlock(project, row) === undefined && awaited(project, row).length === 0,
  )
  if (config.workflowsAvailable) {
    // A workflow's agents are new and cannot be messaged, so work that would continue a warm
    // specialist stays out; the warm context is worth more than the workflow.
    const spawns = (row: Assignment) => directiveFor(row, registry, now, config).action === "spawn"
    const pool: Pool = {
      project,
      dispatchable: dispatchable.filter(spawns),
      ready: ready.filter(spawns),
    }
    for (const [name, reason, pick] of WORKFLOWS) {
      const chosen = pick(pool)
      // A single Assignment is a one-entry run-assignments; the other workflows need a pair.
      if (chosen.length >= (name === "run-assignments" ? 1 : 2)) {
        const assignmentIds = chosen.map((row) => row.id)
        // The pairs of implement-review run as writer then review, so without the workflow the
        // reviews wait for their writers.
        const reviews =
          name === "implement-review" ? assignmentIds.filter((_, at) => at % 2 === 1) : []
        const fallback = {
          assignmentIds: assignmentIds.filter((id) => !reviews.includes(id)),
          afterwards: reviews,
        }
        // The warm work a workflow cannot message goes beside it, as long as it does not collide.
        const continues = continuations(
          dispatchable.filter((row) => !spawns(row)),
          chosen,
          registry,
          now,
          config,
        )
        return {
          action: "workflow",
          name,
          assignmentIds,
          fallback,
          continues,
          reason:
            continues.length === 0
              ? reason
              : `${reason}; the Assignments in continues go by SendMessage to their warm specialists`,
        }
      }
    }
  }
  const chosen = parallelSet(dispatchable, () => true)
  if (chosen.length === 0) return undefined
  const assignmentIds = chosen.map((row) => row.id)
  if (config.workflowsAvailable) {
    // Every spawnable Assignment went into a workflow above, so what is left continues warm ones.
    const continues = continuations(chosen, [], registry, now, config)
    return {
      action: "continue",
      assignmentIds: continues.map((row) => row.assignmentId),
      continues,
      reason: "each continues a warm specialist by SendMessage",
    }
  }
  if (chosen.length > 1)
    return {
      action: "subagent",
      assignmentIds,
      reason: "the Workflow tool is disabled or unavailable",
    }
  const [first] = chosen
  if (first === undefined) return undefined
  const directive = directiveFor(first, registry, now, config)
  return directive.action === "continue"
    ? {
        action: "continue",
        assignmentIds,
        continues: [{ assignmentId: first.id, agentId: directive.agentId }],
        reason: directive.reason,
      }
    : { action: "subagent", assignmentIds, reason: directive.reason }
}
