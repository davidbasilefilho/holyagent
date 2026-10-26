import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect, Schema } from "effect"

import { Assignment, type AssignmentState, type Criterion } from "../domain/assignment.ts"
import { AssignmentId, IntentId } from "../domain/ids.ts"
import { Intent } from "../domain/intent.ts"
import { pathProblem } from "../domain/paths.ts"
import { isWriter, RoleTask } from "../domain/route.ts"
import { slugOf } from "../domain/slug.ts"
import { encodeJson, type File, hasCode, io, readText } from "./files.ts"
import { assignmentFile, intentFile, intentFolder } from "./layout.ts"

// Converts the state of the two earlier tools into the records this CLI loads. The conversion is
// read-only: it gathers what it would write and what stops it, and the caller decides.

/** The tool that kept a legacy state folder. */
export type LegacySource = "holyclaude" | "holycodex"

/** The legacy state folders, by tool. */
export const LEGACY_FOLDERS: Readonly<Record<LegacySource, string>> = {
  holyclaude: ".holyclaude",
  holycodex: ".holycodex",
}

/** A record the CLI can write: what it is, which legacy file it came from and its new file. */
export interface Converted {
  readonly kind: "intent" | "assignment"
  readonly id: string
  /** The legacy file, relative to the project root. */
  readonly from: string
  readonly file: File
}

/** A legacy file copied unchanged into the folder of its Intent. */
export interface Note {
  /** The legacy file, absolute. */
  readonly from: string
  /** Where the copy goes, absolute. */
  readonly to: string
}

/** A legacy record or folder that cannot be converted, and why. */
export interface Unconvertible {
  readonly source: LegacySource
  /** The legacy file or folder, relative to the project root. */
  readonly path: string
  readonly reason: string
}

/** Work in flight that must be settled with the legacy tool before the state can move. */
export interface Stop {
  readonly source: LegacySource
  readonly path: string
  readonly message: string
}

/** Everything read from one legacy folder. */
export interface Gathered {
  readonly source: LegacySource
  readonly records: ReadonlyArray<Converted>
  readonly notes: ReadonlyArray<Note>
  readonly unconvertible: ReadonlyArray<Unconvertible>
  readonly stops: ReadonlyArray<Stop>
}

type Read<A> = { readonly value: A } | { readonly problem: string }

const strict = { onExcessProperty: "error" } as const

/** Message text on one line, so a multi-line schema error fits a list. */
const collapse = (message: string): string => message.replace(/\s+/g, " ").trim()

const strings = Schema.Array(Schema.String)
const optionalStrings = Schema.optionalKey(strings)

const HolyclaudeIntent = Schema.Struct({
  id: Schema.String,
  objective: Schema.String,
  requirements: Schema.String,
  revision: Schema.Int,
  state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
  close_reason: Schema.optionalKey(Schema.String),
  closed_at: Schema.optionalKey(Schema.String),
})

const HolyclaudeAssignment = Schema.Struct({
  id: Schema.String,
  intent_id: Schema.String,
  intent_revision: Schema.Int,
  role: Schema.String,
  objective: Schema.String,
  scope: optionalStrings,
  constraints: optionalStrings,
  acceptance_criteria: optionalStrings,
  required_evidence: optionalStrings,
  mutability: Schema.optionalKey(Schema.Literals(["ReadOnly", "ScopedWrite"])),
  metadata: Schema.optionalKey(
    Schema.Struct({
      ownership_paths: optionalStrings,
      symbols: optionalStrings,
      domains: optionalStrings,
      dependencies: optionalStrings,
      related_assignments: optionalStrings,
      independent_from: optionalStrings,
    }),
  ),
  clone_id: Schema.optionalKey(Schema.String),
  state: Schema.Literals(["Ready", "Running", "Succeeded", "Failed", "Cancelled"]),
  result: Schema.optionalKey(Schema.NullOr(Schema.String)),
  acceptance: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        intent_revision: Schema.Int,
        rationale: Schema.String,
        criteria_evidence: Schema.Record(Schema.String, Schema.String),
        required_evidence: Schema.Record(Schema.String, Schema.String),
      }),
    ),
  ),
})

