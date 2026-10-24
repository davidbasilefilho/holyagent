import type { Assignment } from "./assignment.ts"
import { directiveFor, type ExecutionConfig } from "./directive.ts"
import { firstOverlap } from "./paths.ts"
import type { Project } from "./project.ts"
import { dispatchBlock } from "./readiness.ts"
import { isReviewer, isWriter } from "./route.ts"
import type { Registry } from "./specialists.ts"

/** The workflows the host may offer. */
export type WorkflowName = "implement-review" | "review-diff" | "validate-criteria"

/** How the root should run a set of Ready Assignments. */
export type Recommendation =
  | {
      readonly action: "workflow"
      readonly name: WorkflowName
      readonly assignmentIds: ReadonlyArray<string>
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

/** What a workflow picks from: the Ready Assignments that can start now, and all Ready ones. */
interface Pool {
  readonly project: Project
  readonly dispatchable: ReadonlyArray<Assignment>
  readonly ready: ReadonlyArray<Assignment>
}

/** Each workflow with the Assignments it would run, when the pool fits it. */
const WORKFLOWS: ReadonlyArray<
  readonly [WorkflowName, string, (pool: Pool) => ReadonlyArray<Assignment>]
> = [
  [
    "implement-review",
    "a writer and the review of its work are both ready",
    ({ project, dispatchable, ready }) => {
      for (const writer of dispatchable.filter((row) => isWriter(row.roleTask))) {
        // The review waits for the writer, so only the writer's own acceptance may be missing.
        const review = ready.find(
          (row) =>
            isReviewer(row.roleTask) &&
            dependsOn(row, writer) &&
            dispatchBlock(project, row, new Set([writer.id])) === undefined,
        )
        if (review !== undefined) return [writer, review]
      }
      return []
    },
  ],
  [
    "review-diff",
    "independent reviews can start together",
    ({ dispatchable }) => parallelSet(dispatchable, (row) => isReviewer(row.roleTask)),
  ],
  [
    "validate-criteria",
    "independent validations can start together",
    ({ dispatchable }) => parallelSet(dispatchable, (row) => row.roleTask === "Worker.validation"),
  ],
]

/**
 * Recommends how to run the project's Ready Assignments that can start now (the others are left
 * out, see {@link dispatchBlock}), or undefined when none can. With workflows available it names the
 * first workflow the set fits: a writer with the review of its work (`implement-review`), at least
 * two independent reviews (`review-diff`) or at least two independent validations
 * (`validate-criteria`). Otherwise it takes the Assignments that can run side by side: one that can
 * continue a warm specialist is `continue`, and anything else is `subagent` work.
 */
export const recommend = (
  project: Project,
  registry: Registry,
  now: string,
  config: ExecutionConfig,
): Recommendation | undefined => {
  const ready = project.assignments.filter((row) => row.state === "Ready")
  const dispatchable = ready.filter((row) => dispatchBlock(project, row) === undefined)
  if (config.workflowsAvailable)
    for (const [name, reason, pick] of WORKFLOWS) {
      const chosen = pick({ project, dispatchable, ready })
      if (chosen.length >= 2)
        return { action: "workflow", name, assignmentIds: chosen.map((row) => row.id), reason }
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
