import { readFile, realpath, stat } from "node:fs/promises"
import { basename, resolve } from "node:path"

import { Clock, Data, Effect, Schema } from "effect"

import { loadConfigWithSource } from "../config/load.ts"
import { accept as acceptDomain } from "../domain/acceptance.ts"
import {
  type Assignment,
  AssignmentDraft,
  AssignmentState,
  createAssignment,
} from "../domain/assignment.ts"
import { InvalidDraft } from "../domain/errors.ts"
import { wordsFor } from "../domain/host.ts"
import { AssignmentId, IntentId, newId } from "../domain/ids.ts"
import {
  closeAssignment,
  dispatch as dispatchDomain,
  record as recordDomain,
} from "../domain/lifecycle.ts"
import { Revision } from "../domain/primitives.ts"
import { findAssignment, findIntent, type Project } from "../domain/project.ts"
import { agentFor, routeFor } from "../domain/route.ts"
import { routeModel, subagentModel } from "../pi/provider.ts"
import { selectConfiguredRoute } from "../routing/selection.ts"
import { commitFile, io } from "../state/files.ts"
import { stateDirectory } from "../state/layout.ts"
import { workTreeKey } from "../state/local.ts"
import { validateOperationalResources } from "../state/operational.ts"
import type { Snapshot } from "../state/store.ts"
import { operationalWorktrees } from "../state/tree.ts"
import { artifactFile } from "./artifacts.ts"
import { type Context, decode, requireCapability, resolveIntent, withState } from "./context.ts"
import { JsonReport, renderJsonReport } from "./jsonreport.ts"
import {
  acceptanceFrom,
  briefText,
  dispatchedCall,
  dispatchPrompt,
  journalResults,
  piJournalReports,
  piRecordReports,
} from "./report.ts"

const Draft = Schema.Struct({
  ...AssignmentDraft.fields,
  intentId: Schema.optionalKey(IntentId),
  intentRevision: Schema.optionalKey(Revision),
})
const Reference = Schema.Struct({ id: AssignmentId })
/** Strict operation inputs for the Assignment API. */
export const schemas = {
  create: Draft,
  dispatch: Schema.Union([Reference, Draft]),
  record: Schema.Union([
    Schema.Struct({ id: AssignmentId, agent: Schema.String }),
    Schema.Struct({ id: AssignmentId, failed: Schema.Literal(true) }),
  ]),
  close: Schema.Struct({
    id: AssignmentId,
    outcome: Schema.Literals(["success", "failure", "errored", "interrupted", "stopped"]),
    accept: Schema.optionalKey(Schema.String),
    report: Schema.optionalKey(Schema.String),
    reportJson: Schema.optionalKey(JsonReport),
  }),
  accept: Schema.Struct({
    id: AssignmentId,
    rationale: Schema.String,
    carryForward: Schema.optionalKey(Schema.Boolean),
    report: Schema.optionalKey(Schema.String),
  }),
  show: Reference,
  list: Schema.Struct({
    state: Schema.optionalKey(AssignmentState),
    all: Schema.optionalKey(Schema.Boolean),
  }),
  reports: Schema.Struct({ source: Schema.String }),
} as const

/** A required host presentation asset was not made available. */
export class MissingAsset extends Data.TaggedError("MissingAsset")<{ readonly role: string }> {}

const now = Clock.currentTimeMillis.pipe(Effect.map((millis) => new Date(millis).toISOString()))
const complete = (snapshot: Snapshot, input: typeof Draft.Type) =>
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
const validateResources = (
  context: Context,
  root: string,
  assignment: Pick<Assignment, "operationalResources">,
) =>
  assignment.operationalResources?.length
    ? operationalWorktrees(root, context.env).pipe(
        Effect.flatMap((roots) =>
          validateOperationalResources(assignment.operationalResources ?? [], roots),
        ),
      )
    : Effect.void

/** Creates a Ready Assignment. */
export const create = (context: Context, input: typeof schemas.create.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.create, input)
    const id = yield* newId("assignment")
    const at = yield* now
    return yield* withState(context, "assignment.create", "ifPresent", ({ root, update }) =>
      update((snapshot) =>
        Effect.gen(function* () {
          const draft = yield* complete(snapshot, request)
          yield* validateResources(context, root, draft)
          return yield* createAssignment(snapshot.project, draft, { id, now: at })
        }),
      ).pipe(Effect.map(({ assignment }) => assignment)),
    )
  })

