import { Effect } from "effect"

import { CLAUDE_WORDS, type HostWords, wordsFor } from "../domain/host.ts"
import { recommend } from "../domain/plan.ts"
import { findIntent } from "../domain/project.ts"
import { workTreeKey } from "../state/local.ts"
import { readOpenState, type Snapshot } from "../state/store.ts"
import { requireHandoffState } from "../state/tree.ts"
import { stringFlag } from "./args.ts"
import { agentHostOf } from "./config.ts"
import { nowIso } from "./context.ts"
import { intentInUse, resolveIntent } from "./intent.ts"
import { cloudCheckoutNotice } from "./status.ts"
import type { Command } from "./types.ts"
import { assignmentRow, byId, oneLine, present } from "./views.ts"

const statusFrom = (snapshot: Snapshot) => {
  const open = byId(snapshot.project.intents.filter((intent) => intent.state === "Open"))
  const openIds = new Set(open.map((intent) => intent.id))
  const live = byId(snapshot.project.assignments.filter((row) => openIds.has(row.intentId)))
  const waiting = (id: string) => live.filter((row) => row.intentId === id)
  const isRunning = (row: (typeof live)[number]) => row.state === "Running"
  const isUnaccepted = (row: (typeof live)[number]) =>
    row.state === "Succeeded" && row.acceptance === undefined
  const inUse = intentInUse(snapshot)
  // The Assignments are listed for the Intent in use only; each other open Intent gets counts, so
  // the root sees that work waits there without reading it.
  const mine = live.filter((row) => row.intentId === inUse)
  return {
    intents: open.map(({ id, revision, objective }) => ({
      id,
      revision,
      objective: oneLine(objective),
      ...(id === inUse
        ? {}
        : {
            running: waiting(id).filter(isRunning).length,
            unaccepted: waiting(id).filter(isUnaccepted).length,
          }),
    })),
    ...present({
      inUse,
      running: mine
        .filter(isRunning)
        .map(assignmentRow)
        .map(({ id, role, agent, objective }) => ({ id, role, agent, objective })),
      unaccepted: mine
        .filter(isUnaccepted)
        .map(assignmentRow)
        .map(({ id, role, rev, objective }) => ({ id, role, rev, objective })),
    }),
  }
}

/**
 * The open Intents and the work waiting on the root, as `status` prints them: the Running and
 * unaccepted Assignments of the Intent in use, and a count of each for every other open Intent.
 */
export const statusOf = (directory: string) => readOpenState(directory).pipe(Effect.map(statusFrom))

const reconcileFrom = ({ project }: Snapshot, words: HostWords) => {
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
          : `close as interrupted only an agent confirmed gone (${words.confirmGone}; an exited parent session proves nothing): holyagent assignment close <id> --outcome interrupted`,
    }),
  }
}

/**
 * The Running Assignments with their agent ids, and what to do with a lost one, as `reconcile`
 * prints them.
 */
const reconcileOf = (directory: string, words: HostWords) =>
  readOpenState(directory).pipe(Effect.map((snapshot) => reconcileFrom(snapshot, words)))

/**
 * The status and the reconcile result from one read of the state, for a session that resumes. With
 * the `words` of a host the reconcile result names that host's tools (Claude's by default).
 */
export const resumeOf = (directory: string, words: HostWords = CLAUDE_WORDS) =>
  readOpenState(directory).pipe(
    Effect.map((snapshot) => ({
      status: statusFrom(snapshot),
      reconcile: reconcileFrom(snapshot, words),
    })),
  )

/**
 * What the output of `plan` means, for the `plan` help. The root workflow and dispatch text own how
 * to write, run, record and close a workflow; these notes name only what the command prints.
 */
const planNotes = (words: HostWords): ReadonlyArray<string> => [
  "`workflow` first: `assignments` are the ids in run order, a writer followed by the review of its work; `assignment dispatch` each for its agent, model, effort and prompt, then write the inline script as the root workflow text says. A single Assignment is a one-entry workflow",
  ...(words.launchNote === undefined ? [] : [words.launchNote]),
  `\`continues\` lists Ready work that continues a warm specialist, by ${words.message} beside the workflow. \`fallback\` is the same work as direct subagents, for a session where the ${words.workflowTool} tool is disabled or unavailable: its writers launch together, and the \`afterwards\` reviews launch once the writers they depend on are terminal`,
]

