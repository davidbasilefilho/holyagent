import type { Assignment } from "./assignment.ts"
import {
  DependencyNotAccepted,
  IntentClosed,
  InvalidTransition,
  MissingOwnership,
  OwnershipConflict,
  StaleRevision,
  UnknownRecord,
} from "./errors.ts"
import { firstOverlap } from "./paths.ts"
import type { Project } from "./project.ts"
import { isWriter } from "./route.ts"

/** Why an Assignment cannot start now. */
export type DispatchBlock =
  | InvalidTransition
  | UnknownRecord
  | IntentClosed
  | StaleRevision
  | MissingOwnership
  | DependencyNotAccepted
  | OwnershipConflict

/**
 * The first rule that keeps an Assignment from starting, or undefined when it can start: it is
 * Ready, its Intent is open and still at its revision, a writer owns a path and no Running writer
 * owns an overlapping one (equal paths or a directory prefix, ignoring case), and every dependency
 * is Succeeded and accepted at its revision. Dependencies named in `assumeAccepted` count as
 * accepted, for planning a run that will finish them first.
 */
export const dispatchBlock = (
  project: Project,
  assignment: Assignment,
  assumeAccepted: ReadonlySet<string> = new Set(),
): DispatchBlock | undefined => {
  if (assignment.state !== "Ready")
    return new InvalidTransition({ id: assignment.id, state: assignment.state, action: "dispatch" })
  const intent = project.intents.find((candidate) => candidate.id === assignment.intentId)
  if (intent === undefined) return new UnknownRecord({ kind: "intent", id: assignment.intentId })
  if (intent.state !== "Open") return new IntentClosed({ intentId: intent.id })
  if (intent.revision !== assignment.intentRevision)
    return new StaleRevision({ given: assignment.intentRevision, live: intent.revision })
  const writes = isWriter(assignment.roleTask)
  if (writes && assignment.ownershipPaths.length === 0)
    return new MissingOwnership({ roleTask: assignment.roleTask })
  for (const id of assignment.dependencies) {
    if (assumeAccepted.has(id)) continue
    const dependency = project.assignments.find((candidate) => candidate.id === id)
    if (dependency === undefined) return new UnknownRecord({ kind: "assignment", id })
    const reason =
      dependency.state !== "Succeeded"
        ? `is ${dependency.state}, not Succeeded`
        : dependency.acceptance === undefined
          ? "is not accepted"
          : dependency.acceptance.revision !== assignment.intentRevision
            ? `was accepted at revision ${dependency.acceptance.revision}, not ${assignment.intentRevision}`
            : undefined
    if (reason !== undefined)
      return new DependencyNotAccepted({ id: assignment.id, dependency: id, reason })
  }
  if (writes)
    for (const running of project.assignments) {
      if (running.state !== "Running" || !isWriter(running.roleTask)) continue
      const path = firstOverlap(assignment.ownershipPaths, running.ownershipPaths)
      if (path !== undefined)
        return new OwnershipConflict({ id: assignment.id, runningId: running.id, path })
    }
  return undefined
}