/** Starts an Assignment and writes the brief before committing its Running state. */
export const dispatch = (context: Context, input: typeof schemas.dispatch.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.dispatch, input)
    const generated = yield* newId("assignment")
    const at = yield* now
    return yield* withState(
      context,
      "assignment.dispatch",
      "ifPresent",
      ({ root, directory, update }) =>
        Effect.gen(function* () {
          const rawProfile = context.env.HOLYAGENT_ROUTING_PROFILE?.trim()
          const requested =
            rawProfile === undefined || rawProfile === ""
              ? undefined
              : yield* decode(Schema.Literals(["normal", "fast"]), rawProfile)
          const source =
            context.host === "pi" || requested !== undefined
              ? yield* loadConfigWithSource({
                  projectDirectories: [stateDirectory(root)],
                  env: context.env,
                })
              : undefined
          const profile =
            requested ?? (context.host === "pi" ? source?.config.pi.profile : undefined)
          return yield* update((snapshot) =>
            Effect.gen(function* () {
              const id = "id" in request ? request.id : generated
              let project: Project = snapshot.project
              if (!("id" in request)) {
                const draft = yield* complete(snapshot, request)
                yield* validateResources(context, root, draft)
                const planned = yield* createAssignment(project, draft, { id, now: at })
                project = { ...project, assignments: [...project.assignments, planned.assignment] }
              }
              const assignment = yield* findAssignment(project, id)
              yield* validateResources(context, root, assignment)
              if (context.host !== "pi" && assignment.screen === true)
                return yield* new InvalidDraft({
                  message: `The screen capability is available under the pi host only; this is the ${context.host} host. Dispatch the Assignment without screen`,
                })
              const selected =
                profile === undefined || source === undefined
                  ? undefined
                  : selectConfiguredRoute(
                      source.config,
                      source.written,
                      context.host,
                      assignment.roleTask,
                      assignment.screen === true,
                      profile,
                      at,
                    )
              if (selected?.error !== undefined)
                return yield* new InvalidDraft({ message: selected.error })
              const route =
                context.host === "pi" && source !== undefined
                  ? routeModel(source.config, assignment.roleTask, {
                      screen: assignment.screen === true,
                    })
                  : undefined
              const fallback =
                route === undefined
                  ? routeFor(assignment.roleTask)
                  : { model: subagentModel(route), effort: route.thinking }
              const launch = selected ?? fallback
              const execution =
                selected === undefined
                  ? context.execution
                  : {
                      ...context.execution,
                      profileRouting: true as const,
                      intendedLaunch: {
                        host: context.host,
                        provider: selected.provider,
                        model: selected.model,
                        effort: selected.effort,
                        profile: selected.profile,
                        ...(selected.evidenceRevision === undefined
                          ? {}
                          : { evidenceRevision: selected.evidenceRevision }),
                      },
                    }
              const started = yield* dispatchDomain(
                project,
                snapshot.specialists,
                id,
                at,
                execution,
                workTreeKey(root),
              )
              const agentName = agentFor(
                routeFor(assignment.roleTask),
                assignment.screen,
                context.execution.screenForm,
              )
              const agent = context.host === "pi" ? agentName : `holyagent:${agentName}`
              const firstPass = context.firstPass?.[assignment.roleTask]
              if (
                context.host === "pi" &&
                ["Reviewer.code", "Reviewer.security"].includes(assignment.roleTask) &&
                firstPass === undefined
              )
                return yield* new MissingAsset({ role: assignment.roleTask })
              const brief = briefText(started.assignment, agent, context.host, firstPass)
              const path = yield* artifactFile(context, root, directory, "briefs", id)
              yield* requireCapability(context, "assignment.dispatch")
              yield* commitFile(path, `${brief}\n`)
              return {
                ...started,
                briefPath: path,
                prompt: dispatchPrompt(started.assignment, agent, path, wordsFor(context.host)),
                agent,
                launch: context.host === "pi" && source?.config.pi.enable === false ? {} : launch,
              }
            }),
          )
        }),
    )
  })

