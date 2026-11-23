import { Effect } from "effect"

import { CLAUDE_WORDS, type HostWords } from "../domain/host.ts"
import type { Snapshot } from "../state/store.ts"
import { readOpenState } from "../state/store.ts"
import { coreCommand } from "./core.ts"
import { reconcileRows, statusFrom } from "./status-views.ts"
import type { Command } from "./types.ts"

/**
 * The open Intents and the work waiting on the root, as `status` prints them: the Running and
 * unaccepted Assignments of the Intent in use, and a count of each for every other open Intent.
 */
export const statusOf = (directory: string) => readOpenState(directory).pipe(Effect.map(statusFrom))

const reconcileFrom = ({ project }: Snapshot, words: HostWords) =>
  reconcileRows(project.assignments, words)

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
    core: true,
    run: coreCommand("handoff"),
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
    core: true,
    run: coreCommand("plan"),
  },
  {
    path: ["status"],
    usage: "status",
    summary:
      "Summarize the open Intents and the work waiting on the root: the Running and unaccepted Assignments of the Intent in use, and counts for the other open Intents; in a claude.ai cloud session whose primary checkout is on a detached HEAD or on a branch other than the one it started on, a `notice` that says so",
    flags: {},
    positionals: 0,
    core: true,
    run: coreCommand("status"),
  },
  {
    path: ["reconcile"],
    usage: "reconcile",
    summary: "List the Running Assignments with their agent ids, to confirm after a resume",
    flags: {},
    positionals: 0,
    // Reads the host alone, not the whole config: a bad TTL or workflows setting must not refuse it.
    core: true,
    run: coreCommand("reconcile"),
  },
]
