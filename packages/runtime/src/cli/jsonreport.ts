import { Schema } from "effect"

import { oneLine } from "./views.ts"

/**
 * The report a specialist returns inside a workflow, as its script's schema asks for it. The
 * evidence entries carry what a plain report puts in its closing `evidence:` block.
 */
export const JsonReport = Schema.Struct({
  status: Schema.Literals(["done", "partial", "blocked"]),
  changed_paths: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.Struct({ command: Schema.String, exit: Schema.Int })),
  blockers: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.Struct({ key: Schema.String, support: Schema.String })),
})
/** One JSON report. */
export type JsonReport = typeof JsonReport.Type

const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length === 0 ? [] : [`${heading}:`, ...lines.map((line) => `- ${oneLine(line)}`)]

/**
 * Renders a JSON report as the text of a plain one: a status line, the changed paths, checks,
 * blockers and notes, then the `evidence:` block last, one `<key>: <support>` line per entry, which
 * is where `close --accept` reads it.
 */
export const renderJsonReport = (report: JsonReport): string =>
  [
    `status: ${report.status}`,
    ...section("changed", report.changed_paths),
    ...section(
      "checks",
      report.checks.map(({ command, exit }) => `${command} -> exit ${exit}`),
    ),
    ...section("blockers", report.blockers),
    ...section("notes", report.notes),
    ...section(
      "evidence",
      report.evidence.map(({ key, support }) => `${oneLine(key)}: ${support}`),
    ),
  ].join("\n")
