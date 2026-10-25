import { Schema } from "effect"

/** What a command did, as lines to print and whether every part succeeded. */
export interface Report {
  readonly lines: ReadonlyArray<string>
  readonly ok: boolean
}

/** A failure that stops a command; its message is printed to stderr and the exit code is 1. */
export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  message: Schema.String,
}) {}

/** Renders a JSON value on one line for report lines. */
export const show = (value: unknown): string => JSON.stringify(value) ?? String(value)
