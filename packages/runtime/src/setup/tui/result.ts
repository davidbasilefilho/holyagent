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

/** Routine report lines that predate separate information and next-step markers. */
export const setupNotice = (line: string): "status" | "next" | "warning" | undefined => {
  if (/^= (?:pi package|Pi model providers|Codex plugin): /i.test(line)) return "status"
  if (!line.startsWith("~ ")) return undefined
  const detail = line.slice(2)
  if (/^(?:scope|form|setup harness|Codex home|Startup): /i.test(detail)) return "status"
  if (
    /^(?:Start Codex with this CODEX_HOME\b|If you meant native Codex\b|Restart (?:T3 Code|Pi|Codex)\b|OpenCode Browse: close this screen to )/i.test(
      detail,
    )
  )
    return "next"
  return "warning"
}

/** Condenses a report for display. The underlying lines remain available as run details. */
export const summarizeResult = (result: Applied, dryRun: boolean): ReadonlyArray<ResultSection> => {
  const changes = [
    ...subjects(result.lines, "+ "),
    ...subjects(
      result.lines.filter((line) =>
        /: (?:removed|would remove|turned off|would turn off)\b/.test(line),
      ),
      "- ",
    ),
  ]
  const linesOf = (kind: ReturnType<typeof setupNotice>) =>
    result.lines.filter((line) => setupNotice(line) === kind)
  const status = linesOf("status").map((line) => line.slice(2))
  const failures = subjects(result.lines, "! ")
  const warnings = subjects(linesOf("warning"), "~ ")
  const next = linesOf("next").map((line) => line.slice(2))
  if (!result.ok) next.push("Check the failures in the full report before running setup again.")
  else if (warnings.length > 0) next.push("Check the warnings in the full report.")
  return [
    {
      title: dryRun ? "Planned changes" : "Changes",
      lines: changes.length === 0 ? ["No changes."] : changes,
    },
    ...(status.length > 0 ? [{ title: "Status", lines: status }] : []),
    ...(failures.length > 0 ? [{ title: "Failures", lines: failures }] : []),
    ...(warnings.length > 0 ? [{ title: "Warnings", lines: warnings }] : []),
    ...(next.length > 0 ? [{ title: "Next steps", lines: next }] : []),
  ]
}
