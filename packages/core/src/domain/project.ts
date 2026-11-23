import { Effect } from "effect"

import type { Assignment } from "./assignment.ts"
import { IntentClosed, StaleRevision, UnknownRecord } from "./errors.ts"
import type { Intent } from "./intent.ts"
import type { BranchRecord, PullRecord } from "./links.ts"
import type { Registry } from "./specialists.ts"

/** Every Intent and Assignment of the project, as the store loads them. */
export interface Project {
  readonly intents: ReadonlyArray<Intent>
  readonly assignments: ReadonlyArray<Assignment>
}

/**
 * What a transition changed: only the records to write. Transitions never mutate their input, so a
 * failed one changes nothing.
 */
export interface Change {
  readonly intents?: ReadonlyArray<Intent>
  readonly assignments?: ReadonlyArray<Assignment>
  readonly branches?: ReadonlyArray<BranchRecord>
  readonly pulls?: ReadonlyArray<PullRecord>
  readonly registry?: Registry
}

/** The Intent with the id, or UnknownRecord. */
export const findIntent = (project: Project, id: string) => {
  const found = project.intents.find((intent) => intent.id === id)
  return found === undefined
    ? Effect.fail(new UnknownRecord({ kind: "intent", id }))
    : Effect.succeed(found)
}

/** The Assignment with the id, or UnknownRecord. */
export const findAssignment = (project: Project, id: string) => {
  const found = project.assignments.find((assignment) => assignment.id === id)
  return found === undefined
    ? Effect.fail(new UnknownRecord({ kind: "assignment", id }))
    : Effect.succeed(found)
}

/** Fails with IntentClosed unless the Intent is open. */
export const requireOpen = (intent: Intent) =>
  intent.state === "Open" ? Effect.void : Effect.fail(new IntentClosed({ intentId: intent.id }))

/** Fails with StaleRevision unless the revision is the Intent's live one. */
export const requireLive = (intent: Intent, revision: number) =>
  revision === intent.revision
    ? Effect.void
    : Effect.fail(new StaleRevision({ given: revision, live: intent.revision }))
