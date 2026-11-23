import { type Assignment, relatedIds } from "./assignment.ts"
import type { AgentHost } from "./host.ts"
import { firstOverlap } from "./paths.ts"
import {
  agentFor,
  type Effort,
  type IntendedLaunch,
  isReviewer,
  type Model,
  routeFor,
  type ScreenForm,
} from "./route.ts"
import type { Registry, SpecialistEntry } from "./specialists.ts"

/** Tunables of warm reuse. */
export interface ExecutionConfig {
  /** Minutes a finished specialist stays warm; the subagent cache lives 1h, so 55 leaves a margin. */
  readonly ttlMinutes: number
  /** Whether the host offers the named workflows. */
  readonly workflowsAvailable: boolean
  /** The host the commands run under, which decides the tool names the output uses. */
  readonly host: AgentHost
  /**
   * The form of the machine, which picks the agent file a screen Assignment is launched as; absent
   * means `normal`.
   */
  readonly screenForm?: ScreenForm
  /** A profile launch requested now; it is not proof of an agent's observed model. */
  readonly intendedLaunch?: IntendedLaunch
  /** A selected profile cannot reuse a worker without a trusted observed launch identity. */
  readonly profileRouting?: true
}

/** The default configuration. */
export const DEFAULT_CONFIG: ExecutionConfig = {
  ttlMinutes: 55,
  workflowsAvailable: false,
  host: "claude",
}

/**
 * The start of the agent id of a specialist a Claude workflow launched:
 * `workflow:<run-id>/<assignment-id>`.
 */
export const WORKFLOW_AGENT_PREFIX = "workflow:"

/**
 * The start of the agent id of a specialist the pi host launched directly (the `Agent` tool of
 * `@tintinweb/pi-subagents`): `pi:<agent-id>`, where `<agent-id>` is the ID that tool returns. A
 * caller that messages the agent strips the prefix.
 */
export const PI_AGENT_PREFIX = "pi:"

/**
 * The start of the agent id of a specialist a pi workflow run (`SubagentWorkflow`) launched:
 * `pi-workflow:<run-id>/<assignment-id>`, with the run ID the tool returns and the `label` the
 * script gave the agent, which is the Assignment id.
 */
export const PI_WORKFLOW_AGENT_PREFIX = "pi-workflow:"

/**
 * True for a specialist a workflow launched, on Claude or pi. Nothing can message it, so it is
 * never continued.
 */
export const isWorkflowAgent = (agentId: string): boolean =>
  agentId.startsWith(WORKFLOW_AGENT_PREFIX) || agentId.startsWith(PI_WORKFLOW_AGENT_PREFIX)

/** How the root runs an Assignment: message a warm specialist, or launch a new one. */
export type Directive =
  | { readonly action: "continue"; readonly agentId: string; readonly reason: string }
  | {
      readonly action: "spawn"
      readonly agent: string
      readonly model: Model
      readonly effort: Effort
      readonly reason: string
    }

interface Candidate {
  readonly assignment: Assignment
  readonly model: Model
  readonly effort: Effort
  readonly now: number
  readonly ttlMs: number
}

/** The work a specialist must not have touched to judge or redo this Assignment independently. */
const independenceSubjects = (assignment: Assignment): ReadonlyArray<string> =>
  isReviewer(assignment.roleTask)
    ? [...assignment.dependencies, ...assignment.independentFrom]
    : assignment.independentFrom

const touched = (entry: SpecialistEntry, id: string) =>
  entry.assignments.includes(id) || entry.related.includes(id)

/**
 * Each stage keeps the specialists that pass it; the first stage to empty the pool explains a
 * spawn.
 */