/** The `plan`, `status` and `reconcile` commands. */
export const OVERVIEW_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["handoff"],
    usage: "handoff [--intent <id>]",
    summary: "Summarize recorded open work for another session, without changing state",
    notes: [
      "By default includes every open Intent and all its Assignments; --intent selects one open Intent by id.",
      "Branches, pull requests, requirements and outcomes are recorded facts, not live checks; current PR and CI status are unknown.",
    ],
    flags: { intent: "string" },
    positionals: 0,
    state: "peek",
    run: ({ directory, args, cwd, env }) =>
      Effect.gen(function* () {
        yield* requireHandoffState(cwd, env, directory)
        const snapshot = yield* readOpenState(directory)
        const id = stringFlag(args, "intent")
        const intents =
          id === undefined
            ? byId(snapshot.project.intents)
            : [yield* findIntent(snapshot.project, id)]
        return {
          source: "recorded local state; live PR and CI status unknown",
          intents: intents.map((intent) => ({
            id: intent.id,
            revision: intent.revision,
            state: intent.state,
            objective: intent.objective,
            requirements: intent.requirements,
            assignments: byId(
              snapshot.project.assignments.filter((row) => row.intentId === intent.id),
            ).map((row) => ({
              id: row.id,
              revision: row.intentRevision,
              role: row.roleTask,
              objective: row.objective,
              state: row.state,
              outcome: row.result ?? null,
              acceptance: row.acceptance ?? null,
              scope: row.scope,
              constraints: row.constraints,
              criteria: row.criteria,
              evidence: row.evidence,
              ownershipPaths: row.ownershipPaths,
              dependencies: row.dependencies,
              independentFrom: row.independentFrom,
              followUpOf: row.followUpOf ?? null,
              recordedAgent: row.specialist?.agentId ?? null,
              ...(row.operationalResources === undefined
                ? {}
                : { recordedOperationalResources: row.operationalResources }),
            })),
            recordedBranches: byId(
              snapshot.links.branches.filter((row) => row.intentId === intent.id),
            ),
            recordedPullRequests: byId(
              snapshot.links.pulls.filter((row) => row.intentId === intent.id),
            ),
          })),
        }
      }),
  },
  {
    path: ["plan"],
    usage: "plan",
    summary:
      "Say how to run the Ready Assignments of the Intent in use: a workflow first (with the direct subagents as its fallback), else subagents or a warm agent",
    notes: planNotes(CLAUDE_WORDS),
    forHost: (words) => ({ notes: planNotes(words) }),
    flags: {},
    positionals: 0,
    run: ({ directory, config, root }) =>
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
          workTreeKey(root),
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
                  when: `only if the ${wordsFor(settings.host).workflowTool} tool is disabled or unavailable`,
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
    summary:
      "Summarize the open Intents and the work waiting on the root: the Running and unaccepted Assignments of the Intent in use, and counts for the other open Intents; in a claude.ai cloud session whose primary checkout is on a detached HEAD or on a branch other than the one it started on, a `notice` that says so",
    flags: {},
    positionals: 0,
    run: (call) =>
      Effect.gen(function* () {
        const status = yield* statusOf(call.directory)
        const notice = yield* cloudCheckoutNotice(call)
        return notice === undefined ? status : { ...status, notice }
      }),
  },
  {
    path: ["reconcile"],
    usage: "reconcile",
    summary: "List the Running Assignments with their agent ids, to confirm after a resume",
    flags: {},
    positionals: 0,
    // Reads the host alone, not the whole config: a bad TTL or workflows setting must not refuse it.
    run: ({ directory, env }) =>
      agentHostOf(env).pipe(Effect.flatMap((host) => reconcileOf(directory, wordsFor(host)))),
  },
]
