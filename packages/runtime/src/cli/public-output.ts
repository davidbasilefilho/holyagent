import { Effect } from "effect"

import { loadPackagedTerminalOutput } from "../setup/tui/load.ts"
import { setupResultLines } from "../setup/tui/result-file.ts"
import { setupNotice } from "../setup/tui/result.ts"
import { tuiFallbackReason } from "../setup/tui/session.ts"
import { colorEnabled, type Tone } from "../setup/tui/theme.ts"
import type { TerminalOutputLine } from "../setup/tui/types.ts"
import type { OutputPresentation } from "./entry.ts"
import type { Host } from "./types.ts"

const plainPublicOutput = (argv: ReadonlyArray<string>): boolean => {
  const delimiter = argv.indexOf("--")
  return argv.slice(0, delimiter === -1 ? argv.length : delimiter).some((arg) => {
    const [flag] = arg.split("=", 1)
    return flag === "--no-tui" || flag === "--non-interactive"
  })
}

const toneOf = (text: string, kind: "stdout" | "stderr" | "progress", index: number): Tone => {
  if (kind === "stderr") return index === 0 ? "error" : "hint"
  if (kind === "progress") return "option"
  if (/^(?:! |fail\b|error:)/i.test(text)) return "error"
  const notice = setupNotice(text)
  if (notice === "status") return "hint"
  if (notice === "next") return "option"
  if (notice === "warning" || /^warn(?:ing)?\b/i.test(text)) return "warning"
  if (/^(?:\+ |ok\s|Installed HolyAgent\b)/.test(text)) return "success"
  if (/^(?:[-=] |note: |stdout: )/.test(text)) return "hint"
  return index === 0 ? "heading" : "argument"
}

/** Presents public TTY output, preserving the plain stream in scripted use or on load failure. */
export const publicOutput = (
  argv: ReadonlyArray<string>,
  env: Host["env"],
  terminal: Host["terminal"],
): OutputPresentation => {
  const enabled =
    tuiFallbackReason({
      env,
      terminal,
      noTui: plainPublicOutput(argv),
      choiceFlag: false,
    }) === undefined && colorEnabled(env, true)
  return (text, kind, targetIsTty, summary) => {
    if (!enabled || !targetIsTty || text === "") return Effect.succeed(text)
    const lines: ReadonlyArray<TerminalOutputLine> =
      summary === undefined
        ? text.split("\n").map((line, index) => ({ text: line, tone: toneOf(line, kind, index) }))
        : [...setupResultLines(summary), { text: "", tone: "argument" }]
    return loadPackagedTerminalOutput().pipe(
      Effect.flatMap((render) => Effect.try(() => render({ env, lines }))),
      Effect.orElseSucceed(() => text),
    )
  }
}
