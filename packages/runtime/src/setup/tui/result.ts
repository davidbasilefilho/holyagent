import type { Applied } from "./types.ts"

/** One heading and its entries in the compact result. */
export interface ResultSection {
  readonly title: string
  readonly lines: ReadonlyArray<string>
}

const subjects = (lines: ReadonlyArray<string>, mark: string) => {
  const counts = new Map<string, number>()
  for (const line of lines) {
    if (!line.startsWith(mark)) continue
    const [label = ""] = line.slice(mark.length).split(": ", 1)
    const [subject = ""] = label.split(/ (?:\/|[a-z]:[\\/]|\\\\)/i, 1)
    if (subject === "") continue
    counts.set(subject, (counts.get(subject) ?? 0) + 1)
  }
  return [...counts].map(([item, count]) => (count > 1 ? `${item} (${count})` : item))
}

/** The outcome shown both before and after the terminal screen closes. */
export const resultHeadline = (ok: boolean, dryRun: boolean): string => {
  if (dryRun) return ok ? "Dry run finished; nothing was written." : "Dry run found failures."
  return ok ? "Setup finished." : "Setup finished with failures."
}

/** Condenses a report for display. The underlying lines remain available as run details. */
export const summarizeResult = (result: Applied, dryRun: boolean): ReadonlyArray<ResultSection> => {
  const scope = /^~ (?:scope|form): /
  const changes = [
    ...subjects(result.lines, "+ "),
    ...subjects(
      result.lines.filter((line) =>
        /: (?:removed|would remove|turned off|would turn off)\b/.test(line),
      ),
      "- ",
    ),
  ]
  const warnings = [
    ...subjects(result.lines, "! "),
    ...subjects(
      result.lines.filter((line) => !scope.test(line)),
      "~ ",
    ),
  ]
  return [
    {
      title: dryRun ? "Planned changes" : "Changes",
      lines: changes.length === 0 ? ["No changes."] : changes,
    },
    ...(warnings.length > 0 ? [{ title: "Warnings", lines: warnings }] : []),
    ...(warnings.length > 0 || !result.ok
      ? [
          {
            title: "Next steps",
            lines: [
              result.ok
                ? "Check the warnings in the full report."
                : "Check the failures in the full report before running setup again.",
            ],
          },
        ]
      : []),
  ]
}