const CodexIntentState = Schema.Literals([
  "scoping",
  "ready",
  "executing",
  "verifying",
  "reviewing",
  "blocked",
  "needs_root_input",
  "complete",
  "abandoned",
])

// The fields holyagent keeps are typed; the rest (gates, evidence, baseline, plan pointers) is
// named so that an unknown field is still refused, and left as it was read.
const codexIntentFields = {
  toon_compatibility: Schema.String,
  id: Schema.String,
  slug: Schema.String,
  title: Schema.String,
  goal: Schema.String,
  acceptance_criteria: strings,
  state: CodexIntentState,
  revision: Schema.Int,
  baseline: Schema.Unknown,
  created_at: Schema.String,
  updated_at: Schema.String,
} as const

const HolycodexIntent = Schema.Struct({
  ...codexIntentFields,
  schema_version: Schema.Literals(["holycodex-intent-1"]),
  plan_required: Schema.Boolean,
  active_plan_revision: Schema.optionalKey(Schema.Int),
  active_plan_digest: Schema.optionalKey(Schema.String),
  blockers: strings,
  resume_state: Schema.optionalKey(Schema.String),
  verification: Schema.Unknown,
  review: Schema.Unknown,
  acceptance_met: Schema.Boolean,
  root_readiness: Schema.Boolean,
  evidence: Schema.Array(Schema.Unknown),
})

const { toon_compatibility: _compatibility, ...legacyIntentFields } = codexIntentFields
const HolycodexIntentV0 = Schema.Struct({
  ...legacyIntentFields,
  schema_version: Schema.Literals(["holycodex-intent-0"]),
})

const CodexInvocation = Schema.Struct({
  id: Schema.String,
  outcome: Schema.String,
  started_at: Schema.String,
  finished_at: Schema.String,
  summary: Schema.String,
  evidence: Schema.Array(Schema.Unknown),
  context7: Schema.optionalKey(Schema.Unknown),
  blocker: Schema.optionalKey(Schema.String),
  remaining_risk: strings,
})

const HolycodexAssignment = Schema.Struct({
  schema_version: Schema.Literals(["holycodex-assignment-1"]),
  toon_compatibility: Schema.String,
  intent_id: Schema.String,
  id: Schema.String,
  objective: Schema.String,
  owner: Schema.Struct({ role: Schema.String, task: Schema.String }),
  scope: strings,
  constraints: strings,
  exclusions: strings,
  dependencies: strings,
  acceptance_criteria: strings,
  status: Schema.Literals([
    "pending",
    "executing",
    "completed",
    "blocked",
    "needs_root_input",
    "failed",
    "superseded",
  ]),
  revision: Schema.Int,
  invocations: Schema.Array(CodexInvocation),
  active_invocation_id: Schema.optionalKey(Schema.String),
  active_started_at: Schema.optionalKey(Schema.String),
  supersedes: Schema.optionalKey(Schema.String),
  superseded_by: Schema.optionalKey(Schema.String),
  supersession_reason: Schema.optionalKey(Schema.String),
  supersession_provenance: Schema.optionalKey(Schema.String),
  evidence: Schema.Array(Schema.Unknown),
  blocker: Schema.optionalKey(Schema.String),
  remaining_risk: strings,
  created_at: Schema.String,
  updated_at: Schema.String,
  active_invocation_capability_verifier: Schema.optionalKey(Schema.String),
  active_invocation_capability: Schema.optionalKey(Schema.String),
})

const parseText = (format: "json" | "toon", text: string) =>
  Effect.try({
    try: (): unknown => (format === "json" ? JSON.parse(text) : decode(text, { strict: true })),
    catch: (cause) => `not valid ${format === "json" ? "JSON" : "TOON"}: ${String(cause)}`,
  })

/**
 * Reads and strictly decodes a legacy record. A file that is not valid JSON or TOON, or does not
 * match the schema (an unknown field included), is a problem the caller reports, not a failure.
 */
