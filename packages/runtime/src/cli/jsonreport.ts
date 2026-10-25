import { Schema } from "effect"

import { oneLine } from "./views.ts"

const REPORT_FIELDS = Schema.Struct({
  status: Schema.Literals(["done", "partial", "blocked"]),
  changed_paths: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.Struct({ command: Schema.String, exit: Schema.Int })),
  blockers: Schema.Array(Schema.String),
  notes: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.Struct({ key: Schema.String, support: Schema.String })),
})

/**
 * The report a specialist returns inside a workflow, as its script's schema asks for it. The
 * evidence entries carry what a plain report puts in its closing `evidence:` block. A field beyond
 * these (a specialist may add one, such as `status_note`) is kept and stored with the report, so a
 * report passed on verbatim can always be closed.
 */
export const JsonReport = Schema.StructWithRest(REPORT_FIELDS, [
  Schema.Record(Schema.String, Schema.Unknown),
])
/** One JSON report. */
export type JsonReport = typeof JsonReport.Type

const section = (heading: string, lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.length === 0 ? [] : [`${heading}:`, ...lines.map((line) => `- ${oneLine(line)}`)]

const KNOWN: ReadonlySet<string> = new Set(Object.keys(REPORT_FIELDS.fields))

/** The fields of a report beyond the known ones, as `name: value` lines in field order. */
const extraLines = (report: JsonReport): ReadonlyArray<string> =>
  Object.entries(report)
    .filter(([name]) => !KNOWN.has(name))
    .map(
      ([name, value]) =>
        `${name}: ${oneLine(typeof value === "string" ? value : (JSON.stringify(value) ?? ""))}`,
    )

/**
 * Renders a JSON report as the text of a plain one: a status line, the changed paths, checks,
 * blockers and notes, any further fields as `name: value` lines, then the `evidence:` block last,
 * one `<key>: <support>` line per entry, which is where `close --accept` reads it.
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
    ...extraLines(report),
    ...section(
      "evidence",
      report.evidence.map(({ key, support }) => `${oneLine(key)}: ${support}`),
    ),
  ].join("\n")
