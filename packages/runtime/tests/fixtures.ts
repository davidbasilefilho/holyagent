import { Effect } from "effect"

import type { Assignment } from "../src/domain/assignment.ts"
import type { Intent } from "../src/domain/intent.ts"
import type { Project } from "../src/domain/project.ts"
import type { SpecialistEntry } from "../src/domain/specialists.ts"

/** A fixed instant every fixture is relative to. */
export const NOW = "2026-01-02T12:00:00.000Z"

/** The instant `minutes` after NOW. */
export const after = (minutes: number): string =>
  new Date(Date.parse(NOW) + minutes * 60_000).toISOString()

/** An open Intent at revision 1; override any field. */
export const intent = (over: Partial<Intent> = {}): Intent => ({
  id: "intent-a",
  slug: "ship-it",
  objective: "Ship it",
  requirements: [],
  revision: 1,
  state: "Open",
  createdAt: NOW,
  ...over,
})

/** A Ready writer Assignment on `src/a.ts`; override any field. */
export const assignment = (over: Partial<Assignment> = {}): Assignment => ({
  id: "assignment-a",
  intentId: "intent-a",
  intentRevision: 1,
  roleTask: "Worker.implementation",
  slug: "build-it",
  objective: "Build it",
  state: "Ready",
  scope: [],
  constraints: [],
  criteria: [
    { text: "works", blocking: true, dimension: "behavior" },
    { text: "tidy", blocking: false, dimension: "style" },
  ],
  evidence: ["tests"],
  ownershipPaths: ["src/a.ts"],
  dependencies: [],
  independentFrom: [],
  createdAt: NOW,
  ...over,
})

/** A Running Assignment whose specialist is recorded. */
export const running = (over: Partial<Assignment> = {}): Assignment =>
  assignment({
    state: "Running",
    specialist: { agentId: "agent-1", model: "sonnet", effort: "high", startedAt: NOW },
    ...over,
  })

/** A Succeeded Assignment; pass `accepted` for one the root accepted at that revision. */
export const succeeded = (over: Partial<Assignment> = {}, accepted?: number): Assignment =>
  assignment({
    state: "Succeeded",
    specialist: {
      agentId: "agent-1",
      model: "sonnet",
      effort: "high",
      startedAt: NOW,
      finishedAt: after(5),
    },
    result: "done",
    ...(accepted === undefined
      ? {}
      : {
          acceptance: {
            revision: accepted,
            rationale: "checked",
            criteria: [{ criterion: "works", support: "ran it" }],
            evidence: [{ label: "tests", support: "bun test passed" }],
          },
        }),
    ...over,
  })

/** A project holding the given records. */
export const project = (
  assignments: ReadonlyArray<Assignment> = [],
  intents: ReadonlyArray<Intent> = [intent()],
): Project => ({ intents, assignments })

/** An idle specialist that finished ten minutes ago; override any field. */
export const entry = (over: Partial<SpecialistEntry> = {}): SpecialistEntry => ({
  agentId: "agent-1",
  roleTask: "Worker.implementation",
  model: "sonnet",
  effort: "high",
  assignments: ["assignment-old"],
  related: [],
  paths: ["src/a.ts"],
  domains: ["src"],
  lastFinishedAt: after(-10),
  running: false,
  ...over,
})

/** Runs a pure transition and returns its value. */
export const ok = <A, E>(effect: Effect.Effect<A, E>): A => Effect.runSync(effect)

/** Runs a transition that must be refused and returns the tagged error. */
export const refused = <A, E>(effect: Effect.Effect<A, E>): E => Effect.runSync(Effect.flip(effect))