const readLegacy = <S extends Schema.Decoder<unknown>>(
  pick: (raw: unknown) => S,
  format: "json" | "toon",
  path: string,
) =>
  readText(path).pipe(
    Effect.flatMap((text) =>
      parseText(format, text ?? "").pipe(
        Effect.flatMap((raw) =>
          Schema.decodeUnknownEffect(
            pick(raw),
            strict,
          )(raw).pipe(Effect.mapError((error) => collapse(error.message))),
        ),
        Effect.map((value): Read<S["Type"]> => ({ value })),
        Effect.catch((problem: string) => Effect.succeed<Read<S["Type"]>>({ problem })),
      ),
    ),
  )

/** The relative paths of every file below a folder, dotfiles included; a missing folder has none. */
const listFiles = (directory: string) =>
  io(directory, () =>
    Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true, onlyFiles: true })),
  ).pipe(
    Effect.map((paths) => paths.toSorted()),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed([] as ReadonlyArray<string>),
    ),
  )

/** Groups relative paths by their first folder; `inside` are the paths below it. */
const byFolder = (paths: ReadonlyArray<string>) => {
  const folders = new Map<string, Array<string>>()
  for (const path of paths) {
    const slash = path.indexOf("/")
    if (slash === -1) continue
    const folder = path.slice(0, slash)
    folders.set(folder, [...(folders.get(folder) ?? []), path.slice(slash + 1)])
  }
  return folders
}

/** A date as ISO text, or undefined when it is not a date this CLI can store. */
const isoOf = (millis: number): string | undefined => {
  const date = new Date(millis)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

const EPOCH = new Date(0).toISOString()

/**
 * The creation time an id carries: its first segment is the base-36 time in milliseconds. An id
 * without one (an early counter id such as `intent-0001`) has no time and reads as the epoch.
 */
const idTime = (id: string): string | undefined => {
  const digits = /^[a-z]+-([0-9a-z]{9})-/.exec(id)?.[1]
  return digits === undefined ? EPOCH : isoOf(Number.parseInt(digits, 36))
}

/** Validates a record through its schema and encodes its file, or says what is wrong with it. */
const converted = <S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  kind: Converted["kind"],
  id: string,
  from: string,
  path: string,
  record: S["Type"],
) =>
  encodeJson(schema, record).pipe(
    Effect.map((content): Read<Converted> => ({
      value: { kind, id, from, file: { path, content } },
    })),
    Effect.catch((error) => Effect.succeed<Read<Converted>>({ problem: collapse(error.message) })),
  )

/** The legacy id when it already is an id of the kind, else the id with the kind put in front. */
const mapId = (kind: "intent" | "assignment", id: string): string | undefined => {
  const is = Schema.is(kind === "intent" ? IntentId : AssignmentId)
  const valid = (text: string): boolean => is(text)
  return valid(id) ? id : valid(`${kind}-${id}`) ? `${kind}-${id}` : undefined
}

const isPortable = (path: string): boolean => pathProblem(path) === undefined

const placeholder = (tool: LegacySource) => `No result was recorded in ${tool}.`

/** Each legacy criterion as a blocking behavior criterion, or the objective when there are none. */
const criteriaOf = (
  texts: ReadonlyArray<string>,
  objective: string,
): readonly [Criterion, ...Array<Criterion>] => {
  const criterion = (text: string): Criterion => ({
    text,
    blocking: true,
    dimension: "behavior",
  })
  const [first = objective, ...rest] = texts.length === 0 ? [objective] : texts
  return [criterion(first), ...rest.map(criterion)]
}

/** Encodes an Intent for its file, with the record it came from. */
const intentRecord = (directory: string, from: string, intent: Read<Intent>) =>
  "problem" in intent
    ? Effect.succeed(intent)
    : converted(
        Intent,
        "intent",
        intent.value.id,
        from,
        intentFile(directory, intent.value),
        intent.value,
      ).pipe(
        Effect.map((record): Read<{ readonly intent: Intent; readonly record: Converted }> =>
          "problem" in record ? record : { value: { intent: intent.value, record: record.value } },
        ),
      )

