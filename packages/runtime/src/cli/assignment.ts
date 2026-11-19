import { Effect } from "effect"

import { CLAUDE_WORDS, type HostWords } from "../domain/host.ts"
import { record } from "../domain/lifecycle.ts"
import { findAssignment } from "../domain/project.ts"
import { agentsFor, RoleTask, routeFor } from "../domain/route.ts"
import { coreCommand } from "./core.ts"
import { AgentMismatch } from "./errors.ts"
import type { Call, Command } from "./types.ts"

/** The plugin namespace the host knows the specialists under. */
export const PLUGIN_NAMESPACE = "holyagent"

const DRAFT_SHAPE = `{roleTask: ${RoleTask.literals.join("|")}, objective, scope?: [text], constraints?: [text], criteria: [{text, blocking, dimension: behavior|regressions|tests|scope|style|repo-standards}], evidence?: [label], ownershipPaths?: [path], operationalResources?: [{kind: local-path, target: absolutePath}], dependencies?: [assignmentId], independentFrom?: [assignmentId], followUpOf?: assignmentId, screen?: boolean, intentId?, intentRevision?}`

const DRAFT_NOTES: ReadonlyArray<string> = [
  "required: roleTask, objective and criteria; unknown fields are refused",
  "evidence labels are answered by the specialist by name; keep them few and observable (checks-run, changed-paths, diff-file)",
  "screen: true when the Assignment needs to see or drive a screen (a desktop app, a real browser, the page shown in T3); its specialist then gets the computer-use, browser-use and T3 preview tools, and under the Codex provider runs on GPT-6.1 Terra at medium or higher effort. Pi host only; the dispatch prints the agent to launch, whose name ends in -screen",
  "ownershipPaths: relative portable paths that must not overlap a Running writer's in the same work tree; dependencies must be accepted at the live revision; a review names the work it must be independent from in independentFrom; a repair or follow-up sets followUpOf",
  "a writer needs ownershipPaths or operationalResources; an operational target is an absolute local path outside known worktrees, and an operational writer waits for every Running writer in the shared state",
]

const dispatchOutput = (words: HostWords) => ({
  output: `TOON fields (id, state, agent/model/effort or continue, reason), then a line \`prompt:\` alone, then a two-line specialist prompt that names the brief file the full Assignment was written to; pass that text as it is: as the prompt of its agent() in your inline workflow script first, to the ${words.agentTool} tool only when the ${words.workflowTool} tool is disabled or unavailable, and by ${words.message} only for a warm continuation. The brief itself is never printed: the specialist reads it with the ${words.readTool} tool${words.launchNote === undefined ? "" : `. ${words.launchNote}`}`,
})

const recordHelp = (words: HostWords) => ({
  summary: `Record the launch of a dispatched Assignment (a workflow's agent as ${words.workflowAgentPrefix}<run-id>/<id>), or roll it back when the launch failed`,
  notes: [
    "the agent id is in the Agent result, or is the continued agent's; --failed returns the Assignment to Ready",
    words.recordNote,
    ...(words.agentIdNote === undefined ? [] : [words.agentIdNote]),
  ],
})

const closeNotes = (words: HostWords): ReadonlyArray<string> => [
  "pass the report through a quoted heredoc so it stays intact",
  "--accept applies to success only and reads the last `evidence:` block: one `<criterion text or evidence label>: <support>` line per blocking criterion and per required label. The text before the colon matches the criterion, or its label (the criterion's text before its first colon, unless two criteria share it), ignoring case, spacing, trailing punctuation, a leading `[blocking]` and a trailing `(dimension)`; a support may continue on indented lines below its entry. Evidence for a different criterion matches nothing. Accept only support you judge true",
  `an evidence gap (InsufficientAcceptance) records nothing: ${words.askAgain}, then close again with the corrected report, or when the Assignment is already Succeeded and not accepted, close it as success again or run \`assignment accept <id> --rationale <text> --report\` with the corrected report on stdin; a workflow agent cannot be messaged, so draft a follow-up with followUpOf`,
  "outcomes: success; failure (the work failed); errored (the agent died or returned no report); interrupted (its agent is gone after a resume or compaction); stopped (you stopped it). A report from an inline workflow script is the specialist's own text: pass it verbatim on stdin, with --report-json only for a JSON report object",
]

const reportsSummary = (words: HostWords) =>
  `Write the results of a ${words.journal} to report files named by Assignment id, and list them`

const reportsNotes = (words: HostWords): ReadonlyArray<string> => [
  "the journal is the run's journal.jsonl: `started` entries (key, agentId, label) and `result` entries (key, agentId, result) joined by key; label each agent() with its Assignment id so its report lands in <id>.md",
  "reports go to holyagent/reports in the git common directory (local/reports of the state folder outside git), beside the briefs; a repeated label keeps its last result; closing the Intent removes the brief and report files of its Assignments. Read a report there, or close from it: `assignment close <id> --outcome success --accept <rationale> < <report-file>`",
  "a journal line that is not JSON, or a started or result entry without its fields, refuses the whole journal and writes nothing",
  ...(words.reportsNote === undefined ? [] : [words.reportsNote]),
]

const RECORD_USAGE = "assignment record <id> (--agent <agentId> | --failed)"
const CLOSE_USAGE =
  "assignment close <id> --outcome success|failure|errored|interrupted|stopped [--accept <rationale>] [--report-json]"
const LIST_USAGE = "assignment list [--state <state>] [--all] [--full]"

const REPORTS_USAGE = "assignment reports <journal.jsonl>"

const withoutNamespace = (type: string | undefined): string | undefined =>
  type?.startsWith(`${PLUGIN_NAMESPACE}:`) === true ? type.slice(PLUGIN_NAMESPACE.length + 1) : type

