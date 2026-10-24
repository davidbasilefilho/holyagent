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

/** How the root should run a set of Ready Assignments. */
export type Recommendation =
  | {
      readonly action: "workflow"
      readonly name: WorkflowName
      readonly assignmentIds: ReadonlyArray<string>
      /**
       * The same work as direct subagents, for a session without the user's opt-in to workflows:
       * the Assignments to launch together, and for `implement-review` the reviews to launch once
       * those have closed.
       */
      readonly fallback: {
        readonly assignmentIds: ReadonlyArray<string>
        readonly afterwards: ReadonlyArray<string>
      }
      readonly reason: string
    }
  | {
      readonly action: "continue"
      readonly assignmentIds: ReadonlyArray<string>
      readonly agentId: string
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
 * Recommends how to run the project's Ready Assignments that can start now (the others are left
 * out, see {@link dispatchBlock}; a review waits for the unfinished work it names in
 * independentFrom), or undefined when none can. With workflows available it names the first
 * workflow the set fits: writers with the reviews of their work, as writer and review ids in turn
 * (`implement-review`), at least two independent reviews (`review-diff`) or at least two
 * independent Assignments (`run-assignments`), each with its direct-subagent fallback, leaving out
 * any that would continue a warm specialist, which a workflow cannot message. Otherwise it takes
 * the Assignments that can run side by side: one that can continue a warm specialist is `continue`,
 * and anything else is `subagent` work.
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
      if (chosen.length >= 2) {
        const assignmentIds = chosen.map((row) => row.id)
        // The pairs of implement-review run as writer then review, so without the workflow the
        // reviews wait for their writers.
        const reviews =
          name === "implement-review" ? assignmentIds.filter((_, at) => at % 2 === 1) : []
        const fallback = {
          assignmentIds: assignmentIds.filter((id) => !reviews.includes(id)),
          afterwards: reviews,
        }
        return { action: "workflow", name, assignmentIds, fallback, reason }
      }
    }
  }
  const chosen = parallelSet(dispatchable, () => true)
  const [first] = chosen
  if (first === undefined) return undefined
  const assignmentIds = chosen.map((row) => row.id)
  if (chosen.length > 1)
    return {
      action: "subagent",
      assignmentIds,
      reason: config.workflowsAvailable
        ? "no workflow fits the ready set"
        : "workflows are not available",
    }
  const directive = directiveFor(first, registry, now, config)
  return directive.action === "continue"
    ? { action: "continue", assignmentIds, agentId: directive.agentId, reason: directive.reason }
    : { action: "subagent", assignmentIds, reason: directive.reason }
}
