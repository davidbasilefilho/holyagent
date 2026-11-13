import { basename } from "node:path"

import { Effect, Schema } from "effect"

import type { AcceptanceInput } from "../domain/acceptance.ts"
import type { Assignment } from "../domain/assignment.ts"
import { PI_WORKFLOW_AGENT_PREFIX } from "../domain/directive.ts"
import { InsufficientAcceptance, InvalidDraft } from "../domain/errors.ts"
import { type AgentHost, CLAUDE_WORDS, type HostWords, PI_WORDS } from "../domain/host.ts"
import { agentFor, isHeadlessScreenAgent, routeFor, type ScreenForm } from "../domain/route.ts"
import {
  decodePiJournal,
  type ExpectedCall,
  type InvalidPiRecord,
  journalKey,
  matchJournal,
  piRecordReport,
} from "../pi/journal.ts"
import { JsonReport, renderJsonReport } from "./jsonreport.ts"
type Launch = { readonly model?: string | undefined; readonly effort?: string | undefined }

const EVIDENCE_HEADING = /^\s*evidence:\s*$/i

const indentOf = (line: string) => line.length - line.trimStart().length

/** One line of the evidence block with its list marker stripped. */
interface EvidenceEntry {
  readonly text: string
  /** Whether the line is a list item (bullet, number or checkbox). */
  readonly list: boolean
  /** Whether a blank line comes before it. */
  readonly gap: boolean
}

/** The markers that open a list item: bullets, numbers and checkboxes, alone or stacked. */
const LIST_MARKER = /^(?:[-*+•]\s+|\d+[.)]\s+|\[[ xX]\]\s+)+/

/**
 * The entries of the report's last `evidence:` block, bullets stripped; none without the block. A
 * line indented deeper than the first entry continues the entry above it (the sub-bullets of a
 * support) unless a blank line comes between, so a support given on following lines still counts.
 */
const evidenceEntries = (report: string): ReadonlyArray<EvidenceEntry> => {
  const lines = report.split(/\r?\n/)
  const heading = lines.findLastIndex((line) => EVIDENCE_HEADING.test(line))
  if (heading === -1) return []
  const base = indentOf(lines.slice(heading + 1).find((line) => line.trim() !== "") ?? "")
  const entries: Array<EvidenceEntry> = []
  let gap = false
  for (const line of lines.slice(heading + 1)) {
    if (line.trim() === "") {
      gap = true
      continue
    }
    const trimmed = line.trim()
    const text = trimmed.replace(LIST_MARKER, "")
    const last = entries.length - 1
    const above = entries[last]
    if (indentOf(line) > base && above !== undefined && !gap)
      entries[last] = {
        ...above,
        text: `${above.text}${above.text.endsWith(":") ? " " : "; "}${text}`,
      }
    else entries.push({ text, list: LIST_MARKER.test(trimmed), gap })
    gap = false
  }
  return entries
}

const MARKER = /^\[(?:non-)?blocking\]\s*/i
const DIMENSION = /\s*\((?:behavior|regressions|tests|scope|style|repo-standards)\)$/i
const TRAILING = /[\s.,;:!?*_`]+$/
/** Emphasis marks and list markers (bullets, numbers, checkboxes, quotes) before a key. */
const LEADING = /^(?:[\s*_`>•+-]+|\d+[.)]\s+|\[[ xX]\](?=\s))+/

/**
 * A criterion or label as it is compared: case, spacing, hyphens and underscores (which read as
 * spaces: `agent-effort` is `Agent effort`), trailing punctuation, emphasis marks, a leading list
 * marker or `[blocking]` marker and a trailing `(dimension)` do not matter, so the prompt's own
 * form of a criterion (`[blocking] text (behavior)`) matches the bare text.
 */
const normalized = (text: string): string =>
  text
    .replace(LEADING, "")
    .replace(MARKER, "")
    .replace(/\s+/g, " ")
    .replace(TRAILING, "")
    .replace(DIMENSION, "")
    .replace(TRAILING, "")
    .replace(/[-_\s]+/g, " ")
    .toLowerCase()

/** The declared keys by their normalized text; one text may name several keys. */
type Known = ReadonlyMap<string, ReadonlySet<string>>

