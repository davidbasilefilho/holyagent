import { Effect, Schema } from "effect"

import { accept } from "../domain/acceptance.ts"
import {
  AssignmentDraft,
  AssignmentState,
  createAssignment,
  type Outcome,
} from "../domain/assignment.ts"
import { type Directive, isWorkflowAgent, WORKFLOW_AGENT_PREFIX } from "../domain/directive.ts"
import { AssignmentId, IntentId, newId } from "../domain/ids.ts"
import { closeAssignment, dispatch, record } from "../domain/lifecycle.ts"
import { Revision } from "../domain/primitives.ts"
import { findAssignment, findIntent, type Project } from "../domain/project.ts"
import { RoleTask, routeFor } from "../domain/route.ts"
import { readState, type Snapshot, updateState } from "../state/store.ts"
import { booleanFlag, choiceFlag, requiredFlag, stringFlag } from "./args.ts"
import { nowIso } from "./context.ts"
import { Usage } from "./errors.ts"
import { resolveIntent } from "./intent.ts"
import { JsonReport, renderJsonReport } from "./jsonreport.ts"
import { acceptanceFrom, renderPrompt } from "./report.ts"
import { type Command, WithTrailer } from "./types.ts"
import { assignmentRow, assignmentView, byId, present } from "./views.ts"

/** The plugin namespace the host knows the specialists and workflows under. */
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

const DRAFT_SHAPE = `{roleTask: ${RoleTask.literals.join("|")}, objective, scope?: [text], constraints?: [text], criteria: [{text, blocking, dimension: behavior|regressions|tests|scope|style|repo-standards}], evidence?: [label], ownershipPaths?: [path] (required for writers), dependencies?: [assignmentId], independentFrom?: [assignmentId], followUpOf?: assignmentId, intentId?, intentRevision?}`

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

const directiveView = (directive: Directive) =>
  directive.action === "continue"
    ? { continue: directive.agentId, reason: directive.reason }
    : {
        agent: `${PLUGIN_NAMESPACE}:${directive.agent}`,
        model: directive.model,
        effort: directive.effort,
        reason: directive.reason,
      }

const ExistingRef = Schema.Struct({ id: AssignmentId })

const OutcomeFlag = Schema.Literals(["success", "failure", "errored", "interrupted", "stopped"])

const OUTCOMES: Readonly<Record<typeof OutcomeFlag.Type, Outcome>> = {
  success: "Succeeded",
  failure: "Failed",
  errored: "Failed",
  interrupted: "Cancelled",
  stopped: "Cancelled",
}

const RECORD_USAGE = "assignment record <id> (--agent <agentId> | --failed)"
const CLOSE_USAGE =
  "assignment close <id> --outcome success|failure|errored|interrupted|stopped [--accept <rationale>] [--report-json]"
const LIST_USAGE = "assignment list [--state <state>] [--all] [--full]"

const idArgument = (positionals: ReadonlyArray<string>): string => positionals[0] ?? ""

/** A workflow's agent is recorded as `workflow:<run-id>/<assignment-id>`, naming its own Assignment. */
const workflowAgentProblem = (agentId: string, id: string): string | undefined => {
  if (!isWorkflowAgent(agentId)) return undefined
  const [run = "", assignment, ...rest] = agentId.slice(WORKFLOW_AGENT_PREFIX.length).split("/")
  return /^\S+$/.test(run) && assignment === id && rest.length === 0
    ? undefined
    : `A workflow agent is recorded as workflow:<run-id>/${id}`
}