/**
 * Records the launch of a Running Assignment: binds the agent id, or with none returns the
 * Assignment to Ready because the launch failed. The `record` command and the launch hook both come
 * through here, so they cannot differ. With `launchedAs` (the hook's case) the agent type that was
 * launched must be the one the Assignment's route names.
 */
export const recordLaunch = (
  update: Call["update"],
  id: string,
  agentId: string | undefined,
  launchedAs?: { readonly type: string | undefined },
) =>
  update((snapshot) =>
    Effect.gen(function* () {
      const assignment = yield* findAssignment(snapshot.project, id)
      const route = routeFor(assignment.roleTask)
      const { model, effort } = route
      // A screen Assignment may be launched as the agent file of either form; the one a machine
      // uses is decided at dispatch, and a plain agent never carries the screen tools.
      const agents = agentsFor(route, assignment.screen)
      const launched = withoutNamespace(launchedAs?.type)
      if (launchedAs !== undefined && (launched === undefined || !agents.includes(launched)))
        return yield* new AgentMismatch({
          expected: agents.join(" or "),
          launched: launchedAs.type,
        })
      return yield* record(
        snapshot.project,
        snapshot.specialists,
        id,
        agentId === undefined ? { launched: false } : { launched: true, agentId, model, effort },
      )
    }),
  ).pipe(Effect.map(({ assignment }) => assignment))

/** The `assignment` commands. */
export const ASSIGNMENT_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["assignment", "create"],
    usage: "assignment create [--input <json>]",
    summary: "Plan an Assignment as Ready without starting it (for plan and workflows)",
    input: DRAFT_SHAPE,
    notes: ["the draft rules are under assignment dispatch"],
    flags: { input: "string" },
    positionals: 0,
    core: true,
    run: coreCommand("assignment create"),
  },
  {
    path: ["assignment", "dispatch"],
    usage: "assignment dispatch [--input <json>]",
    summary:
      "Start an Assignment and say how to run it: spawn an agent or continue a warm one. A new draft is created and started in one step",
    input: `{id} for a Ready Assignment, or a new draft ${DRAFT_SHAPE}`,
    ...dispatchOutput(CLAUDE_WORDS),
    forHost: dispatchOutput,
    notes: [...DRAFT_NOTES, 'dispatching a Ready Assignment takes {"id": "<id>"}'],
    flags: { input: "string" },
    positionals: 0,
    core: true,
    run: coreCommand("assignment dispatch"),
  },
  {
    path: ["assignment", "record"],
    usage: RECORD_USAGE,
    ...recordHelp(CLAUDE_WORDS),
    forHost: recordHelp,
    flags: { agent: "string", failed: "boolean" },
    positionals: 1,
    core: true,
    run: coreCommand("assignment record"),
  },
  {
    path: ["assignment", "close"],
    usage: CLOSE_USAGE,
    summary:
      "Finish an Assignment with the specialist's report on stdin; --accept also accepts it from the report's evidence block",
    input:
      "the specialist's report as raw text. Required for success; optional for the other outcomes, which store the outcome name when it is empty. With --accept it ends with `evidence:` and one `<criterion or evidence label>: <support>` line per blocking criterion and required label. With --report-json it is a JSON report object returned by an agent() that was given a schema ({status: done|partial|blocked, changed_paths, checks: [{command, exit}], blockers, notes, evidence: [{key, support}]}), which is stored as the text of such a report (fields beyond these are kept in it)",
    notes: closeNotes(CLAUDE_WORDS),
    forHost: (words) => ({ notes: closeNotes(words) }),
    flags: { outcome: "string", accept: "string", "report-json": "boolean" },
    positionals: 1,
    core: true,
    run: coreCommand("assignment close"),
  },
  {
    path: ["assignment", "accept"],
    usage: "assignment accept <id> --rationale <text> [--carry-forward] [--report]",
    summary:
      "Accept a Succeeded Assignment later from its stored report, or from a corrected report on stdin with --report, or carry its acceptance forward to a newer revision",
    notes: [
      "--report reads a corrected report from stdin (the same `evidence:` block `close --accept` reads) and stores it in place of the old one, for a Succeeded Assignment that was not accepted yet; nothing is stored if the evidence is still short",
      "--carry-forward accepts, at the live revision, work that finished at an earlier one and still holds; the rationale says why",
      "when a later change touched the files it established, a bounded validation Assignment reassesses it first",
    ],
    flags: { rationale: "string", "carry-forward": "boolean", report: "boolean" },
    positionals: 1,
    core: true,
    run: coreCommand("assignment accept"),
  },
  {
    path: ["assignment", "reports"],
    usage: REPORTS_USAGE,
    summary: reportsSummary(CLAUDE_WORDS),
    forHost: (words) => ({ summary: reportsSummary(words), notes: reportsNotes(words) }),
    output:
      "TOON: `reports` rows of id, path and words, one per Assignment id, and `notAssignmentIds` rows of label and agentId for results whose label is not an Assignment id (not written)",
    notes: reportsNotes(CLAUDE_WORDS),
    flags: {},
    positionals: 1,
    state: "peek",
    core: true,
    run: coreCommand("assignment reports"),
  },
  {
    path: ["assignment", "show"],
    usage: "assignment show <id> [--full]",
    summary: "Show one Assignment as a line; --full shows everything",
    flags: { full: "boolean" },
    positionals: 1,
    core: true,
    run: coreCommand("assignment show"),
  },
  {
    path: ["assignment", "list"],
    usage: LIST_USAGE,
    summary:
      "List the Assignments of the Intent in use, a line each; --all lists every Intent's, --full shows everything",
    flags: { state: "string", all: "boolean", full: "boolean" },
    positionals: 0,
    core: true,
    run: coreCommand("assignment list"),
  },
]