/** Encodes an Assignment for its file in the folder of its Intent. */
const assignmentRecord = (target: string, from: string, assignment: Read<Assignment>) =>
  "problem" in assignment
    ? Effect.succeed(assignment)
    : converted(
        Assignment,
        "assignment",
        assignment.value.id,
        from,
        assignmentFile(target, assignment.value),
        assignment.value,
      )

/** The state a record is gathered from: what it collects while the folders are read. */
const collector = (source: LegacySource) => ({
  source,
  records: [] as Array<Converted>,
  notes: [] as Array<Note>,
  unconvertible: [] as Array<Unconvertible>,
  stops: [] as Array<Stop>,
})

type Collector = ReturnType<typeof collector>

const unconvertible = (state: Collector, path: string, reason: string) =>
  void state.unconvertible.push({ source: state.source, path, reason })

/** The related ids of a record, as the ones that name a migrated sibling and the texts of the rest. */
const relations = (
  ids: ReadonlyArray<string>,
  siblings: ReadonlySet<string>,
  resolve: (id: string) => string | undefined,
  describe: (id: string) => string,
) => {
  const kept = new Set<string>()
  const texts: Array<string> = []
  for (const id of ids) {
    const mapped = resolve(id)
    if (mapped !== undefined && siblings.has(mapped)) kept.add(mapped)
    else texts.push(describe(id))
  }
  return { ids: [...kept], texts }
}

const holyclaudeIntent = (legacy: typeof HolyclaudeIntent.Type): Read<Intent> => {
  const createdAt = idTime(legacy.id)
  if (createdAt === undefined) return { problem: "its id carries a creation time out of range" }
  const closed = legacy.state === "closed"
  const intent: Intent = {
    id: legacy.id,
    slug: slugOf(legacy.objective),
    objective: legacy.objective,
    requirements: legacy.requirements.trim() === "" ? [] : [legacy.requirements],
    revision: legacy.revision,
    state: closed ? "Closed" : "Open",
    ...(closed
      ? { closeReason: legacy.close_reason ?? "Closed in holyclaude; no reason was recorded." }
      : {}),
    createdAt,
  }
  return { value: intent }
}

const holyclaudeAssignment = (
  legacy: typeof HolyclaudeAssignment.Type,
  roleTask: RoleTask,
  siblings: ReadonlySet<string>,
): Read<Assignment> => {
  const createdAt = idTime(legacy.id)
  if (createdAt === undefined) return { problem: "its id carries a creation time out of range" }
  const metadata = legacy.metadata
  const owned = metadata?.ownership_paths ?? []
  const dependencies = relations(
    metadata?.dependencies ?? [],
    siblings,
    (id) => id,
    (id) => `Dependency not migrated: ${id}`,
  )
  const independent = relations(
    metadata?.independent_from ?? [],
    siblings,
    (id) => id,
    (id) => `Independent from (not migrated): ${id}`,
  )
  const scope = [
    ...(legacy.scope ?? []),
    ...owned
      .filter((path) => !isPortable(path))
      .map((path) => `Owned path (not portable): ${path}`),
    ...(metadata?.related_assignments ?? []).map((id) => `Related Assignment: ${id}`),
    ...dependencies.texts,
    ...independent.texts,
  ]
  const acceptance = legacy.state === "Succeeded" ? legacy.acceptance : undefined
  const result =
    legacy.state === "Ready"
      ? undefined
      : (legacy.result ?? "").trim() === ""
        ? placeholder("holyclaude")
        : (legacy.result ?? "")
  const assignment: Assignment = {
    id: legacy.id,
    intentId: legacy.intent_id,
    intentRevision: legacy.intent_revision,
    roleTask,
    slug: slugOf(legacy.objective),
    objective: legacy.objective,
    state: legacy.state,
    scope,
    constraints: legacy.constraints ?? [],
    criteria: criteriaOf(legacy.acceptance_criteria ?? [], legacy.objective),
    evidence: legacy.required_evidence ?? [],
    ownershipPaths: owned.filter(isPortable),
    dependencies: dependencies.ids,
    independentFrom: independent.ids,
    ...(result === undefined ? {} : { result }),
    ...(acceptance === undefined || acceptance === null
      ? {}
      : {
          acceptance: {
            revision: acceptance.intent_revision,
            rationale: acceptance.rationale,
            criteria: Object.entries(acceptance.criteria_evidence).map(([criterion, support]) => ({
              criterion,
              support,
            })),
            evidence: Object.entries(acceptance.required_evidence).map(([label, support]) => ({
              label,
              support,
            })),
          },
        }),
    createdAt,
  }
  return { value: assignment }
}

