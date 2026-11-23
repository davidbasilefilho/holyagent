import { assignment, intent } from "@holyagent/core"
import { Effect, Schema } from "effect"

import { Criterion } from "../domain/assignment.ts"
import { AssignmentId } from "../domain/ids.ts"
import { Text } from "../domain/primitives.ts"
import { type FlagArgs, type FlagShape, readFlags } from "./args.ts"
import { Usage } from "./errors.ts"

/** A typed input or explicit report file supplied alongside the existing command arguments. */
export interface AgentInput {
  readonly argv: ReadonlyArray<string>
  readonly input?: unknown
  readonly reportFile?: string
}

/** Help overrides for commands that carry complex data as flags on the agent surface. */
export interface AgentInputHelp {
  readonly usage: string
  readonly notes: ReadonlyArray<string>
}

const DRAFT_FLAGS =
  "--role-task <role> --objective <text> --criterion <blocking|advisory:dimension:text>..."
const DRAFT_NOTES = [
  "Repeat --criterion for each criterion. Use blocking or advisory, then a dimension and the full criterion text, for example --criterion 'blocking:behavior:Reject malformed input'. Dimensions: behavior, regressions, tests, scope, style, repo-standards.",
  "Optional repeatable flags: --scope, --constraint, --evidence, --ownership-path, --operational-path, --dependency, --independent-from. An operational path is an absolute local path.",
  "Optional single flags: --follow-up-of <assignment-id>, --intent-id <id>, --intent-revision <positive-integer>, --screen.",
]

const usages: Readonly<Record<string, AgentInputHelp>> = {
  "intent create": {
    usage: "intent create --objective <text> [--requirement <text>...]",
    notes: ["Repeat --requirement to supply the binding requirements in order."],
  },
  "intent update": {
    usage:
      "intent update [--objective <text>] [--requirement <text>... | --clear-requirements] [--material]",
    notes: [
      "Set at least one flag. Requirements replace the previous list. --material advances the Intent revision and makes older open work stale.",
    ],
  },
  "assignment create": { usage: `assignment create ${DRAFT_FLAGS}`, notes: DRAFT_NOTES },
  "assignment dispatch": {
    usage: `assignment dispatch (--id <id> | ${DRAFT_FLAGS})`,
    notes: [
      "--id starts an existing Ready Assignment and cannot be combined with a draft.",
      ...DRAFT_NOTES,
    ],
  },
  "assignment close": {
    usage:
      "assignment close <id> --outcome <outcome> [--accept <rationale>] [--report-file <path>] [--report-json]",
    notes: [
      "Outcomes: success, failure, errored, interrupted, stopped. Success requires --report-file. --report-json reads a structured report from that file.",
      "With --accept, supply the specialist's result and the evidence for each blocking criterion and required label. Keep their text intact.",
    ],
  },
  "assignment accept": {
    usage: "assignment accept <id> --rationale <text> [--report-file <path>] [--carry-forward]",
    notes: ["Without --report-file, acceptance uses the stored report."],
  },
}

/** Returns the flag-based help for an agent command, if it differs from the shared help. */
export const agentInputHelp = (path: ReadonlyArray<string>): AgentInputHelp | undefined =>
  Object.hasOwn(usages, path.join(" ")) ? usages[path.join(" ")] : undefined

const one = { kind: "one" } as const
const many = { kind: "many" } as const
const toggle = { kind: "switch" } as const
const value = (args: FlagArgs, name: string) => args.values[name]?.[0]
const invalid = (usage: string, message: string) =>
  new Usage({ message, hint: `Usage: holyagent-cli ${usage}` })
const readAgentFlags = (
  argv: ReadonlyArray<string>,
  flags: Readonly<Record<string, FlagShape>>,
  usage: string,
) => readFlags(argv, flags, usage).pipe(Effect.mapError((error) => invalid(usage, error.message)))

const decode = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown, usage: string) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => invalid(usage, error.message)),
  )

const withoutPositionals = (args: FlagArgs, usage: string) =>
  args.positionals.length === 0
    ? Effect.void
    : Effect.fail(invalid(usage, "Unexpected positional arguments. Pass values with named flags."))

const intentInput = (command: string, argv: ReadonlyArray<string>, usage: string) =>
  Effect.gen(function* () {
    const create = command === "intent create"
    const args = yield* readAgentFlags(
      argv,
      {
        objective: one,
        requirement: many,
        ...(create ? {} : { material: toggle, "clear-requirements": toggle }),
      },
      usage,
    )
    yield* withoutPositionals(args, usage)
    const objective = value(args, "objective")
    const requested = args.values["requirement"]
    const clear = args.switches.has("clear-requirements")
    const material = args.switches.has("material")
    if (create && objective === undefined) return yield* invalid(usage, "Missing --objective")
    if (clear && requested !== undefined)
      return yield* invalid(usage, "Use either --requirement or --clear-requirements")
    const requirements = clear ? [] : requested
    if (objective === undefined && requirements === undefined && !material)
      return yield* invalid(
        usage,
        "Supply --objective, --requirement, --clear-requirements, or --material",
      )
    const fields = {
      ...(objective === undefined ? {} : { objective }),
      ...(requirements === undefined ? {} : { requirements }),
    }
    if (create) return { argv: [], input: yield* decode(intent.schemas.create, fields, usage) }
    yield* decode(intent.schemas.update, { ...fields, material }, usage)
    return { argv: material ? ["--material"] : [], input: fields }
  })

const draftFlags = {
  "role-task": one,
  objective: one,
  scope: many,
  constraint: many,
  criterion: many,
  evidence: many,
  "ownership-path": many,
  "operational-path": many,
  dependency: many,
  "independent-from": many,
  "follow-up-of": one,
  screen: toggle,
  "intent-id": one,
  "intent-revision": one,
}

