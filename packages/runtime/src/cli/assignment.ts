import { basename, resolve } from "node:path"

import { Effect, Schema } from "effect"

import { accept } from "../domain/acceptance.ts"
import {
  AssignmentDraft,
  AssignmentState,
  createAssignment,
  type Outcome,
} from "../domain/assignment.ts"
import {
  type Directive,
  PI_AGENT_PREFIX,
  PI_WORKFLOW_AGENT_PREFIX,
  WORKFLOW_AGENT_PREFIX,
} from "../domain/directive.ts"
import { InvalidDraft } from "../domain/errors.ts"
import { type AgentHost, CLAUDE_WORDS, type HostWords, wordsFor } from "../domain/host.ts"
import { AssignmentId, IntentId, newId } from "../domain/ids.ts"
import { closeAssignment, dispatch, record } from "../domain/lifecycle.ts"
import { Revision } from "../domain/primitives.ts"
import { findAssignment, findIntent, type Project } from "../domain/project.ts"
import { agentFor, agentsFor, RoleTask, routeFor } from "../domain/route.ts"
import { detectForm } from "../setup/form.ts"
import { io } from "../state/files.ts"
import { workTreeKey } from "../state/local.ts"
import { readState, type Snapshot } from "../state/store.ts"
import { booleanFlag, choiceFlag, requiredFlag, stringFlag } from "./args.ts"
import { briefPath, briefText, writeBrief, writeReport } from "./brief.ts"
import { agentHostOf, type Launch, launchesOf } from "./config.ts"
import { nowIso } from "./context.ts"
import { AgentMismatch, Usage } from "./errors.ts"
import { resolveIntent } from "./intent.ts"
import { JsonReport, renderJsonReport } from "./jsonreport.ts"
import {
  acceptanceFrom,
  dispatchedCall,
  dispatchPrompt,
  journalResults,
  piJournalReports,
  piRecordReports,
} from "./report.ts"
import { type Call, type Command, WithTrailer } from "./types.ts"
import { assignmentRow, assignmentView, byId, present } from "./views.ts"

/** The plugin namespace the host knows the specialists under. */
export const PLUGIN_NAMESPACE = "holyagent"

/**
 * A new Assignment as the root writes it. The Intent and its revision default to the Intent in use
 * at its live revision; give them to pin the draft to the revision it was written against.
 */
const AssignmentInput = Schema.Struct({
  ...AssignmentDraft.fields,
  intentId: Schema.optionalKey(IntentId),
  intentRevision: Schema.optionalKey(Revision),
})

const DRAFT_SHAPE = `{roleTask: ${RoleTask.literals.join("|")}, objective, scope?: [text], constraints?: [text], criteria: [{text, blocking, dimension: behavior|regressions|tests|scope|style|repo-standards}], evidence?: [label], ownershipPaths?: [path] (required for writers), dependencies?: [assignmentId], independentFrom?: [assignmentId], followUpOf?: assignmentId, screen?: boolean, intentId?, intentRevision?}`

const DRAFT_NOTES: ReadonlyArray<string> = [
  "required: roleTask, objective and criteria; unknown fields are refused",
  "evidence labels are answered by the specialist by name; keep them few and observable (checks-run, changed-paths, diff-file)",
  "screen: true when the Assignment needs to see or drive a screen (a desktop app, a real browser, the page shown in T3); its specialist then gets the computer-use, browser-use and T3 preview tools, and under the Codex provider runs on GPT-6.1 Terra at medium or higher effort. Pi host only; the dispatch prints the agent to launch, whose name ends in -screen",
  "ownershipPaths: relative portable paths that must not overlap a Running writer's in the same work tree; dependencies must be accepted at the live revision; a review names the work it must be independent from in independentFrom; a repair or follow-up sets followUpOf",
]

const completeDraft = (snapshot: Snapshot, input: typeof AssignmentInput.Type) =>
  Effect.gen(function* () {
    const { intentId, intentRevision, ...rest } = input
    if (intentId !== undefined && intentRevision !== undefined)
      return { ...rest, intentId, intentRevision }
    const intent =
      intentId === undefined
        ? yield* resolveIntent(snapshot)
        : yield* findIntent(snapshot.project, intentId)
    return { ...rest, intentId: intent.id, intentRevision: intentRevision ?? intent.revision }
  })