const gatherHolyclaude = (root: string, directory: string) =>
  Effect.gen(function* () {
    const folderName = LEGACY_FOLDERS.holyclaude
    const legacy = join(root, folderName)
    const files = yield* listFiles(legacy)
    if (files.length === 0) return undefined
    const state = collector("holyclaude")
    const intents = byFolder(
      files.filter((path) => path.startsWith("intents/")).map((path) => path.slice(8)),
    )
    for (const [folder, inside] of intents) {
      const base = join(legacy, "intents", folder)
      const shown = (relative: string) => `${folderName}/intents/${folder}/${relative}`
      if (!inside.includes("intent.json")) {
        unconvertible(state, shown("").slice(0, -1), "the folder has no intent.json")
        continue
      }
      const assignmentFiles = inside.filter((path) => /^assignments\/[^/]+\.json$/.test(path))
      const notes = inside.filter(
        (path) =>
          path !== "intent.json" && !assignmentFiles.includes(path) && !path.endsWith(".tmp"),
      )
      const read = yield* readLegacy(() => HolyclaudeIntent, "json", join(base, "intent.json"))
      const intent = yield* intentRecord(
        directory,
        shown("intent.json"),
        "problem" in read ? read : holyclaudeIntent(read.value),
      )
      if ("problem" in intent) {
        unconvertible(state, shown("intent.json"), intent.problem)
        for (const path of assignmentFiles)
          unconvertible(state, shown(path), "its Intent could not be converted")
        continue
      }
      state.records.push(intent.value.record)
      const target = intentFolder(directory, intent.value.intent)
      for (const path of notes) state.notes.push({ from: join(base, path), to: join(target, path) })

      const decoded: Array<{ path: string; value: typeof HolyclaudeAssignment.Type }> = []
      for (const path of assignmentFiles) {
        const assignment = yield* readLegacy(() => HolyclaudeAssignment, "json", join(base, path))
        if ("problem" in assignment) unconvertible(state, shown(path), assignment.problem)
        else if (assignment.value.intent_id !== intent.value.intent.id)
          unconvertible(
            state,
            shown(path),
            `it belongs to ${assignment.value.intent_id}, not to the Intent of its folder`,
          )
        else decoded.push({ path, value: assignment.value })
      }
      const siblings = new Set(decoded.map(({ value }) => value.id))
      for (const { path, value } of decoded) {
        if (value.state === "Running") {
          state.stops.push({
            source: "holyclaude",
            path: shown(path),
            message: `${value.id} is Running; finish it (holyclaude assignment finish ${value.id} --outcome <outcome>) or cancel it (holyclaude assignment cancel ${value.id}) with holyclaude, then migrate again`,
          })
          continue
        }
        if (!Schema.is(RoleTask)(value.role)) {
          unconvertible(state, shown(path), `role ${value.role} is not a holyagent route`)
          continue
        }
        const result = yield* assignmentRecord(
          target,
          shown(path),
          holyclaudeAssignment(value, value.role, siblings),
        )
        if ("problem" in result) unconvertible(state, shown(path), result.problem)
        else state.records.push(result.value)
      }
    }
    return state satisfies Gathered
  })