/** Records a launch or returns a failed launch to Ready. */
export const record = (context: Context, input: typeof schemas.record.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.record, input)
    return yield* withState(context, "assignment.record", "ifPresent", ({ update }) =>
      update((snapshot) =>
        Effect.gen(function* () {
          const found = yield* findAssignment(snapshot.project, request.id)
          const route = routeFor(found.roleTask)
          if ("agent" in request) {
            const agent = request.agent
            const prefix = ["workflow:", "pi-workflow:"].find((value) => agent.startsWith(value))
            const pieces = prefix === undefined ? [] : agent.slice(prefix.length).split("/")
            if (
              !/\S/.test(agent) ||
              (context.host === "pi" &&
                !(agent.startsWith("pi:") || agent.startsWith("pi-workflow:"))) ||
              (context.host === "pi" && prefix === "workflow:") ||
              (prefix !== undefined &&
                (pieces.length !== 2 ||
                  !/^\S+$/.test(pieces[0] ?? "") ||
                  pieces[1] !== request.id)) ||
              (agent.startsWith("pi:") && !/^\S+$/.test(agent.slice(3)))
            )
              return yield* new InvalidDraft({
                message:
                  context.host === "pi" && prefix === "workflow:"
                    ? `Under the pi host an agent is recorded as pi:<agent-id>, or as pi-workflow:<run-id>/${request.id} for a workflow's agent`
                    : prefix !== undefined
                      ? `A workflow agent is recorded as ${prefix}<run-id>/${request.id}`
                      : agent.startsWith("pi:")
                        ? "A pi agent is recorded as pi:<agent-id>"
                        : `Under the pi host an agent is recorded as pi:<agent-id>, or as pi-workflow:<run-id>/${request.id} for a workflow's agent`,
              })
          }
          return yield* recordDomain(
            snapshot.project,
            snapshot.specialists,
            request.id,
            "agent" in request
              ? { launched: true, agentId: request.agent, model: route.model, effort: route.effort }
              : { launched: false },
          )
        }),
      ).pipe(Effect.map(({ assignment }) => assignment)),
    )
  })

/** Closes an Assignment, optionally validating report evidence and accepting it. */
export const close = (context: Context, input: typeof schemas.close.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.close, input)
    if (request.report !== undefined && request.reportJson !== undefined)
      return yield* new InvalidDraft({ message: "Provide report or reportJson, not both" })
    if (
      request.accept !== undefined &&
      (request.outcome !== "success" ||
        (request.reportJson !== undefined && request.reportJson.status !== "done"))
    )
      return yield* new InvalidDraft({
        message: `--accept needs a report with status done, but the report says ${request.reportJson?.status ?? request.outcome}`,
      })
    const report =
      request.reportJson === undefined
        ? (request.report ?? "")
        : renderJsonReport(request.reportJson)
    if (request.outcome === "success" && report.trim() === "")
      return yield* new InvalidDraft({ message: "Successful work needs a report" })
    const outcome =
      request.outcome === "success"
        ? "Succeeded"
        : request.outcome === "interrupted" || request.outcome === "stopped"
          ? "Cancelled"
          : "Failed"
    const result =
      outcome === "Succeeded"
        ? report
        : report.trim() === ""
          ? request.outcome
          : `${request.outcome}: ${report}`
    const at = yield* now
    return yield* withState(context, "assignment.close", "ifPresent", ({ update }) =>
      update((snapshot) =>
        Effect.gen(function* () {
          const acceptance =
            request.accept === undefined
              ? undefined
              : yield* acceptanceFrom(
                  yield* findAssignment(snapshot.project, request.id),
                  result,
                  request.accept,
                  false,
                )
          return yield* closeAssignment(
            snapshot.project,
            snapshot.specialists,
            request.id,
            { outcome, result, ...(acceptance === undefined ? {} : { accept: acceptance }) },
            at,
          )
        }),
      ).pipe(Effect.map(({ assignment }) => assignment)),
    )
  })

/** Accepts completed work using its stored or corrected report. */
export const accept = (context: Context, input: typeof schemas.accept.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.accept, input)
    const at = yield* now
    return yield* withState(context, "assignment.accept", "ifPresent", ({ update }) =>
      update((snapshot) =>
        Effect.gen(function* () {
          const found = yield* findAssignment(snapshot.project, request.id)
          const acceptance = yield* acceptanceFrom(
            found,
            request.report ?? found.result ?? "",
            request.rationale,
            request.carryForward ?? false,
          )
          return request.report === undefined
            ? yield* acceptDomain(snapshot.project, request.id, acceptance)
            : yield* closeAssignment(
                snapshot.project,
                snapshot.specialists,
                request.id,
                { outcome: "Succeeded", result: request.report, accept: acceptance },
                at,
              )
        }),
      ).pipe(Effect.map(({ assignment }) => assignment)),
    )
  })

