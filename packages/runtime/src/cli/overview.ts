import { Effect } from "effect"

import { recommend } from "../domain/plan.ts"
import { readOpenState } from "../state/store.ts"
import { PLUGIN_NAMESPACE } from "./assignment.ts"
import { nowIso } from "./context.ts"
import { intentInUse, resolveIntent } from "./intent.ts"
import type { Command } from "./types.ts"
import { assignmentRow, byId, oneLine, present } from "./views.ts"

/** The open Intents and the work waiting on the root, as `status` prints them. */
export const statusOf = (directory: string) =>
  readOpenState(directory).pipe(
    Effect.map((snapshot) => {
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
    }),
  )

/** The `plan`, `status` and `reconcile` commands. */
export const OVERVIEW_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["plan"],
    usage: "plan",
    summary:
      "Say how to run the Ready Assignments of the Intent in use: workflow, subagents or a warm agent",
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
          workflow:
            recommendation.action === "workflow"
              ? `${PLUGIN_NAMESPACE}:${recommendation.name}`
              : undefined,
          continue: recommendation.action === "continue" ? recommendation.agentId : undefined,
          assignments: recommendation.assignmentIds,
          parallel: recommendation.assignmentIds.length > 1 ? true : undefined,
          fallback:
            recommendation.action === "workflow"
              ? present({
                  action: "subagent",
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
    run: ({ directory }) =>
      readOpenState(directory).pipe(
        Effect.map(({ project }) => {
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
                  : "for each agent no longer working: holyagent assignment close <id> --outcome interrupted",
            }),
          }
        }),
      ),
  },
]