/** The fields of an Intent of either holycodex schema that holyagent keeps. */
interface CodexIntent {
  readonly id: string
  readonly title: string
  readonly goal: string
  readonly acceptance_criteria: ReadonlyArray<string>
  readonly state: typeof CodexIntentState.Type
  readonly revision: number
  readonly created_at: string
}

const holycodexIntent = (legacy: CodexIntent): Read<Intent> => {
  const id = mapId("intent", legacy.id)
  if (id === undefined) return { problem: `${legacy.id} cannot become an Intent id` }
  const createdAt = isoOf(Date.parse(legacy.created_at))
  if (createdAt === undefined) return { problem: `created_at ${legacy.created_at} is not a date` }
  const closed = legacy.state === "complete" || legacy.state === "abandoned"
  const intent: Intent = {
    id,
    slug: slugOf(legacy.title),
    objective: legacy.title,
    requirements: [legacy.goal, ...legacy.acceptance_criteria],
    revision: legacy.revision,
    state: closed ? "Closed" : "Open",
    ...(closed ? { closeReason: `Closed in holycodex (state ${legacy.state}).` } : {}),
    createdAt,
  }
  return { value: intent }
}

const CODEX_STATE: Readonly<Record<string, AssignmentState>> = {
  pending: "Ready",
  completed: "Succeeded",
  failed: "Failed",
  blocked: "Failed",
  needs_root_input: "Failed",
  superseded: "Cancelled",
}

const holycodexAssignment = (
  legacy: typeof HolycodexAssignment.Type,
  roleTask: RoleTask,
  intent: Intent,
  siblings: ReadonlySet<string>,
): Read<Assignment> => {
  const id = mapId("assignment", legacy.id)
  if (id === undefined) return { problem: `${legacy.id} cannot become an Assignment id` }
  const createdAt = isoOf(Date.parse(legacy.created_at))
  if (createdAt === undefined) return { problem: `created_at ${legacy.created_at} is not a date` }
  const state = CODEX_STATE[legacy.status]
  if (state === undefined) return { problem: `status ${legacy.status} has no holyagent state` }
  const dependencies = relations(
    legacy.dependencies,
    siblings,
    (dependency) => mapId("assignment", dependency),
    (dependency) => `Dependency not migrated: ${dependency}`,
  )
  const last = legacy.invocations.at(-1)
  const blocker = legacy.blocker ?? last?.blocker
  const lossy = ["blocked", "needs_root_input", "superseded"].includes(legacy.status)
  const lines = [
    ...(last === undefined ? [] : [last.summary]),
    ...(blocker === undefined ? [] : [`Blocker: ${blocker}`]),
    ...(lossy ? [`holycodex status: ${legacy.status}`] : []),
  ]
  const assignment: Assignment = {
    id,
    intentId: intent.id,
    intentRevision: intent.revision,
    roleTask,
    slug: slugOf(legacy.objective),
    objective: legacy.objective,
    state,
    scope: [...legacy.scope, ...dependencies.texts],
    constraints: [...legacy.constraints, ...legacy.exclusions.map((text) => `Exclusion: ${text}`)],
    criteria: criteriaOf(legacy.acceptance_criteria, legacy.objective),
    evidence: [],
    ownershipPaths: isWriter(roleTask) ? legacy.scope.filter(isPortable) : [],
    dependencies: dependencies.ids,
    independentFrom: [],
    ...(state === "Ready"
      ? {}
      : { result: lines.length === 0 ? placeholder("holycodex") : lines.join("\n") }),
    createdAt,
  }
  return { value: assignment }
}

const TRANSACTION_FILE = ".holycodex-transaction.toon"