/** Whether a support says something: emphasis marks, backticks and punctuation alone do not. */
const HAS_TEXT = /[\p{L}\p{N}]/u

/**
 * The declared keys an entry belongs to and its support: the entry is `<key>: <support>`, where the
 * key matches declared criteria or labels after normalizing. A key may itself hold colons, so every
 * colon is tried and the longest head with a support wins ("Handles errors: network: ok" is the
 * support of "Handles errors: network", not of "Handles errors"). A key line whose support is empty
 * or only emphasis marks and punctuation (`**Key:**`) is returned with an empty support: it is a
 * key line all the same, and the lines that follow it may supply the support.
 */
const ownerOf = (
  entry: string,
  known: Known,
): { readonly keys: ReadonlySet<string>; readonly support: string } | undefined => {
  let bare: ReadonlySet<string> | undefined
  for (let at = entry.lastIndexOf(":"); at > 0; at = entry.lastIndexOf(":", at - 1)) {
    const keys = known.get(normalized(entry.slice(0, at)))
    if (keys === undefined) continue
    const support = entry.slice(at + 1).trim()
    if (HAS_TEXT.test(support)) return { keys, support }
    bare ??= keys
  }
  return bare === undefined ? undefined : { keys: bare, support: "" }
}

/** The label of a criterion: its text before the first colon, or all of it when it has none. */
const labelOf = (text: string): string => {
  const colon = text.indexOf(":")
  return colon > 0 ? text.slice(0, colon) : text
}

/**
 * Builds the acceptance of an Assignment from a report that ends with an `evidence:` block of
 * `<criterion or evidence label>: <support>` lines. A line belongs to a declared criterion or label
 * when its text before a colon matches it after normalizing (see {@link normalized}); a criterion
 * is matched by its full text or by its label (the text before its first colon), where a label that
 * two criteria share names none of them. A line supports every key its text names, so a criterion
 * label equal to an evidence label (or to another criterion's full text) is supported by one line.
 * A line for any other text belongs to nothing. A key line with nothing after its colon takes the
 * list items (bullets or numbers) and indented lines directly below it as its support, up to a
 * blank line, the next key line or any other unindented line. Every blocking criterion and every
 * evidence label needs support; the failure lists the ones that have none.
 */
export const acceptanceFrom = (
  assignment: Assignment,
  report: string,
  rationale: string,
  carryForward: boolean,
) => {
  const keys = [
    ...new Set([...assignment.criteria.map(({ text }) => text), ...assignment.evidence]),
  ]
  const known = new Map<string, Set<string>>()
  const name = (text: string, key: string) =>
    known.set(text, (known.get(text) ?? new Set<string>()).add(key))
  for (const key of keys) name(normalized(key), key)
  const labels = new Map<string, Set<string>>()
  for (const { text } of assignment.criteria) {
    const label = normalized(labelOf(text))
    if (label !== "") labels.set(label, (labels.get(label) ?? new Set<string>()).add(text))
  }
  for (const [label, texts] of labels)
    if (texts.size === 1) for (const text of texts) name(label, text)
  const supports = new Map<string, string>()
  const addSupport = (keys: ReadonlySet<string>, text: string) => {
    if (HAS_TEXT.test(text)) for (const key of keys) if (!supports.has(key)) supports.set(key, text)
  }
  // A key line with no support of its own takes the list items directly below it.
  let open: { readonly keys: ReadonlySet<string>; readonly lines: Array<string> } | undefined
  const close = () => {
    if (open !== undefined) addSupport(open.keys, open.lines.join("; "))
    open = undefined
  }
  for (const entry of evidenceEntries(report)) {
    const owner = ownerOf(entry.text, known)
    if (owner === undefined) {
      if (open !== undefined && entry.list && !entry.gap) open.lines.push(entry.text)
      else close()
      continue
    }
    close()
    open = owner.support === "" ? { keys: owner.keys, lines: [] } : undefined
    addSupport(owner.keys, owner.support)
  }
  close()
  const supportFor = (key: string): string | undefined => supports.get(key)
  const criteria = assignment.criteria.map((criterion) => ({
    criterion,
    support: supportFor(criterion.text),
  }))
  const evidence = assignment.evidence.map((label) => ({ label, support: supportFor(label) }))
  const missing = [
    ...criteria
      .filter(({ criterion, support }) => criterion.blocking && support === undefined)
      .map(({ criterion }) => `criterion "${criterion.text}"`),
    ...evidence
      .filter(({ support }) => support === undefined)
      .map(({ label }) => `evidence label "${label}"`),
  ]
  if (missing.length > 0)
    return Effect.fail(
      new InsufficientAcceptance({
        id: assignment.id,
        detail: `the report's evidence: block has no support for ${missing.join(", ")}`,
      }),
    )
  return Effect.succeed({
    rationale,
    criteria: criteria.flatMap(({ criterion, support }) =>
      support === undefined ? [] : [{ criterion: criterion.text, support }],
    ),
    evidence: evidence.flatMap(({ label, support }) =>
      support === undefined ? [] : [{ label, support }],
    ),
    ...(carryForward ? { carryForward: true } : {}),
  } satisfies AcceptanceInput)
}