/** The project with the new Assignment in it, so a dispatch in the same step can see it. */
const withPlanned = (
  snapshot: Snapshot,
  input: typeof AssignmentInput.Type,
  id: string,
  now: string,
) =>
  completeDraft(snapshot, input).pipe(
    Effect.flatMap((draft) => createAssignment(snapshot.project, draft, { id, now })),
    Effect.map(({ assignment }): Project => ({
      ...snapshot.project,
      assignments: [...snapshot.project.assignments, assignment],
    })),
  )

/**
 * The agent type a dispatch prints for a route's agent: Claude names it under the plugin namespace
 * (`holyagent:worker-implementation`); the Pi package ships the agents under the bare name, which
 * is what the Pi root passes as `agentType`, and so what the journal key hashes.
 */
const agentTypeFor = (host: AgentHost, agent: string): string =>
  host === "pi" ? agent : `${PLUGIN_NAMESPACE}:${agent}`

/** What a dispatch prints for its directive; `launch` is the model and effort of a spawn. */
const directiveView = (directive: Directive, host: AgentHost, launch: Launch) =>
  directive.action === "continue"
    ? { continue: directive.agentId, reason: directive.reason }
    : present({
        agent: agentTypeFor(host, directive.agent),
        model: launch.model,
        effort: launch.effort,
        reason: directive.reason,
        ...(launch.routing === undefined
          ? {}
          : {
              routing: present({
                kind: launch.routing.kind,
                score: launch.routing.score,
                coverage: launch.routing.coverage,
                evidenceRevision: launch.routing.evidenceRevision,
                plan: launch.routing.plan,
                monthlyUsd: launch.routing.monthlyUsd,
                taskCostUsd: launch.routing.taskCostUsd,
                measuredAt: launch.routing.measuredAt,
                reason: launch.routing.reason,
              }),
            }),
      })

const ExistingRef = Schema.Struct({ id: AssignmentId })

const OutcomeFlag = Schema.Literals(["success", "failure", "errored", "interrupted", "stopped"])

const OUTCOMES: Readonly<Record<typeof OutcomeFlag.Type, Outcome>> = {
  success: "Succeeded",
  failure: "Failed",
  errored: "Failed",
  interrupted: "Cancelled",
  stopped: "Cancelled",
}

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

const wordCount = (text: string): number => text.split(/\s+/).filter((word) => word !== "").length

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

const idArgument = (positionals: ReadonlyArray<string>): string => positionals[0] ?? ""

const piAgentProblem = (id: string) =>
  `Under the pi host an agent is recorded as ${PI_AGENT_PREFIX}<agent-id>, or as ${PI_WORKFLOW_AGENT_PREFIX}<run-id>/${id} for a workflow's agent`

/**
 * The reason an agent id cannot be recorded for an Assignment, or undefined when it can. A
 * workflow's agent is recorded as `workflow:<run-id>/<assignment-id>` (Claude) or
 * `pi-workflow:<run-id>/<assignment-id>` (pi), naming its own Assignment; a pi agent launched
 * directly as `pi:<agent-id>`, with the ID the `Agent` tool of `@tintinweb/pi-subagents` returns.
 * Under the pi host only the pi forms are accepted; under Claude any other id is the host's own.
 */
const agentIdProblem = (agentId: string, id: string, host: AgentHost): string | undefined => {
  const workflowPrefix = [WORKFLOW_AGENT_PREFIX, PI_WORKFLOW_AGENT_PREFIX].find((prefix) =>
    agentId.startsWith(prefix),
  )
  if (workflowPrefix !== undefined) {
    if (host === "pi" && workflowPrefix === WORKFLOW_AGENT_PREFIX) return piAgentProblem(id)
    const [run = "", assignment, ...rest] = agentId.slice(workflowPrefix.length).split("/")
    return /^\S+$/.test(run) && assignment === id && rest.length === 0
      ? undefined
      : `A workflow agent is recorded as ${workflowPrefix}<run-id>/${id}`
  }
  if (agentId.startsWith(PI_AGENT_PREFIX))
    return /^\S+$/.test(agentId.slice(PI_AGENT_PREFIX.length))
      ? undefined
      : `A pi agent is recorded as ${PI_AGENT_PREFIX}<agent-id>`
  return host === "pi" ? piAgentProblem(id) : undefined
}

