import type { ShellResult } from "./shell.ts"

/** What a setup or doctor run did, as lines to print and whether every part succeeded. */
export interface Report {
  readonly lines: ReadonlyArray<string>
  readonly ok: boolean
}

/** A report line for something that was added or would be. */
export const added = (text: string) => `+ ${text}`
/** A report line for something already in place. */
export const present = (text: string) => `= ${text}`
/** A report line for a step that was left out, with the reason. */
export const skipped = (text: string) => `- ${text}`
/** A report line that asks the user to do something. */
export const hint = (text: string) => `~ ${text}`

/** A report line for a command that failed, with the first line of its output. */
export const failed = (what: string, result: ShellResult) => {
  const detail = (result.stderr || result.stdout).trim().split("\n")[0] ?? ""
  return `! ${what}: failed (exit ${result.exitCode})${detail === "" ? "" : `: ${detail}`}`
}

/** Renders a JSON value on one line for report lines. */
export const show = (value: unknown): string => JSON.stringify(value) ?? String(value)
