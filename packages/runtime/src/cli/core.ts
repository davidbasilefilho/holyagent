import {
  assignment,
  handoff,
  intent,
  makeContext,
  migrate,
  plan,
  reconcile,
  stateMode,
  status,
} from "@holyagent/core"
import { Effect, Schema } from "effect"

import { AssignmentState } from "../domain/assignment.ts"
import { DEFAULT_CONFIG } from "../domain/directive.ts"
import { InvalidDraft } from "../domain/errors.ts"
import type { AgentHost } from "../domain/host.ts"
import { wordsFor } from "../domain/host.ts"
import { AssignmentId } from "../domain/ids.ts"
import { firstPassPrompt } from "../prompts/index.ts"
import { detectForm } from "../setup/form.ts"
import { StateMode } from "../state/mode.ts"
import { booleanFlag, choiceFlag, requiredFlag, stringFlag } from "./args.ts"
import { agentHostOf } from "./config.ts"
import { Usage } from "./errors.ts"
import { reconcileRows, statusFrom } from "./status-views.ts"
import { cloudCheckoutNotice } from "./status.ts"
import { type Call, WithTrailer } from "./types.ts"
import { assignmentRow, assignmentView, byId, intentRow, intentView, present } from "./views.ts"

/** Adapts parsed CLI values to shared core operations and renders the existing views. */
export const coreCommand = (name: string) => (call: Call) =>
  Effect.gen(function* () {
    const needsHost = [
      "assignment dispatch",
      "assignment record",
      "assignment reports",
      "plan",
      "reconcile",
    ].includes(name)
    const host = needsHost
      ? yield* agentHostOf(call.env)
      : yield* agentHostOf(call.env).pipe(Effect.orElseSucceed((): AgentHost => "claude"))
    const firstPass = {
      "Reviewer.code": firstPassPrompt("Reviewer.code") ?? "",
      "Reviewer.security": firstPassPrompt("Reviewer.security") ?? "",
    }
    const context = ["assignment dispatch", "plan"].includes(name)
      ? yield* makeContext({ cwd: call.cwd, env: call.env, host, authorize: () => true, firstPass })
      : {
          cwd: call.cwd,
          env: call.env,
          host,
          authorize: () => true,
          firstPass,
          execution: { ...DEFAULT_CONFIG, host, screenForm: detectForm(call.env).form },
        }
    const id = call.args.positionals[0] ?? ""
    const full = booleanFlag(call.args, "full")
    switch (name) {
      case "intent create":
        return intentView(yield* intent.create(context, yield* call.input(intent.schemas.create)))
      case "intent show": {
        const found = yield* intent.show(context, id === "" ? {} : { id })
        return intentView(found, found.links)
      }
      case "intent list": {
        const found = yield* intent.list(context, {})
        return {
          intents: byId(found.intents).map((row) => intentRow(row, row.id === found.activeIntent)),
        }
      }
      case "intent update": {
        const edit = yield* call.input(
          Schema.Struct({
            objective: intent.schemas.update.fields.objective,
            requirements: intent.schemas.update.fields.requirements,
          }),
        )
        return intentView(
          yield* intent.update(context, { ...edit, material: booleanFlag(call.args, "material") }),
        )
      }
      case "intent close": {
        const reason = yield* requiredFlag(call.args, "reason", "intent close --reason <text>")
        const drop = stringFlag(call.args, "drop")
        const closed = yield* intent.close(context, {
          reason,
          ...(drop === undefined ? {} : { drop }),
        })
        return present({
          ...intentView(closed.intent),
          dropped: closed.assignments.map((row) => row.id),
          unremoved: closed.unremoved,
        })
      }
      case "intent reopen":
        return intentView(yield* intent.reopen(context, id === "" ? {} : { id }))
      case "intent use":
        return intentView(yield* intent.use(context, { id }))
      case "assignment create": {
        const made = yield* assignment.create(context, yield* call.input(assignment.schemas.create))
        return { id: made.id, state: made.state }
      }
      case "assignment dispatch": {
        const input = yield* call
          .inputBy(
            (raw) =>
              (typeof raw === "object" && raw !== null && "id" in raw
                ? Schema.Struct({ id: AssignmentId })
                : assignment.schemas.create) as Schema.Decoder<unknown>,
          )
          .pipe(
            Effect.mapError((error) =>
              error instanceof InvalidDraft
                ? new InvalidDraft({
                    message: `${error.message}. To dispatch an existing Assignment send {"id": "<id>"}`,
                  })
                : error,
            ),
          )
        const started = yield* assignment.dispatch(context, input as never)
        const directive =
          started.directive.action === "continue"
            ? { continue: started.directive.agentId, reason: started.directive.reason }
            : present({
                agent: started.agent,
                model: "model" in started.launch ? started.launch.model : undefined,
                effort: "effort" in started.launch ? started.launch.effort : undefined,
                reason: started.directive.reason,
                ...("kind" in started.launch ? { routing: started.launch } : {}),
              })
        return new WithTrailer(
          { id: started.assignment.id, state: started.assignment.state, ...directive },
          "prompt",
          started.prompt,
        )
      }
      case "assignment record": {
        const agent = stringFlag(call.args, "agent")
        const failed = booleanFlag(call.args, "failed")
        if ((agent !== undefined) === failed)
          return yield* new Usage({
            message: "Give exactly one of --agent and --failed",
            hint: "Usage: holyagent assignment record <id> (--agent <agentId> | --failed)",
          })
        const found = yield* assignment.record(
          context,
          agent === undefined ? { id, failed: true } : { id, agent },
        )
        return present({ id, state: found.state, agent: found.specialist?.agentId })
      }
      case "assignment close": {
        const outcome = yield* choiceFlag(
          Schema.Literals(["success", "failure", "errored", "interrupted", "stopped"]),
          "outcome",
          yield* requiredFlag(call.args, "outcome", "assignment close <id> --outcome <outcome>"),
          "assignment close <id> --outcome <outcome>",
        )
        const accept = stringFlag(call.args, "accept")
        const jsonMode = booleanFlag(call.args, "report-json")
        const report = jsonMode
          ? undefined
          : outcome === "success"
            ? yield* call.text
            : yield* call.text.pipe(Effect.orElseSucceed(() => ""))
        const json = jsonMode
          ? outcome === "success"
            ? yield* call.input(Schema.Unknown)
            : yield* call.input(Schema.Unknown).pipe(Effect.orElseSucceed(() => undefined))
          : undefined
        const found = yield* assignment.close(context, {
          id,
          outcome,
          ...(accept === undefined ? {} : { accept }),
          ...(report === undefined ? {} : { report }),
          ...(json === undefined ? {} : { reportJson: json as never }),
        })
        return { id, state: found.state, accepted: found.acceptance !== undefined }
      }
      case "assignment accept": {
        const rationale = yield* requiredFlag(
          call.args,
          "rationale",
          "assignment accept <id> --rationale <text>",
        )
        const report = booleanFlag(call.args, "report") ? yield* call.text : undefined
        const found = yield* assignment.accept(context, {
          id,
          rationale,
          carryForward: booleanFlag(call.args, "carry-forward"),
          ...(report === undefined ? {} : { report }),
        })
        return present({
          id,
          state: found.state,
          accepted: true,
          revision: found.acceptance?.revision,
          carriedFrom: found.acceptance?.carriedFrom,
        })
      }
      case "assignment reports":
        return yield* assignment
          .reports(context, { source: id })
          .pipe(
            Effect.mapError((error) =>
              error instanceof InvalidDraft
                ? new Usage({ message: error.message, hint: "Check the journal format." })
                : error,
            ),
          )
      case "assignment show": {
        const found = yield* assignment.show(context, { id })
        return full ? assignmentView(found) : { assignments: [assignmentRow(found)] }
      }
      case "assignment list": {
        const raw = stringFlag(call.args, "state")
        const state =
          raw === undefined
            ? undefined
            : yield* choiceFlag(
                AssignmentState,
                "state",
                raw,
                "assignment list [--state <state>] [--all] [--full]",
              )
        const found = yield* assignment.list(context, {
          all: booleanFlag(call.args, "all"),
          ...(state === undefined ? {} : { state }),
        })
        return { assignments: found.map(full ? assignmentView : assignmentRow) }
      }
      case "plan": {
        const result = yield* plan(context, {})
        if (result.action === "none") return result
        const continues = "continues" in result ? result.continues : []
        return present({
          action: result.action,
          continue:
            result.action === "continue" && continues.length === 1
              ? continues[0]?.agentId
              : undefined,
          continues:
            result.action === "subagent" ||
            continues.length === 0 ||
            (result.action === "continue" && continues.length === 1)
              ? undefined
              : continues.map(({ assignmentId, agentId }) => ({
                  assignment: assignmentId,
                  agent: agentId,
                })),
          assignments: result.assignmentIds,
          parallel: result.assignmentIds.length > 1 ? true : undefined,
          fallback:
            result.action === "workflow"
              ? present({
                  action: "subagent",
                  when: `only if the ${wordsFor(host).workflowTool} tool is disabled or unavailable`,
                  assignments: result.fallback.assignmentIds,
                  parallel: result.fallback.assignmentIds.length > 1 ? true : undefined,
                  afterwards: result.fallback.afterwards,
                })
              : undefined,
          reason: result.reason,
        })
      }
      case "status": {
        const snapshot = yield* status(context, {})
        const notice = yield* cloudCheckoutNotice(call)
        return notice === undefined ? statusFrom(snapshot) : { ...statusFrom(snapshot), notice }
      }
      case "reconcile":
        return reconcileRows(yield* reconcile(context, {}), wordsFor(host))
      case "handoff": {
        const selected = stringFlag(call.args, "intent")
        const result = yield* handoff(context, selected === undefined ? {} : { intent: selected })
        return {
          source: result.source,
          intents: result.intents.map((item) => ({
            id: item.id,
            revision: item.revision,
            state: item.state,
            objective: item.objective,
            requirements: item.requirements,
            assignments: item.assignments.map((row) => ({
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
            recordedBranches: item.recordedBranches,
            recordedPullRequests: item.recordedPullRequests,
          })),
        }
      }
      case "state mode": {
        const given = call.args.positionals[0]
        if (given === undefined) return present({ ...(yield* stateMode(context, {})) })
        const mode = yield* Schema.decodeUnknownEffect(StateMode)(given).pipe(
          Effect.mapError(
            () =>
              new Usage({
                message: `"${given}" is not a state mode`,
                hint: "Usage: holyagent state mode [branch|work|local]",
              }),
          ),
        )
        const changed = yield* stateMode(context, { mode })
        return present({
          ...(yield* stateMode(context, {})),
          ...("previous" in changed ? { previous: changed.previous } : {}),
        })
      }
      case "migrate": {
        const result = yield* migrate(context, { dryRun: booleanFlag(call.args, "dry-run") })
        if ("dryRun" in result)
          return present({
            dryRun: true,
            ...result.counts,
            unconvertible: result.unconvertible,
            stops: result.stops,
            conflicts: result.conflicts,
            mentions: result.mentions,
            verdict:
              result.problems.length === 0
                ? "a real run would write these records"
                : "a real run would refuse until the problems above are cleared",
          })
        const folders = Object.keys(result.counts).map((source) =>
          source === "holyclaude" ? ".holyclaude" : ".holycodex",
        )
        return present({
          migrated: true,
          ...result.counts,
          reloaded: result.reloaded,
          mentions: result.mentions,
          next: `Nothing was deleted; the records are written where the state mode keeps them (on the state branch in the branch mode, committed there; in the work tree otherwise, where the work mode commits them with the work and the local mode keeps them out of git). Check the result with \`holyagent intent list\`, point the files under mentions at .holyagent/, then delete ${folders.join(" and ")} (the root does it)`,
        })
      }
      default:
        return yield* new Usage({
          message: `Unknown core operation ${name}`,
          hint: "Run holyagent --help.",
        })
    }
  })