/** Reads one recorded Assignment. */
export const show = (context: Context, input: typeof schemas.show.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.show, input)
    return yield* withState(context, "assignment.show", "ifPresent", ({ directory, read }) =>
      read(directory).pipe(Effect.flatMap(({ project }) => findAssignment(project, request.id))),
    )
  })

/** Lists Assignments in the active Intent or all Intents. */
export const list = (context: Context, input: typeof schemas.list.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.list, input)
    return yield* withState(context, "assignment.list", "ifPresent", ({ directory, read }) =>
      Effect.gen(function* () {
        const snapshot = yield* read(directory)
        const id = request.all ? undefined : (yield* resolveIntent(snapshot)).id
        return snapshot.project.assignments
          .filter(
            (row) =>
              (id === undefined || row.intentId === id) &&
              (request.state === undefined || row.state === request.state),
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
      }),
    )
  })

/** Imports reports from a local host journal and writes their assignment report artifacts. */
export const reports = (context: Context, input: typeof schemas.reports.Encoded) =>
  Effect.gen(function* () {
    const request = yield* decode(schemas.reports, input)
    if (
      request.source.trim() === "" ||
      request.source.includes("\0") ||
      /^[a-z][a-z0-9+.-]*:\/\//i.test(request.source)
    )
      return yield* new InvalidDraft({ message: "Report source must name a local file" })
    return yield* withState(context, "assignment.reports", "peek", ({ root, directory, read }) =>
      Effect.gen(function* () {
        const path = resolve(context.cwd, request.source)
        const source = yield* io(path, () => realpath(path))
        if (!(yield* io(source, () => stat(source))).isFile())
          return yield* new InvalidDraft({ message: "Report source must be a regular local file" })
        const text = yield* io(source, () => readFile(source, "utf8"))
        const snapshot = yield* read(directory)
        let found: {
          readonly reports: ReadonlyArray<{ readonly id: string; readonly report: string }>
          readonly notAssignmentIds: ReadonlyArray<{
            readonly label: string
            readonly agentId: string
          }>
        }
        if (context.host === "claude") {
          const results = yield* journalResults(text, source)
          const selected = new Map<string, string>()
          const rejected: Array<{ label: string; agentId: string }> = []
          for (const entry of results) {
            if (entry.label !== undefined && Schema.is(AssignmentId)(entry.label))
              selected.set(entry.label, entry.report)
            else rejected.push({ label: entry.label ?? "", agentId: entry.agentId })
          }
          found = {
            reports: [...selected].map(([id, report]) => ({ id, report })),
            notAssignmentIds: rejected,
          }
        } else if (!basename(source).endsWith(".workflow.jsonl")) {
          found = yield* piRecordReports(
            text,
            source,
            snapshot.project.assignments.flatMap(({ id, specialist }) =>
              specialist?.agentId !== undefined &&
              (specialist.agentId.startsWith("pi:") ||
                specialist.agentId.startsWith("pi-workflow:"))
                ? [{ id, agentId: specialist.agentId }]
                : [],
            ),
          )
        } else {
          const settings = yield* loadConfigWithSource({
            projectDirectories: [stateDirectory(root)],
            env: context.env,
          })
          const calls = yield* Effect.forEach(snapshot.project.assignments, (item) =>
            Effect.gen(function* () {
              const route = routeModel(settings.config, item.roleTask, {
                screen: item.screen === true,
              })
              const selected = item.specialist?.intendedLaunch
              const launch =
                selected === undefined
                  ? settings.config.pi.enable
                    ? { model: subagentModel(route), effort: route.thinking }
                    : {}
                  : { model: selected.model, effort: selected.effort }
              const path = yield* artifactFile(context, root, directory, "briefs", item.id)
              return dispatchedCall(
                item,
                agentFor(routeFor(item.roleTask), item.screen, context.execution.screenForm),
                path,
                launch,
                context.execution.screenForm,
              )
            }),
          )
          found = yield* piJournalReports(text, source, calls)
        }
        yield* requireCapability(context, "assignment.reports")
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const reports = yield* Effect.forEach(found.reports, ({ id, report }) =>
              Effect.gen(function* () {
                const path = yield* artifactFile(context, root, directory, "reports", id)
                yield* commitFile(path, `${report}\n`)
                return { id, path, words: report.split(/\s+/).filter(Boolean).length }
              }),
            )
            return { reports, notAssignmentIds: found.notAssignmentIds }
          }),
        )
      }),
    )
  })