const decodeCriterion = (raw: string, usage: string) => {
  const parts = /^(blocking|advisory):([^:]+):([\s\S]+)$/.exec(raw)
  return parts === null
    ? Effect.fail(
        invalid(usage, "--criterion expects blocking:dimension:text or advisory:dimension:text"),
      )
    : decode(
        Criterion,
        { blocking: parts[1] === "blocking", dimension: parts[2], text: parts[3] },
        usage,
      )
}

const assignmentInput = (command: string, argv: ReadonlyArray<string>, usage: string) =>
  Effect.gen(function* () {
    const args = yield* readAgentFlags(
      argv,
      { ...draftFlags, ...(command === "assignment dispatch" ? { id: one } : {}) },
      usage,
    )
    yield* withoutPositionals(args, usage)
    const id = value(args, "id")
    if (id !== undefined) {
      if (Object.keys(args.values).length !== 1 || args.switches.size !== 0)
        return yield* invalid(usage, "Use --id on its own to dispatch an existing Assignment")
      return { argv: [], input: { id: yield* decode(AssignmentId, id, usage) } }
    }
    const roleTask = value(args, "role-task")
    const objective = value(args, "objective")
    const givenCriteria = args.values["criterion"]
    if (roleTask === undefined) return yield* invalid(usage, "Missing --role-task")
    if (objective === undefined) return yield* invalid(usage, "Missing --objective")
    if (givenCriteria === undefined) return yield* invalid(usage, "Missing --criterion")
    const criteria = yield* Effect.forEach(givenCriteria, (criterion) =>
      decodeCriterion(criterion, usage),
    )
    const operationalPaths = args.values["operational-path"]
    const followUpOf = value(args, "follow-up-of")
    const intentId = value(args, "intent-id")
    const revision = value(args, "intent-revision")
    if (
      revision !== undefined &&
      (!/^[1-9]\d*$/.test(revision) || !Number.isSafeInteger(Number(revision)))
    )
      return yield* invalid(usage, "--intent-revision expects a positive safe integer")
    const list = (flag: string) => args.values[flag] ?? []
    const draft = {
      roleTask,
      objective,
      criteria,
      scope: list("scope"),
      constraints: list("constraint"),
      evidence: list("evidence"),
      ownershipPaths: list("ownership-path"),
      dependencies: list("dependency"),
      independentFrom: list("independent-from"),
      ...(operationalPaths === undefined
        ? {}
        : {
            operationalResources: operationalPaths.map((target) => ({
              kind: "local-path",
              target,
            })),
          }),
      ...(followUpOf === undefined ? {} : { followUpOf }),
      ...(intentId === undefined ? {} : { intentId }),
      ...(revision === undefined ? {} : { intentRevision: Number(revision) }),
      ...(args.switches.has("screen") ? { screen: true } : {}),
    }
    return { argv: [], input: yield* decode(assignment.schemas.create, draft, usage) }
  })

const reportInput = (command: string, argv: ReadonlyArray<string>, usage: string) =>
  Effect.gen(function* () {
    const close = command === "assignment close"
    const args = yield* readAgentFlags(
      argv,
      close
        ? { outcome: one, accept: one, "report-file": one, "report-json": toggle }
        : { rationale: one, "report-file": one, "carry-forward": toggle },
      usage,
    )
    const [rawId] = args.positionals
    if (args.positionals.length !== 1)
      return yield* invalid(usage, "Supply exactly one Assignment id")
    const id = yield* decode(AssignmentId, rawId, usage)
    const file = value(args, "report-file")
    if (file !== undefined && (file.trim() === "" || file === "-" || file.includes("\0")))
      return yield* invalid(usage, "--report-file expects a local file path")
    if (close) {
      const outcomeArg = value(args, "outcome")
      if (outcomeArg === undefined) return yield* invalid(usage, "Missing --outcome")
      const outcome = yield* decode(assignment.schemas.close.fields.outcome, outcomeArg, usage)
      const json = args.switches.has("report-json")
      if (file === undefined && (outcome === "success" || json))
        return yield* invalid(
          usage,
          "Supply --report-file for a successful result or --report-json",
        )
      const acceptance = value(args, "accept")
      if (acceptance !== undefined) yield* decode(Text, acceptance, usage)
      return {
        argv: [
          id,
          `--outcome=${outcome}`,
          ...(acceptance === undefined ? [] : [`--accept=${acceptance}`]),
          ...(json ? ["--report-json"] : []),
        ],
        ...(file === undefined ? {} : { reportFile: file }),
      }
    }
    const rationaleArg = value(args, "rationale")
    if (rationaleArg === undefined) return yield* invalid(usage, "Missing --rationale")
    const rationale = yield* decode(Text, rationaleArg, usage)
    return {
      argv: [
        id,
        `--rationale=${rationale}`,
        ...(args.switches.has("carry-forward") ? ["--carry-forward"] : []),
        ...(file === undefined ? [] : ["--report"]),
      ],
      ...(file === undefined ? {} : { reportFile: file }),
    }
  })

/** Converts the machine CLI's typed flags to existing operation inputs without touching stdin. */
export const adaptAgentInput = (
  path: ReadonlyArray<string>,
  argv: ReadonlyArray<string>,
): Effect.Effect<AgentInput, Usage> => {
  const command = path.join(" ")
  const help = agentInputHelp(path)
  if (help === undefined) return Effect.succeed({ argv })
  if (path[0] === "intent") return intentInput(command, argv, help.usage)
  if (path[1] === "create" || path[1] === "dispatch")
    return assignmentInput(command, argv, help.usage)
  return reportInput(command, argv, help.usage)
}
