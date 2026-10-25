import { Effect } from "effect"

import { recommend } from "../domain/plan.ts"
import { readOpenState, type Snapshot } from "../state/store.ts"
import { nowIso } from "./context.ts"
import { intentInUse, resolveIntent } from "./intent.ts"
import type { Command } from "./types.ts"
import { assignmentRow, byId, oneLine, present } from "./views.ts"

const statusFrom = (snapshot: Snapshot) => {
  const open = byId(snapshot.project.intents.filter((intent) => intent.state === "Open"))
  const openIds = new Set(open.map((intent) => intent.id))
  const live = byId(snapshot.project.assignments.filter((row) => openIds.has(row.intentId)))
  const running = live.filter((row) => row.state === "Running").map(assignmentRow)
  const unaccepted = live
    .filter((row) => row.state === "Succeeded" && row.acceptance === undefined)
    .map(assignmentRow)
  return {
    intents: open.map(({ id, revision, objective }) => ({
      id,
      revision,
      objective: oneLine(objective),
    })),
    ...present({
      inUse: intentInUse(snapshot),
      running: running.map(({ id, role, agent, objective }) => ({
        id,
        role,
        agent,
        objective,
      })),
      unaccepted: unaccepted.map(({ id, role, rev, objective }) => ({
        id,
        role,
        rev,
        objective,
      })),
    }),
  }
}

/** The open Intents and the work waiting on the root, as `status` prints them. */
export const statusOf = (directory: string) => readOpenState(directory).pipe(Effect.map(statusFrom))

const reconcileFrom = ({ project }: Snapshot) => {
  const running = byId(project.assignments.filter((row) => row.state === "Running"))
  return {
    running: running.map((row) => ({
      id: row.id,
      role: row.roleTask,
      agent: row.specialist?.agentId ?? null,
      startedAt: row.specialist?.startedAt ?? null,
    })),
    ...present({
      next:
        running.length === 0
          ? undefined
          : "close as interrupted only an agent confirmed gone (SendMessage or transcript; an exited parent session proves nothing): holyagent assignment close <id> --outcome interrupted",
    }),
  }
}

/**
 * The Running Assignments with their agent ids, and what to do with a lost one, as `reconcile`
 * prints them.
 */
export const reconcileOf = (directory: string) =>
  readOpenState(directory).pipe(Effect.map(reconcileFrom))

/** The status and the reconcile result from one read of the state, for a session that resumes. */
export const resumeOf = (directory: string) =>
  readOpenState(directory).pipe(
    Effect.map((snapshot) => ({
      status: statusFrom(snapshot),
      reconcile: reconcileFrom(snapshot),
    })),
  )

/** What the root does with a workflow recommendation, for the `plan` help. */
const PLAN_NOTES: ReadonlyArray<string> = [
  "workflow first: `assignment dispatch` each id for its agent, model, effort and prompt, then write the inline script yourself and run it with the Workflow tool; an entry is {id, agent, model, effort, prompt}. A single Assignment is a one-entry workflow, and `continues` lists work that continues a warm specialist by SendMessage beside it. `fallback` is for a session where the Workflow tool is disabled or unavailable: its writers launch together, and `afterwards` launch once the writers they depend on are terminal",
  "the script opens with a literal `export const meta = {name, description}` and has one agent() per entry, every one with agentType holyagent:<agent> and the entry's model and effort. Run the entries through pipeline() and put a review stage after its writers; return an object of reports keyed by Assignment id. An inline script whose every agent() names a holyagent specialist runs without a permission prompt; any other agent type, a scriptPath or a resume goes through the normal flow",
  "the run ends with a notice carrying the returned value, and the tool result has the run id. Per entry: `assignment record <id> --agent workflow:<run-id>/<id>`, then `assignment close <id> --outcome <o> [--accept <rationale>]` with the entry's report text on stdin, verbatim and never retyped or summarized (the script passes no `schema`, so agent() returns the specialist's own report). A null report means the agent died: close it errored. A workflow's agents cannot be messaged, so a gap in a report, like any repair, is a new draft with followUpOf",
]

/** The `plan`, `status` and `reconcile` commands. */
export const OVERVIEW_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["plan"],
    usage: "plan",
    summary:
      "Say how to run the Ready Assignments of the Intent in use: a workflow first (with the direct subagents as its fallback), else subagents or a warm agent",
    notes: PLAN_NOTES,
    flags: {},
    positionals: 0,
    run: ({ directory, config }) =>
      Effect.gen(function* () {
        const settings = yield* config
        const snapshot = yield* readOpenState(directory)
        const intent = yield* resolveIntent(snapshot)
        const now = yield* nowIso
        const recommendation = recommend(
          {
            intents: [intent],
            assignments: snapshot.project.assignments.filter((row) => row.intentId === intent.id),
          },
          snapshot.specialists,
          now,
          settings,
        )
        if (recommendation === undefined)
          return { action: "none", reason: "no Ready Assignment can start now" }
        return present({
          action: recommendation.action,
          continue:
            recommendation.action === "continue" && recommendation.continues.length === 1
              ? recommendation.continues[0]?.agentId
              : undefined,
          continues:
            recommendation.action === "subagent" ||
            recommendation.continues.length === 0 ||
            (recommendation.action === "continue" && recommendation.continues.length === 1)
              ? undefined
              : recommendation.continues.map(({ assignmentId, agentId }) => ({
                  assignment: assignmentId,
                  agent: agentId,
                })),
          assignments: recommendation.assignmentIds,
          parallel: recommendation.assignmentIds.length > 1 ? true : undefined,
          fallback:
            recommendation.action === "workflow"
              ? present({
                  action: "subagent",
                  when: "only if the Workflow tool is disabled or unavailable",
                  assignments: recommendation.fallback.assignmentIds,
                  parallel: recommendation.fallback.assignmentIds.length > 1 ? true : undefined,
                  afterwards: recommendation.fallback.afterwards,
                })
              : undefined,
          reason: recommendation.reason,
        })
      }),
  },
  {
    path: ["status"],
    usage: "status",
    summary: "Summarize the open Intents and the work waiting on the root",
    flags: {},
    positionals: 0,
    run: ({ directory }) => statusOf(directory),
  },
  {
    path: ["reconcile"],
    usage: "reconcile",
    summary: "List the Running Assignments with their agent ids, to confirm after a resume",
    flags: {},
    positionals: 0,
    run: ({ directory }) => reconcileOf(directory),
  },
]