const gatherHolycodex = (root: string, directory: string) =>
  Effect.gen(function* () {
    const folderName = LEGACY_FOLDERS.holycodex
    const legacy = join(root, folderName)
    const files = yield* listFiles(legacy)
    if (files.length === 0) return undefined
    const state = collector("holycodex")
    const folders = byFolder(files.filter((path) => !path.startsWith(".")))
    for (const [folder, inside] of folders) {
      const base = join(legacy, folder)
      const shown = (relative: string) => `${folderName}/${folder}/${relative}`
      if (!inside.includes("intent.toon")) {
        unconvertible(state, `${folderName}/${folder}`, "the folder has no intent.toon")
        continue
      }
      if (inside.includes(TRANSACTION_FILE))
        state.stops.push({
          source: "holycodex",
          path: shown(TRANSACTION_FILE),
          message: `holycodex was interrupted while writing ${folder}; run a holycodex-agent command that reads its work state (for example holycodex-agent intent current), which recovers the write, then migrate again`,
        })
      const assignmentFiles = inside.filter((path) => /^assignments\/[^/]+\.toon$/.test(path))
      const notes = inside.filter(
        (path) =>
          path !== "intent.toon" &&
          path !== TRANSACTION_FILE &&
          !assignmentFiles.includes(path) &&
          !path.endsWith(".tmp"),
      )
      const read = yield* readLegacy(
        (raw): Schema.Decoder<CodexIntent> =>
          typeof raw === "object" &&
          raw !== null &&
          "schema_version" in raw &&
          raw.schema_version === "holycodex-intent-0"
            ? HolycodexIntentV0
            : HolycodexIntent,
        "toon",
        join(base, "intent.toon"),
      )
      const intent = yield* intentRecord(
        directory,
        shown("intent.toon"),
        "problem" in read ? read : holycodexIntent(read.value),
      )
      if ("problem" in intent) {
        unconvertible(state, shown("intent.toon"), intent.problem)
        for (const path of assignmentFiles)
          unconvertible(state, shown(path), "its Intent could not be converted")
        continue
      }
      state.records.push(intent.value.record)
      const target = intentFolder(directory, intent.value.intent)
      for (const path of notes) state.notes.push({ from: join(base, path), to: join(target, path) })

      const decoded: Array<{ path: string; value: typeof HolycodexAssignment.Type }> = []
      for (const path of assignmentFiles) {
        const assignment = yield* readLegacy(() => HolycodexAssignment, "toon", join(base, path))
        if ("problem" in assignment) unconvertible(state, shown(path), assignment.problem)
        else if (mapId("intent", assignment.value.intent_id) !== intent.value.intent.id)
          unconvertible(
            state,
            shown(path),
            `it belongs to ${assignment.value.intent_id}, not to the Intent of its folder`,
          )
        else decoded.push({ path, value: assignment.value })
      }
      const siblings = new Set(decoded.flatMap(({ value }) => mapId("assignment", value.id) ?? []))
      for (const { path, value } of decoded) {
        if (value.status === "executing") {
          state.stops.push({
            source: "holycodex",
            path: shown(path),
            message: `${value.id} is executing; record its result (holycodex-agent assignment result) or, once its invocation is confirmed stopped, recover it (holycodex-agent assignment recover), then migrate again`,
          })
          continue
        }
        const roleTask = `${value.owner.role}.${value.owner.task}`
        if (!Schema.is(RoleTask)(roleTask)) {
          unconvertible(state, shown(path), `owner ${roleTask} is not a holyagent route`)
          continue
        }
        const result = yield* assignmentRecord(
          target,
          shown(path),
          holycodexAssignment(value, roleTask, intent.value.intent, siblings),
        )
        if ("problem" in result) unconvertible(state, shown(path), result.problem)
        else state.records.push(result.value)
      }
    }
    return state satisfies Gathered
  })

/**
 * Reads the legacy folders of a project (`.holyclaude/` and `.holycodex/` at the state root) and
 * converts what they hold into the records and files `.holyagent/` would get, without writing
 * anything. A source whose folder is absent or empty is left out of the result. Records that cannot
 * be converted and work that must be settled first are listed on each source, not failed on.
 */
export const gatherLegacy = (root: string, directory: string) =>
  Effect.gen(function* () {
    const found: Array<Gathered> = []
    const holyclaude = yield* gatherHolyclaude(root, directory)
    if (holyclaude !== undefined) found.push(holyclaude)
    const holycodex = yield* gatherHolycodex(root, directory)
    if (holycodex !== undefined) found.push(holycodex)
    return found
  })