/** The `assignment` commands. */
export const ASSIGNMENT_COMMANDS: ReadonlyArray<Command> = [
  {
    path: ["assignment", "create"],
    usage: "assignment create",
    summary: "Plan an Assignment as Ready without starting it (for plan and workflows)",
    input: DRAFT_SHAPE,
    flags: {},
    positionals: 0,
    run: ({ directory, input }) =>
      Effect.gen(function* () {
        const draft = yield* input(AssignmentInput)
        const id = yield* newId("assignment")
        const now = yield* nowIso
        const { assignment } = yield* updateState(directory, (snapshot) =>
          completeDraft(snapshot, draft).pipe(
            Effect.flatMap((complete) => createAssignment(snapshot.project, complete, { id, now })),
          ),
        )
        return { id, state: assignment.state }
      }),
  },
  {
    path: ["assignment", "dispatch"],
    usage: "assignment dispatch",
    summary:
      "Start an Assignment and say how to run it: spawn an agent or continue a warm one. A new draft is created and started in one step",
    input: `{id} for a Ready Assignment, or a new draft ${DRAFT_SHAPE}`,
    output:
      "TOON fields (id, state, agent/model/effort or continue, reason), then a line `prompt:` alone, then the specialist prompt verbatim to the end; pass that text to the Agent tool or SendMessage as it is",
    flags: {},
    positionals: 0,
    run: ({ directory, config, inputBy }) =>
      Effect.gen(function* () {
        const request = yield* inputBy((raw) =>
          typeof raw === "object" && raw !== null && "id" in raw ? ExistingRef : AssignmentInput,
        )
        const settings = yield* config
        const newAssignmentId = yield* newId("assignment")
        const now = yield* nowIso
        const started = yield* updateState(directory, (snapshot) =>
          Effect.gen(function* () {
            const id = "id" in request ? request.id : newAssignmentId
            const project =
              "id" in request ? snapshot.project : yield* withPlanned(snapshot, request, id, now)
            return yield* dispatch(project, snapshot.specialists, id, now, settings)
          }),
        )
        return new WithTrailer(
          {
            id: started.assignment.id,
            state: started.assignment.state,
            ...directiveView(started.directive),
          },
          "prompt",
          renderPrompt(
            started.assignment,
            `${PLUGIN_NAMESPACE}:${routeFor(started.assignment.roleTask).agent}`,
          ),
        )
      }),
  },
  {
    path: ["assignment", "record"],
    usage: RECORD_USAGE,
    summary:
      "Record the launch of a dispatched Assignment (a workflow's agent as workflow:<run-id>/<id>), or roll it back when the launch failed",
    flags: { agent: "string", failed: "boolean" },
    positionals: 1,
    run: ({ directory, args }) =>
      Effect.gen(function* () {
        const id = idArgument(args.positionals)
        const agentId = stringFlag(args, "agent")
        if ((agentId !== undefined) === booleanFlag(args, "failed"))
          return yield* new Usage({
            message: "Give exactly one of --agent and --failed",
            hint: `Usage: holyagent ${RECORD_USAGE}`,
          })
        const problem = agentId === undefined ? undefined : workflowAgentProblem(agentId, id)
        if (problem !== undefined)
          return yield* new Usage({ message: problem, hint: `Usage: holyagent ${RECORD_USAGE}` })
        const { assignment } = yield* updateState(directory, (snapshot) =>
          Effect.gen(function* () {
            const { model, effort } = routeFor(
              (yield* findAssignment(snapshot.project, id)).roleTask,
            )
            return yield* record(
              snapshot.project,
              snapshot.specialists,
              id,
              agentId === undefined
                ? { launched: false }
                : { launched: true, agentId, model, effort },
            )
          }),
        )
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
      "the specialist's report as raw text. Required for success; optional for the other outcomes, which store the outcome name when it is empty. With --accept it ends with `evidence:` and one `<criterion or evidence label>: <support>` line per blocking criterion and required label. With --report-json it is the JSON report a workflow returned ({status: done|partial|blocked, changed_paths, checks: [{command, exit}], blockers, notes, evidence: [{key, support}]}), which is stored as the text of such a report",
    flags: { outcome: "string", accept: "string", "report-json": "boolean" },
    positionals: 1,
    run: ({ directory, args, text, input }) =>
      Effect.gen(function* () {
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
        const { assignment } = yield* updateState(directory, (snapshot) =>
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
    usage: "assignment accept <id> --rationale <text> [--carry-forward]",
    summary:
      "Accept a Succeeded Assignment later from its stored report, or carry its acceptance forward to a newer revision",
    flags: { rationale: "string", "carry-forward": "boolean" },
    positionals: 1,
    run: ({ directory, args }) =>
      Effect.gen(function* () {
        const id = idArgument(args.positionals)
        const rationale = yield* requiredFlag(
          args,
          "rationale",
          "assignment accept <id> --rationale <text>",
        )
        const { assignment } = yield* updateState(directory, ({ project }) =>
          Effect.gen(function* () {
            const found = yield* findAssignment(project, id)
            const acceptance = yield* acceptanceFrom(
              found,
              found.result ?? "",
              rationale,
              booleanFlag(args, "carry-forward"),
            )
            return yield* accept(project, id, acceptance)
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