const section = (heading: string, items: ReadonlyArray<string>): ReadonlyArray<string> =>
  items.length === 0 ? [] : [`${heading}:`, ...items.map((item) => `- ${item}`)]

const PROMPT_LINE = /^Role: \S+ \(\S+\)\. Assignment: (assignment-[a-z0-9]+(?:-[a-z0-9]+)*)\.$/

/**
 * The Assignment a specialist prompt came from, read from the first line {@link renderPrompt}
 * writes; undefined for any other text. Only that line counts, so a prompt that merely mentions an
 * Assignment is not taken for a dispatched one.
 */
export const dispatchedAssignment = (prompt: string): string | undefined =>
  PROMPT_LINE.exec(prompt.split("\n", 1)[0] ?? "")?.[1]

const SCREEN_LINE =
  "Screen capability: this Assignment carries it, and this machine has a graphical session: you have computer use, browser use (the mcp__browse__* tools) and, where T3 hosts the session, T3's preview tools. Report a tool that is missing instead of working around it."

/**
 * What a headless screen specialist is told (its agent name ends in `-headless-screen`): the
 * machine has no graphical session, so it drives a headless browser (the browser-use MCP tools, or
 * T3's preview tools where T3 hosts the session, which HolyAgent starts no browser-use for) and has
 * no desktop.
 */
export const HEADLESS_SCREEN_LINE =
  "Screen capability: this Assignment carries it, and this machine is headless: you have a headless browser (outside T3 the mcp__browser_use__browser_exec and mcp__browser_use__browser_screenshot tools, a temporary profile; where T3 hosts the session, T3's preview tools, and browser-use is not available) and no desktop, so computer use and the user's real browser are not available. Report a tool that is missing instead of working around it."

/**
 * The Assignment as the specialist reads it, in a fixed order: the role line (the marker
 * {@link dispatchedAssignment} reads back), objective, scope, constraints, ownership paths, the
 * screen capability when it carries one, acceptance criteria, required evidence and the closing
 * line that asks for the `evidence:` block {@link acceptanceFrom} reads. It is the text of the brief
 * file, which the root never reads or re-emits: it sends {@link dispatchPrompt}.
 */
export const renderPrompt = (assignment: Assignment, agent: string): string =>
  [
    `Role: ${assignment.roleTask} (${agent}). Assignment: ${assignment.id}.`,
    `Objective: ${assignment.objective}`,
    ...section("Scope", assignment.scope),
    ...section("Constraints", assignment.constraints),
    ...section("Ownership paths (write only here)", assignment.ownershipPaths),
    ...(assignment.screen === true
      ? [isHeadlessScreenAgent(agent) ? HEADLESS_SCREEN_LINE : SCREEN_LINE]
      : []),
    ...section(
      "Acceptance criteria",
      assignment.criteria.map(
        ({ text, blocking, dimension }) =>
          `[${blocking ? "blocking" : "non-blocking"}] ${text} (${dimension})`,
      ),
    ),
    ...section("Required evidence", assignment.evidence),
    "End your report with an `evidence:` line followed by one `<criterion or evidence label>: <support>` line for each blocking criterion and each required evidence label above. A criterion may be named by its text before the first colon.",
  ].join("\n")

