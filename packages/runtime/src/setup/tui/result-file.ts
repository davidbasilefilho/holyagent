import { lstat, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { Effect } from "effect"

import { userConfigFile } from "../../config/load.ts"
import { resultHeadline, type ResultSection, summarizeResult } from "./result.ts"
import { plain } from "./text.ts"
import type { Tone } from "./theme.ts"
import type { Applied, TerminalOutputLine } from "./types.ts"

/** Carries report metadata so the CLI emits only its own terminal controls. */
export class SetupResult {
  constructor(
    readonly title: string,
    readonly sections: ReadonlyArray<ResultSection>,
    readonly code: number,
    readonly reportFile?: string,
    readonly failure?: string,
  ) {}
}

/** Saves the exact run's full report after the terminal is restored. */
export const saveSetupResult = Effect.fn("saveSetupResult")(function* (
  report: Applied,
  dryRun: boolean,
  env: Readonly<Record<string, string | undefined>>,
) {
  const directory = resolve(dirname(userConfigFile(env)), "setup-reports")
  const title = resultHeadline(report.ok, dryRun)
  const sections = summarizeResult(report, dryRun)
  const code = report.ok ? 0 : 1
  if (dryRun) return new SetupResult(title, sections, code)
  return yield* Effect.tryPromise({
    try: () =>
      mkdir(directory, { mode: 0o700, recursive: true })
        .then(() => lstat(directory))
        .then((metadata) => {
          if (!metadata.isDirectory()) throw new Error("report folder is not a directory")
          return mkdtemp(join(directory, "run-"))
        })
        .then((run) => {
          const file = join(run, "report.txt")
          const contents = [title, "", ...report.lines.map(plain), ""].join("\n")
          return writeFile(file, contents, { flag: "wx", mode: 0o600 }).then(() => file)
        }),
    catch: (cause) => (cause instanceof Error ? cause.message : String(cause)),
  }).pipe(
    Effect.match({
      onFailure: (failure) => new SetupResult(title, sections, code, undefined, failure),
      onSuccess: (file) => new SetupResult(title, sections, code, file),
    }),
  )
})

/** Shared presentation of the final setup outcome, including its durable report. */
export const setupResultLines = (result: SetupResult): ReadonlyArray<TerminalOutputLine> => [
  { text: plain(result.title), tone: result.code === 0 ? "success" : "error" },
  ...result.sections.flatMap(({ title, lines }) => {
    const heading: Tone =
      title === "Warnings" ? "warning" : title === "Failures" ? "error" : "heading"
    const detail: Tone =
      heading === "heading" ? (title === "Next steps" ? "option" : "argument") : heading
    return [
      { text: plain(title), tone: heading },
      ...lines.map((line) => ({
        text: "  " + plain(line),
        tone: detail,
      })),
    ]
  }),
  ...(result.reportFile === undefined
    ? []
    : [
        {
          text: "Full report: " + plain(result.reportFile),
          tone: "option" as const,
          reportFile: result.reportFile,
        },
      ]),
  ...(result.failure === undefined
    ? []
    : [
        {
          text: "Could not save the full report: " + plain(result.failure),
          tone: "warning" as const,
        },
      ]),
]

/** The final result's plain form, for pipes and when terminal styling is unavailable. */
export const renderSetupResult = (result: SetupResult): string =>
  setupResultLines(result)
    .map(({ text }) => text)
    .join("\n") + "\n"
