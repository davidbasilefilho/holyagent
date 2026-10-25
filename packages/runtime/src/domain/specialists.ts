import { Effect, Schema } from "effect"

import { type Assignment, relatedIds } from "./assignment.ts"
import { SpecialistMismatch } from "./errors.ts"
import { AgentId, AssignmentId } from "./ids.ts"
import { Text, Timestamp } from "./primitives.ts"
import { Effort, Model, RoleTask } from "./route.ts"

/** What the registry remembers of one launched specialist, so the root can reuse it warm. */
export const SpecialistEntry = Schema.Struct({
  agentId: AgentId,
  roleTask: RoleTask,
  model: Model,
  effort: Effort,
  /** The Assignments it worked on, in the order they were bound. */
  assignments: Schema.Array(AssignmentId),
  /** The Assignments those named as dependencies, independence or follow-up. */
  related: Schema.Array(AssignmentId),
  /** Every ownership path it touched. */
  paths: Schema.Array(Text),
  /** The top-level folders of those paths. */
  domains: Schema.Array(Text),
  lastFinishedAt: Schema.optionalKey(Timestamp),
  running: Schema.Boolean,
})
/** One registered specialist. */
export type SpecialistEntry = typeof SpecialistEntry.Type

/** The specialists of this clone. */
export type Registry = ReadonlyArray<SpecialistEntry>

const union = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set([...a, ...b]),
]

const update = (
  registry: Registry,
  agentId: string,
  change: (entry: SpecialistEntry) => SpecialistEntry,
): Registry => registry.map((entry) => (entry.agentId === agentId ? change(entry) : entry))

/**
 * Frees a specialist. With `finishedAt` it also stamps when its work ended, which starts the cache
 * window. With `forget` it drops that Assignment from its history, for a launch that never
 * happened; the paths and relations it gathered stay, which can only make reuse more cautious.
 */
export const releaseSpecialist = (
  registry: Registry,
  agentId: string,
  options: { readonly finishedAt?: string; readonly forget?: string } = {},
): Registry =>
  update(registry, agentId, (entry) => ({
    ...entry,
    running: false,
    assignments: entry.assignments.filter((id) => id !== options.forget),
    ...(options.finishedAt === undefined ? {} : { lastFinishedAt: options.finishedAt }),
  }))

/**
 * Binds a specialist to a running Assignment: registers it on first use, or marks the known one
 * running and extends its history, paths and relations. A known specialist keeps its role task,
 * model and effort, and cannot take a second Assignment while it is running another; binding it
 * again to the Assignment it already runs changes nothing.
 */
export const bindSpecialist = (
  registry: Registry,
  assignment: Assignment,
  launch: { readonly agentId: string; readonly model: Model; readonly effort: Effort },
) =>
  Effect.gen(function* () {
    const known = registry.find((entry) => entry.agentId === launch.agentId)
    const paths = assignment.ownershipPaths
    const domains = paths.map((path) => path.split("/")[0] ?? path)
    if (known === undefined)
      return [
        ...registry,
        {
          agentId: launch.agentId,
          roleTask: assignment.roleTask,
          model: launch.model,
          effort: launch.effort,
          assignments: [assignment.id],
          related: relatedIds(assignment),
          paths,
          domains: [...new Set(domains)],
          running: true,
        },
      ] satisfies Registry
    if (
      known.roleTask !== assignment.roleTask ||
      known.model !== launch.model ||
      known.effort !== launch.effort
    )
      return yield* new SpecialistMismatch({
        agentId: launch.agentId,
        detail: `registered as ${known.roleTask} on ${known.model}/${known.effort}, not ${assignment.roleTask} on ${launch.model}/${launch.effort}`,
      })
    if (known.running && !known.assignments.includes(assignment.id))
      return yield* new SpecialistMismatch({
        agentId: launch.agentId,
        detail: "it is still running another Assignment",
      })
    return update(registry, launch.agentId, (entry) => ({
      ...entry,
      running: true,
      assignments: union(entry.assignments, [assignment.id]),
      related: union(entry.related, relatedIds(assignment)),
      paths: union(entry.paths, paths),
      domains: union(entry.domains, domains),
    }))
  })
