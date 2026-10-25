import { Effect } from "effect"

import type { AcceptanceInput } from "../domain/acceptance.ts"
import type { Assignment } from "../domain/assignment.ts"
import { InsufficientAcceptance } from "../domain/errors.ts"

/** The line that opens the block a specialist ends its report with. */
const EVIDENCE_HEADING = /^\s*evidence:\s*$/i

/** The lines of the report's last `evidence:` block, bullets stripped; none without the block. */
const evidenceLines = (report: string): ReadonlyArray<string> => {
  const lines = report.split(/\r?\n/)
  const heading = lines.findLastIndex((line) => EVIDENCE_HEADING.test(line))
  return heading === -1
    ? []
    : lines
        .slice(heading + 1)
        .map((line) => line.trim().replace(/^[-*]\s+/, ""))
        .filter((line) => line !== "")
}

/**
 * Builds the acceptance of an Assignment from a report that ends with an `evidence:` block of
 * `<criterion or evidence label>: <support>` lines. A line belongs to a declared criterion or label
 * when it starts with that text and a colon, ignoring case. Every blocking criterion and every
 * evidence label needs a line with support; the failure lists the ones that have none.
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
  // A line belongs to the longest declared key that prefixes it, so "Handles errors: network: ok"
  // is the support of that key and not of "Handles errors".
  const supports = new Map<string, string>()
  for (const line of evidenceLines(report)) {
    const lower = line.toLowerCase()
    const owner = keys
      .filter((key) => lower === key.toLowerCase() || lower.startsWith(`${key.toLowerCase()}:`))
      .toSorted((a, b) => b.length - a.length)[0]
    // A line that is exactly a key has no support and still claims the key.
    const support = owner === undefined ? "" : line.slice(owner.length + 1).trim()
    if (owner !== undefined && support !== "" && !supports.has(owner)) supports.set(owner, support)
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
 * The Assignment as the specialist reads it, in a fixed order, so the root sends it as it is: the
 * role line (the marker {@link dispatchedAssignment} reads back), objective, scope, constraints,
 * ownership paths, acceptance criteria, required evidence and the closing line that asks for the
 * `evidence:` block {@link acceptanceFrom} reads.
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
    "End your report with an `evidence:` line followed by one `<criterion or evidence label>: <support>` line for each blocking criterion and each required evidence label above.",
  ].join("\n")
