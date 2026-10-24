import { Data } from "effect"

import { VCS_HINTS, VCS_REFUSED_ERRORS } from "../vcs/errors.ts"

/** The command line does not match the command's usage. */
export class Usage extends Data.TaggedError("Usage")<{
  readonly message: string
  readonly hint: string
}> {}

/** A command that reads JSON from stdin found a terminal or nothing. */
export class StdinMissing extends Data.TaggedError("StdinMissing")<{
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `This command reads JSON from stdin: ${this.reason}`
  }
}

/** A command needs an Intent and none is open, or several are open and none is in use. */
export class NoActiveIntent extends Data.TaggedError("NoActiveIntent")<{
  readonly open: ReadonlyArray<{ readonly id: string; readonly objective: string }>
}> {
  /** The description shown to the user. */
  override get message() {
    return this.open.length === 0
      ? "No Intent is open"
      : `${this.open.length} Intents are open and none is in use: ${this.open
          .map((intent) => `${intent.id} (${intent.objective})`)
          .join("; ")}`
  }
}

/** The exit codes of a failed command. */
export const EXIT = { usage: 2, refused: 3, state: 4 } as const

const USAGE_ERRORS = new Set([
  "Usage",
  "StdinMissing",
  "NoActiveIntent",
  "InvalidDraft",
  "InvalidPath",
  "MissingOwnership",
  "UnknownRecord",
])

const REFUSED_ERRORS = new Set([
  "DuplicateRecord",
  "StaleRevision",
  "IntentClosed",
  "IntentHasOpenWork",
  "InvalidTransition",
  "OwnershipConflict",
  "DependencyNotAccepted",
  "InsufficientAcceptance",
  "SpecialistMismatch",
  "SpecialistNotRecorded",
  ...VCS_REFUSED_ERRORS,
])

const HINTS: Readonly<Record<string, string>> = {
  StdinMissing: "Pipe the JSON in, for example: echo '{...}' | holyagent <command>; see --help.",
  NoActiveIntent:
    "Pick one with `holyagent intent use <id>`, or start one with `holyagent intent create`.",
  InvalidDraft:
    "Send JSON in the shape `holyagent <command> --help` shows; unknown fields are refused.",
  InvalidPath: "Use relative portable paths such as packages/runtime/src.",
  MissingOwnership: "Give a writing role task at least one ownershipPaths entry.",
  UnknownRecord: "List ids with `holyagent intent list` or `holyagent assignment list --all`.",
  DuplicateRecord: "Retry the command; ids are generated.",
  StaleRevision:
    "Reread with `holyagent intent show`, reassess the work at the live revision, then retry.",
  IntentClosed: "Reopen it with `holyagent intent reopen <id>`, or use an open Intent.",
  IntentHasOpenWork:
    "Settle those Assignments, or close again with `--drop <reason>` to cancel the Ready and Running ones.",
  InvalidTransition:
    "Check the state with `holyagent assignment show <id>` and use the command that fits it.",
  OwnershipConflict: "Wait for the Running writer to close, or narrow the ownership paths.",
  DependencyNotAccepted:
    "Close and accept the dependency first (`holyagent assignment accept <id>`), then dispatch.",
  InsufficientAcceptance:
    "Support every blocking criterion and every evidence label the Assignment declares.",
  SpecialistMismatch: "Record the agent that was actually launched, or dispatch again.",
  SpecialistNotRecorded:
    "Run `holyagent assignment record <id> --agent <agentId>` first, or close with another outcome.",
  StateLocked: "Another process holds the state lock; retry in a moment.",
  StateIo: "Check the permissions of the .holyagent folder in the project root.",
  CorruptRecord: "Fix or delete the file the message names, or restore it from version control.",
  ...VCS_HINTS,
}

/** What the caller prints for a failed command: the tag, message, hint and exit code. */
export interface Failure {
  readonly tag: string
  readonly message: string
  readonly hint: string
  readonly code: number
}

/** Describes any failure of a command. Anything that is not a known error exits as a state error. */
export const describeFailure = (error: unknown): Failure => {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "Defect"
  const message = (
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : String(error)
  )
    .replace(/\s+/g, " ")
    .trim()
  return {
    tag,
    message,
    hint:
      error instanceof Usage
        ? error.hint
        : (HINTS[tag] ?? "Run `holyagent --help` for the commands."),
    code: USAGE_ERRORS.has(tag) ? EXIT.usage : REFUSED_ERRORS.has(tag) ? EXIT.refused : EXIT.state,
  }
}