/**
 * The prompt the root sends in place of the brief: the role line of {@link renderPrompt}, so the
 * launch hook still reads the Assignment from it, and the path of the brief file, which the
 * specialist reads with the read tool of the host (`words`, Claude's by default) and follows as its
 * whole task.
 */
export const dispatchPrompt = (
  assignment: Assignment,
  agent: string,
  briefPath: string,
  words: HostWords = CLAUDE_WORDS,
): string =>
  [
    `Role: ${assignment.roleTask} (${agent}). Assignment: ${assignment.id}.`,
    `Read the brief at ${briefPath} with the ${words.readTool} tool and follow it as your full task.`,
  ].join("\n")

/** Builds the specialist brief from shared prompt semantics and a host-provided first pass. */
export const briefText = (
  assignment: Assignment,
  agent: string,
  host: AgentHost,
  firstPass?: string,
): string => {
  const resources = assignment.operationalResources?.map(({ target }) => `- ${target}`).join("\n")
  const body = `${renderPrompt(assignment, agent)}${resources ? `\nOperational resources (write only here):\n${resources}` : ""}`
  return host === "pi" && firstPass !== undefined
    ? `${firstPass}\n\n## Assignment\n\n${body}`
    : body
}

const Started = Schema.Struct({
  type: Schema.Literal("started"),
  key: Schema.String,
  agentId: Schema.String,
  label: Schema.String,
})
const Resulted = Schema.Struct({
  type: Schema.Literal("result"),
  key: Schema.String,
  agentId: Schema.String,
  result: Schema.Unknown,
})
/** Any other entry of the journal (progress, errors): read for its type only and ignored. */
const Other = Schema.Struct({
  type: Schema.String.check(Schema.isPattern(/^(?!(?:started|result)$)/)),
})
const JournalLine = Schema.fromJsonString(Schema.Union([Started, Resulted, Other]))

/** The result of one agent of a Workflow run, with the label its script gave the agent. */
export interface JournalResult {
  /** The label of the agent; undefined when no `started` entry carries its key. */
  readonly label: string | undefined
  readonly agentId: string
  /** The result as text: a report passed on as it is, a JSON report rendered as one. */
  readonly report: string
}

/**
 * The results of a Workflow run's journal (JSON lines of `started` entries with a `label` and
 * `result` entries, joined by `key`), in the order they finished. Entries beyond the fields read
 * here, and entries of any other type, are ignored: the journal belongs to the host. A line that is
 * not JSON, or a `started` or `result` entry without its fields, refuses the whole journal, so no
 * report is lost to a partial read.
 */
export const journalResults = (journal: string, source: string) =>
  Effect.gen(function* () {
    const labels = new Map<string, string>()
    const results: Array<JournalResult> = []
    const lines = journal.split(/\r?\n/)
    for (const [index, line] of lines.entries()) {
      if (line.trim() === "") continue
      const entry = yield* Schema.decodeUnknownEffect(JournalLine)(line, {
        // The host adds fields of its own to each entry.
        onExcessProperty: "ignore",
      }).pipe(
        Effect.mapError(
          (error) =>
            new InvalidDraft({
              message: `Line ${index + 1} of the journal ${source} is not a started or result entry: ${error.message}`,
            }),
        ),
      )
      if ("label" in entry) labels.set(entry.key, entry.label)
      // A null result is no result, and neither is an empty one: the agent returned nothing to write.
      else if ("result" in entry && entry.result !== null) {
        const json = yield* Schema.decodeUnknownEffect(JsonReport)(entry.result).pipe(Effect.option)
        const report =
          typeof entry.result === "string"
            ? entry.result
            : json._tag === "Some"
              ? renderJsonReport(json.value)
              : (JSON.stringify(entry.result, null, 2) ?? "")
        if (report.trim() !== "")
          results.push({ label: labels.get(entry.key), agentId: entry.agentId, report })
      }
    }
    return results
  })

/**
 * The key an Assignment's dispatched call has in a `@tintinweb/pi-subagents` workflow journal: the
 * prompt that {@link dispatchPrompt} prints for the pi host (`agent` is the namespaced agent it
 * names, `briefPath` the brief file it points at), the Assignment id as the label, the route's
 * agent (the Claude slug without its namespace, which the Pi package ships under that name, and
 * with `-screen` (`-headless-screen` on a `headless` machine) for an Assignment that carries the
 * screen capability), and the model and effort as the dispatch printed them (`launch`, see
 * `launchesOf`). The script passes no isolation, gate, resume or schema.
 */