const STAGES: ReadonlyArray<readonly [string, (entry: SpecialistEntry, c: Candidate) => boolean]> =
  [
    [
      "idle specialist of this role task",
      (entry, c) => !entry.running && entry.roleTask === c.assignment.roleTask,
    ],
    [
      "specialist with the same screen capability",
      (entry, c) => (entry.screen === true) === (c.assignment.screen === true),
    ],
    [
      "specialist with the same model and effort",
      (entry, c) => entry.model === c.model && entry.effort === c.effort,
    ],
    [
      "specialist inside the cache window",
      (entry, c) =>
        entry.lastFinishedAt !== undefined && c.now - Date.parse(entry.lastFinishedAt) <= c.ttlMs,
    ],
    [
      "independent specialist",
      (entry, c) => !independenceSubjects(c.assignment).some((id) => touched(entry, id)),
    ],
  ]

/** Why a specialist's context helps, in priority order. */
const RELEVANCE: ReadonlyArray<
  readonly [string, (entry: SpecialistEntry, a: Assignment) => boolean]
> = [
  [
    "follow-up of its own Assignment",
    (entry, a) => a.followUpOf !== undefined && entry.assignments.includes(a.followUpOf),
  ],
  [
    "overlapping ownership paths",
    (entry, a) => firstOverlap(a.ownershipPaths, entry.paths) !== undefined,
  ],
  ["shared related Assignments", (entry, a) => relatedIds(a).some((id) => touched(entry, id))],
]

const relevance = (entry: SpecialistEntry, assignment: Assignment) =>
  RELEVANCE.findIndex(([, relevant]) => relevant(entry, assignment))

/** Prefers the strongest relevance, then the most recently finished, then the smallest agent id. */
const compareEntries = (assignment: Assignment) => (a: SpecialistEntry, b: SpecialistEntry) =>
  relevance(a, assignment) - relevance(b, assignment) ||
  Date.parse(b.lastFinishedAt ?? "") - Date.parse(a.lastFinishedAt ?? "") ||
  (a.agentId < b.agentId ? -1 : 1)

/**
 * Decides how to run an Assignment. It continues an idle specialist of the same role task, screen
 * capability (the tools a specialist has are those of its agent file), model and effort (an
 * identical configuration keeps the cache prefix) that finished inside the cache window and whose
 * context is relevant: a follow-up of its own Assignment, overlapping paths, or shared related
 * Assignments. A Reviewer, or any Assignment that names independentFrom, never continues a
 * specialist that worked on or reviewed those Assignments, and no Assignment continues a specialist
 * a workflow launched. Otherwise it spawns.
 */
export const directiveFor = (
  assignment: Assignment,
  registry: Registry,
  now: string,
  config: ExecutionConfig,
): Directive => {
  const route = routeFor(assignment.roleTask)
  // Neither host reports a trusted observed model in its record call. Do not continue a worker
  // whose requested profile identity is unverified, or reuse one for a new profile selection.
  if (config.profileRouting === true || config.intendedLaunch !== undefined)
    return {
      action: "spawn",
      agent: agentFor(route, assignment.screen, config.screenForm),
      model: route.model,
      effort: route.effort,
      reason: "the selected route has no observed warm-worker identity",
    }
  const candidate: Candidate = {
    assignment,
    model: route.model,
    effort: route.effort,
    now: Date.parse(now),
    ttlMs: config.ttlMinutes * 60_000,
  }
  let pool = registry.filter(
    (entry) => !isWorkflowAgent(entry.agentId) && entry.intendedLaunch === undefined,
  )
  for (const [name, passes] of STAGES) {
    pool = pool.filter((entry) => passes(entry, candidate))
    if (pool.length === 0)
      return {
        action: "spawn",
        agent: agentFor(route, assignment.screen, config.screenForm),
        model: route.model,
        effort: route.effort,
        reason: `no ${name}`,
      }
  }
  const relevant = pool.filter((entry) => relevance(entry, assignment) >= 0)
  const best = relevant.toSorted(compareEntries(assignment))[0]
  if (best === undefined)
    return {
      action: "spawn",
      agent: agentFor(route, assignment.screen, config.screenForm),
      model: route.model,
      effort: route.effort,
      reason: "no specialist with relevant context",
    }
  return {
    action: "continue",
    agentId: best.agentId,
    reason: RELEVANCE[relevance(best, assignment)]?.[0] ?? "relevant context",
  }
}
