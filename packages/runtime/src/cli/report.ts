import { Effect } from "effect"

import type { AcceptanceInput } from "../domain/acceptance.ts"
import type { Assignment } from "../domain/assignment.ts"
import { InsufficientAcceptance } from "../domain/errors.ts"

/** The line that opens the block a specialist ends its report with. */
const EVIDENCE_HEADING = /^\s*evidence:\s*$/i

const indentOf = (line: string) => line.length - line.trimStart().length

/**
 * The entries of the report's last `evidence:` block, bullets stripped; none without the block. A
 * line indented deeper than the first entry continues the entry above it (the sub-bullets of a
 * support), so a support given on following lines still counts.
 */
const evidenceEntries = (report: string): ReadonlyArray<string> => {
  const lines = report.split(/\r?\n/)
  const heading = lines.findLastIndex((line) => EVIDENCE_HEADING.test(line))
  if (heading === -1) return []
  const block = lines.slice(heading + 1).filter((line) => line.trim() !== "")
  const base = block[0] === undefined ? 0 : indentOf(block[0])
  const entries: Array<string> = []
  for (const line of block) {
    const text = line.trim().replace(/^[-*]\s+/, "")
    const last = entries.length - 1
    if (indentOf(line) > base && last >= 0)
      entries[last] = `${entries[last] ?? ""}${entries[last]?.endsWith(":") ? " " : "; "}${text}`
    else entries.push(text)
  }
  return entries
}

const MARKER = /^\[(?:non-)?blocking\]\s*/i
const DIMENSION = /\s*\((?:behavior|regressions|tests|scope|style|repo-standards)\)$/i
const TRAILING = /[\s.,;:!?*_`]+$/
const LEADING = /^[\s*_`]+/

/**
 * A criterion or label as it is compared: case, spacing, trailing punctuation, emphasis marks, a
 * leading `[blocking]` marker and a trailing `(dimension)` do not matter, so the prompt's own form
 * of a criterion (`[blocking] text (behavior)`) matches the bare text.
 */
const normalized = (text: string): string =>
  text
    .replace(LEADING, "")
    .replace(MARKER, "")
    .replace(/\s+/g, " ")
    .replace(TRAILING, "")
    .replace(DIMENSION, "")
    .replace(TRAILING, "")
    .toLowerCase()

/**
 * The declared key an entry belongs to and its support: the entry is `<key>: <support>`, where the
 * key matches a declared criterion or label after normalizing. A key may itself hold colons, so
 * every colon is tried and the longest matching head wins ("Handles errors: network: ok" is the
 * support of "Handles errors: network", not of "Handles errors"). An entry that is only a key, or
 * whose support is only emphasis marks and punctuation, has no support and claims nothing.
 */
const ownerOf = (
  entry: string,
  known: ReadonlyMap<string, string>,
): { readonly key: string; readonly support: string } | undefined => {
  for (let at = entry.lastIndexOf(":"); at > 0; at = entry.lastIndexOf(":", at - 1)) {
    const key = known.get(normalized(entry.slice(0, at)))
    const support = entry.slice(at + 1).trim()
    // Emphasis marks, backticks and punctuation alone (`**Key:**`) are no support.
    if (key !== undefined && /[\p{L}\p{N}]/u.test(support)) return { key, support }
  }
  return undefined
}

/** The label of a criterion: its text before the first colon, or all of it when it has none. */
const labelOf = (text: string): string => {
  const colon = text.indexOf(":")
  return colon > 0 ? text.slice(0, colon) : text
}

/**
 * Builds the acceptance of an Assignment from a report that ends with an `evidence:` block of
 * `<criterion or evidence label>: <support>` lines. A line belongs to a declared criterion or label
 * when its text before a colon matches it after normalizing case, spacing and trailing punctuation
 * (a leading `[blocking]` and a trailing `(dimension)` are ignored too); a criterion is matched by
 * its full text or by its label (the text before its first colon), where a label that two criteria
 * share, or that is another key in full, names none of them. A line for any other text belongs to
 * nothing. Every blocking criterion and every evidence label needs a line with support; the failure
 * lists the ones that have none.
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
  const known = new Map<string, string>()
  for (const key of keys) if (!known.has(normalized(key))) known.set(normalized(key), key)
  const labels = new Map<string, string | undefined>()
  for (const { text } of assignment.criteria) {
    const label = normalized(labelOf(text))
    if (label !== "" && !known.has(label))
      labels.set(label, labels.has(label) && labels.get(label) !== text ? undefined : text)
  }
  for (const [label, key] of labels) if (key !== undefined) known.set(label, key)
  const supports = new Map<string, string>()
  for (const entry of evidenceEntries(report)) {
    const owner = ownerOf(entry, known)
    if (owner !== undefined && !supports.has(owner.key)) supports.set(owner.key, owner.support)
  }
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

/**
 * The Assignment as the specialist reads it, in a fixed order: the role line (the marker
 * {@link dispatchedAssignment} reads back), objective, scope, constraints, ownership paths,
 * acceptance criteria, required evidence and the closing line that asks for the `evidence:` block
 * {@link acceptanceFrom} reads. It is the text of the brief file, which the root never reads or
 * re-emits: it sends {@link dispatchPrompt}.
 */
export const renderPrompt = (assignment: Assignment, agent: string): string =>
  [
    `Role: ${assignment.roleTask} (${agent}). Assignment: ${assignment.id}.`,
    `Objective: ${assignment.objective}`,
    ...section("Scope", assignment.scope),
    ...section("Constraints", assignment.constraints),
    ...section("Ownership paths (write only here)", assignment.ownershipPaths),
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
 * specialist reads with its Read tool and follows as its whole task.
 */
export const dispatchPrompt = (assignment: Assignment, agent: string, briefPath: string): string =>
  [
    `Role: ${assignment.roleTask} (${agent}). Assignment: ${assignment.id}.`,
    `Your full task is the brief in ${briefPath}: read it with the Read tool and follow it as your full task.`,
  ].join("\n")