export const dispatchedCall = (
  assignment: Assignment,
  agent: string,
  briefPath: string,
  launch: Launch,
  form: ScreenForm = "normal",
): ExpectedCall => ({
  id: assignment.id,
  key: journalKey({
    prompt: dispatchPrompt(assignment, agent, briefPath, PI_WORDS),
    label: assignment.id,
    model: launch.model,
    agentType: agentFor(routeFor(assignment.roleTask), assignment.screen, form),
    effort: launch.effort,
  }),
})

/**
 * The reports a pi source yields and the entries or agents that yield none, as `reports` lists
 * them.
 */
export interface PiReports {
  /** The report of each Assignment, to write to its report file. */
  readonly reports: ReadonlyArray<{ readonly id: string; readonly report: string }>
  /**
   * What yields no report, in the rows of the Claude listing: the label is the Assignment id, or
   * empty when the entry matches none, and the agent says which entry or agent and why.
   */
  readonly notAssignmentIds: ReadonlyArray<{ readonly label: string; readonly agentId: string }>
}

const refused = (_hint: string) => (error: InvalidPiRecord) =>
  new InvalidDraft({ message: error.message })

/**
 * The reports of a `<run id>.workflow.jsonl` of `@tintinweb/pi-subagents`: each entry whose key is
 * that of a dispatched call in `calls` (see {@link dispatchedCall}) gives the report of its
 * Assignment. An entry that failed, has no text or matches no call is listed as `<run id>#<index>
 * failed|empty|unmatched`, since the journal carries no label to say more.
 */
export const piJournalReports = (
  journal: string,
  source: string,
  calls: ReadonlyArray<ExpectedCall>,
) =>
  decodePiJournal(journal, source).pipe(
    Effect.mapError(refused("Pass the <run id>.workflow.jsonl of the workflow run, unedited.")),
    Effect.map((entries): PiReports => {
      const { reports, notReported } = matchJournal(entries, calls)
      const run = basename(source).replace(/\.workflow\.jsonl$/, "")
      return {
        reports: reports.map(({ id, report }) => ({ id, report })),
        notAssignmentIds: notReported.map(({ id, index, reason }) => ({
          label: id ?? "",
          agentId: `${run}#${index} ${reason}`,
        })),
      }
    }),
  )

/**
 * The reports of direct agents, read from the root session file: each `pi:<agent-id>` of `agents`
 * (an Assignment id and the agent id recorded for it) whose `subagents:record` entry ended `ok`
 * gives the report of its Assignment. An agent with no record, or one that did not end `ok`, is
 * listed as `<agent id> missing|<outcome>`. A `pi-workflow:<run-id>/<id>` agent has no record in
 * the session file (its report is in the `<run id>.workflow.jsonl`), so it is listed as `<agent id>
 * not in a session file` rather than dropped.
 */
export const piRecordReports = (
  session: string,
  source: string,
  agents: ReadonlyArray<{ readonly id: string; readonly agentId: string }>,
) =>
  Effect.gen(function* () {
    const reports: Array<{ readonly id: string; readonly report: string }> = []
    const notAssignmentIds: Array<{ readonly label: string; readonly agentId: string }> = []
    for (const { id, agentId } of agents) {
      if (agentId.startsWith(PI_WORKFLOW_AGENT_PREFIX)) {
        notAssignmentIds.push({ label: id, agentId: `${agentId} not in a session file` })
        continue
      }
      const found = yield* piRecordReport(session, source, agentId.replace(/^pi:/, "")).pipe(
        Effect.catchTag("PiRecordMissing", () => Effect.succeed(undefined)),
      )
      if (found?.report !== undefined) reports.push({ id, report: found.report })
      else notAssignmentIds.push({ label: id, agentId: `${agentId} ${found?.ended ?? "missing"}` })
    }
    return { reports, notAssignmentIds } satisfies PiReports
  }).pipe(Effect.mapError(refused("Pass the root session file of the Pi session, unedited.")))