/** The results of a Claude workflow journal: one report per Assignment label, the rest listed. */
const claudeReports = (journal: string, source: string) =>
  Effect.gen(function* () {
    const results = yield* journalResults(journal, source)
    const byId = new Map<string, string>()
    const notAssignmentIds: Array<{ label: string; agentId: string }> = []
    for (const { label, agentId, report } of results) {
      if (label !== undefined && Schema.is(AssignmentId)(label)) byId.set(label, report)
      else notAssignmentIds.push({ label: label ?? "", agentId })
    }
    return { reports: [...byId].map(([id, report]) => ({ id, report })), notAssignmentIds }
  })

/**
 * The reports of a pi source: a `<run id>.workflow.jsonl` is matched to the Assignments by the key
 * of their dispatched calls, and any other file is the root session, which holds the record of each
 * Assignment recorded as `pi:<agent-id>`.
 */
const piReports = (call: Call, source: string, text: string) =>
  Effect.gen(function* () {
    const { project } = yield* readState(call.directory)
    if (!basename(source).endsWith(".workflow.jsonl"))
      return yield* piRecordReports(
        text,
        source,
        project.assignments.flatMap(({ id, specialist }) => {
          const agentId = specialist?.agentId
          return agentId !== undefined &&
            (agentId.startsWith(PI_AGENT_PREFIX) || agentId.startsWith(PI_WORKFLOW_AGENT_PREFIX))
            ? [{ id, agentId }]
            : []
        }),
      )
    const launchOf = yield* launchesOf(call.env, call.root, "pi")
    const screenForm = detectForm(call.env).form
    const calls = yield* Effect.forEach(project.assignments, (assignment) =>
      briefPath(call, assignment.id).pipe(
        Effect.map((path) =>
          dispatchedCall(
            assignment,
            agentTypeFor(
              "pi",
              agentFor(routeFor(assignment.roleTask), assignment.screen, screenForm),
            ),
            path,
            launchOf(assignment.roleTask, assignment.screen),
            screenForm,
          ),
        ),
      ),
    )
    return yield* piJournalReports(text, source, calls)
  })

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
    run: ({ update, input }) =>
      Effect.gen(function* () {
        const draft = yield* input(AssignmentInput)
        const id = yield* newId("assignment")
        const now = yield* nowIso
        const { assignment } = yield* update((snapshot) =>
          completeDraft(snapshot, draft).pipe(
            Effect.flatMap((complete) => createAssignment(snapshot.project, complete, { id, now })),
          ),
        )
        return { id, state: assignment.state }
      }),
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
    run: (call) =>
      Effect.gen(function* () {
        const { update, config, inputBy } = call
        const request = yield* inputBy((raw) =>
          typeof raw === "object" && raw !== null && "id" in raw ? ExistingRef : AssignmentInput,
        ).pipe(
          // A positional id or {"assignmentId"} reads as a malformed draft; say what is accepted.
          Effect.mapError((error) =>
            error instanceof InvalidDraft
              ? new InvalidDraft({
                  message: `${error.message}. To dispatch an existing Assignment send {"id": "<id>"}`,
                })
              : error,
          ),
        )
        const settings = yield* config
        const launchOf = yield* launchesOf(call.env, call.root, settings.host)
        const newAssignmentId = yield* newId("assignment")
        const now = yield* nowIso
        const started = yield* update((snapshot) =>
          Effect.gen(function* () {
            const id = "id" in request ? request.id : newAssignmentId
            const project =
              "id" in request ? snapshot.project : yield* withPlanned(snapshot, request, id, now)
            // Refused before anything starts: the other host has no screen tools to grant, and a
            // dispatch that dropped the capability would hand the specialist a task it cannot do.
            if (settings.host !== "pi" && (yield* findAssignment(project, id)).screen === true)
              return yield* new InvalidDraft({
                message: `The screen capability is available under the pi host only; this is the ${settings.host} host. Dispatch the Assignment without screen`,
              })
            const target = yield* findAssignment(project, id)
            const launch = launchOf(target.roleTask, target.screen)
            if (launch.routing?.error !== undefined)
              return yield* new Usage({
                message: launch.routing.error,
                hint: "Choose a compatible explicit screen route or change the Assignment.",
              })
            const dispatched = yield* dispatch(
              project,
              snapshot.specialists,
              id,
              now,
              launch.intendedLaunch === undefined
                ? settings
                : { ...settings, intendedLaunch: launch.intendedLaunch },
              workTreeKey(call.root),
            )
            // Written before the transition commits, so a brief that cannot be stored leaves the
            // Assignment Ready instead of Running with no prompt to send.
            const agent = agentTypeFor(
              settings.host,
              agentFor(
                routeFor(dispatched.assignment.roleTask),
                dispatched.assignment.screen,
                settings.screenForm,
              ),
            )
            const path = yield* writeBrief(
              call,
              dispatched.assignment.id,
              briefText(dispatched.assignment, agent, settings.host),
            )
            return {
              ...dispatched,
              launch,
              prompt: dispatchPrompt(dispatched.assignment, agent, path, wordsFor(settings.host)),
            }
          }),
        )
        return new WithTrailer(
          {
            id: started.assignment.id,
            state: started.assignment.state,
            ...directiveView(started.directive, settings.host, started.launch),
          },
          "prompt",
          started.prompt,
        )
      }),
  },
  {
    path: ["assignment", "record"],
    usage: RECORD_USAGE,
    ...recordHelp(CLAUDE_WORDS),
    forHost: recordHelp,
    flags: { agent: "string", failed: "boolean" },
    positionals: 1,
    run: ({ update, args, env }) =>
      Effect.gen(function* () {
        const id = idArgument(args.positionals)
        const agentId = stringFlag(args, "agent")
        if ((agentId !== undefined) === booleanFlag(args, "failed"))
          return yield* new Usage({
            message: "Give exactly one of --agent and --failed",
            hint: `Usage: holyagent ${RECORD_USAGE}`,
          })
        // Only the host decides the id form; a bad TTL or workflows setting must not block recording.
        const host = yield* agentHostOf(env)
        const problem = agentId === undefined ? undefined : agentIdProblem(agentId, id, host)
        if (problem !== undefined)
          return yield* new Usage({ message: problem, hint: `Usage: holyagent ${RECORD_USAGE}` })
        const assignment = yield* recordLaunch(update, id, agentId)
        return present({
          id,
          state: assignment.state,
          agent: assignment.specialist?.agentId,
        })
      }),
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
    run: (call) =>
      Effect.gen(function* () {
        const { update, args, text, input } = call
        const id = idArgument(args.positionals)
        const flag = yield* choiceFlag(
          OutcomeFlag,
          "outcome",
          yield* requiredFlag(args, "outcome", CLOSE_USAGE),
          CLOSE_USAGE,
        )
        const outcome = OUTCOMES[flag]
        const rationale = stringFlag(args, "accept")
        if (rationale !== undefined && outcome !== "Succeeded")
          return yield* new Usage({
            message: "--accept applies only to --outcome success",
            hint: `Usage: holyagent ${CLOSE_USAGE}`,
          })
        // Only success has to say what was done; a lost or stopped specialist often has no report.
        const read = input(JsonReport)
        const json = !booleanFlag(args, "report-json")
          ? undefined
          : outcome === "Succeeded"
            ? yield* read
            : yield* read.pipe(Effect.orElseSucceed(() => undefined))
        if (rationale !== undefined && json !== undefined && json.status !== "done")
          return yield* new Usage({
            message: `--accept needs a report with status done, but the report says ${json.status}`,
            hint: "Close it without --accept, or send the work back with a follow-up.",
          })
        const report = booleanFlag(args, "report-json")
          ? json === undefined
            ? ""
            : renderJsonReport(json)
          : outcome === "Succeeded"
            ? yield* text
            : yield* text.pipe(Effect.orElseSucceed(() => ""))
        const result =
          outcome === "Succeeded" ? report : report.trim() === "" ? flag : `${flag}: ${report}`
        const now = yield* nowIso
        const { assignment } = yield* update((snapshot) =>
          Effect.gen(function* () {
            const accept =
              rationale === undefined
                ? undefined
                : yield* acceptanceFrom(
                    yield* findAssignment(snapshot.project, id),
                    result,
                    rationale,
                    false,
                  )
            return yield* closeAssignment(
              snapshot.project,
              snapshot.specialists,
              id,
              { outcome, result, ...(accept === undefined ? {} : { accept }) },
              now,
            )
          }),
        )
        return { id, state: assignment.state, accepted: assignment.acceptance !== undefined }
      }),
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
    run: (call) =>
      Effect.gen(function* () {
        const { update, args, text } = call
        const id = idArgument(args.positionals)
        const rationale = yield* requiredFlag(
          args,
          "rationale",
          "assignment accept <id> --rationale <text>",
        )
        const corrected = booleanFlag(args, "report") ? yield* text : undefined
        const now = yield* nowIso
        const { assignment } = yield* update((snapshot) =>
          Effect.gen(function* () {
            const found = yield* findAssignment(snapshot.project, id)
            const acceptance = yield* acceptanceFrom(
              found,
              corrected ?? found.result ?? "",
              rationale,
              booleanFlag(args, "carry-forward"),
            )
            return corrected === undefined
              ? yield* accept(snapshot.project, id, acceptance)
              : yield* closeAssignment(
                  snapshot.project,
                  snapshot.specialists,
                  id,
                  { outcome: "Succeeded", result: corrected, accept: acceptance },
                  now,
                )
          }),
        )
        return present({
          id,
          state: assignment.state,
          accepted: true,
          revision: assignment.acceptance?.revision,
          carriedFrom: assignment.acceptance?.carriedFrom,
        })
      }),
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
    run: (call) =>
      Effect.gen(function* () {
        const source = resolve(call.cwd, idArgument(call.args.positionals))
        const text = yield* io(source, () => Bun.file(source).text())
        const found =
          (yield* call.config).host === "pi"
            ? yield* piReports(call, source, text)
            : yield* claudeReports(text, source)
        const reports = yield* Effect.forEach(found.reports, ({ id, report }) =>
          writeReport(call, id, report).pipe(
            Effect.map((path) => ({ id, path, words: wordCount(report) })),
          ),
        )
        return { reports, notAssignmentIds: found.notAssignmentIds }
      }),
  },
  {
    path: ["assignment", "show"],
    usage: "assignment show <id> [--full]",
    summary: "Show one Assignment as a line; --full shows everything",
    flags: { full: "boolean" },
    positionals: 1,
    run: ({ directory, args }) =>
      readState(directory).pipe(
        Effect.flatMap(({ project }) => findAssignment(project, idArgument(args.positionals))),
        Effect.map((found) =>
          booleanFlag(args, "full")
            ? assignmentView(found)
            : { assignments: [assignmentRow(found)] },
        ),
      ),
  },
  {
    path: ["assignment", "list"],
    usage: LIST_USAGE,
    summary:
      "List the Assignments of the Intent in use, a line each; --all lists every Intent's, --full shows everything",
    flags: { state: "string", all: "boolean", full: "boolean" },
    positionals: 0,
    run: ({ directory, args }) =>
      Effect.gen(function* () {
        const snapshot = yield* readState(directory)
        const stateFlag = stringFlag(args, "state")
        const state =
          stateFlag === undefined
            ? undefined
            : yield* choiceFlag(AssignmentState, "state", stateFlag, LIST_USAGE)
        const intentId = booleanFlag(args, "all") ? undefined : (yield* resolveIntent(snapshot)).id
        const chosen = byId(
          snapshot.project.assignments.filter(
            (row) =>
              (intentId === undefined || row.intentId === intentId) &&
              (state === undefined || row.state === state),
          ),
        )
        return {
          assignments: chosen.map(booleanFlag(args, "full") ? assignmentView : assignmentRow),
        }
      }),
  },
]
