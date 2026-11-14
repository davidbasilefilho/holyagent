import { Usage } from "@holyagent/core/api/usage.ts"
import { Data } from "effect"

import { CLAUDE_WORDS, type HostWords } from "../domain/host.ts"
import { VCS_HINTS, VCS_REFUSED_ERRORS } from "../vcs/errors.ts"

/** The command line does not match the command's usage. */
export { Usage }

/** A command that reads stdin found a terminal or nothing. */
export class StdinMissing extends Data.TaggedError("StdinMissing")<{
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `This command needs input on stdin: ${this.reason}`
  }
}

/** The Agent result named no agent id that could be recorded. */
export class AgentIdMissing extends Data.TaggedError("AgentIdMissing")<Record<never, never>> {
  /** The description shown to the user. */
  override get message() {
    return "The tool response has no usable agent id"
  }
}

/** A launch cannot be recorded because the project has no state folder. */
export class StateFolderMissing extends Data.TaggedError("StateFolderMissing")<
  Record<never, never>
> {
  /** The description shown to the user. */
  override get message() {
    return "This project has no .holyagent folder"
  }
}

/** The agent that was launched is not the one the Assignment was dispatched to. */
export class AgentMismatch extends Data.TaggedError("AgentMismatch")<{
  readonly expected: string
  readonly launched: string | undefined
}> {
  /** The description shown to the user. */
  override get message() {
    return `The Assignment was dispatched to ${this.expected}, but ${this.launched ?? "no agent type"} was launched`
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
  "MigrationRefused",
  "NothingToMigrate",
  "StateModeRefused",
  ...VCS_REFUSED_ERRORS,
])

const insufficientAcceptanceHint = (words: HostWords, id: string) =>
  `Nothing was recorded. ${words.askForSupport} for the missing support, then run \`holyagent assignment close ${id} --outcome success --accept <rationale>\` with the corrected report on stdin. For a succeeded, unaccepted assignment, you can instead run \`holyagent assignment accept ${id} --rationale <text> --report\` with the report on stdin. For a workflow agent, draft a follow-up with followUpOf.`

const HINTS: Readonly<Record<string, string>> = {
  StdinMissing:
    "Give the input as --input '<json>' or pipe it in, for example: echo '...' | holyagent <command>; see --help.",
  NoActiveIntent:
    "Pick one with `holyagent intent use <id>`, or start one with `holyagent intent create`.",
  InvalidDraft:
    "Send JSON in the shape `holyagent <command> --help` shows; unknown fields are refused.",
  InvalidPath: "Use relative portable paths such as packages/runtime/src.",
  MissingOwnership:
    "Give a writing role task an ownershipPaths entry or operationalResources entry.",
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
  SpecialistMismatch: "Record the agent that was actually launched, or dispatch again.",
  SpecialistNotRecorded:
    "Run `holyagent assignment record <id> --agent <agentId>` first, or close with another outcome.",
  MigrationRefused:
    "Run `holyagent migrate --dry-run` to see everything that blocks it. Settle a Running legacy Assignment with the legacy tool first; the command never overwrites an existing .holyagent record.",
  NothingToMigrate:
    "Run it in a project that has a .holyclaude or .holycodex folder with state in it, or check that you are in the project root.",
  MigrationUnverified:
    "The records were written but do not load back: delete the files this run wrote (git status lists them), fix the cause the message names and run `holyagent migrate --dry-run` again.",
  ToolMissing:
    "Install the program with the command the message gives for your platform; until then search with the system grep or find and report the missing program.",
  BrowserLaunchFailed:
    "Check the message: install uv (uvx) and a Chromium as `holyagent doctor` says, then restart the session; run `holyagent doctor` to see what the headless browser-use form needs.",
  StateModeRefused:
    "Leave the mode as it is and work with it. To change it deliberately, move the records by hand first: the command never moves or deletes them.",
  StateLocked: "Another process holds the state lock; retry in a moment.",
  StateIo:
    "Check the path, permissions and Git state named in the error. Resolve any branch name conflict and retry.",
  CorruptRecord: "Fix or delete the file the message names, or restore it from version control.",
  ConfigInvalid:
    "Fix the field the message names in that config.json (the keys and values are listed in docs/pi/configuration.md), or delete the file to use the defaults.",
  ...VCS_HINTS,
}

/** What the caller prints for a failed command: the tag, message, hint and exit code. */
export interface Failure {
  readonly tag: string
  readonly message: string
  readonly hint: string
  readonly code: number
}

/** Renders terminal controls visibly while keeping line breaks and tabs. */
export const plainText = (text: string): string => {
  let result = ""
  for (const character of text) {
    const code = character.charCodeAt(0)
    result +=
      (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
        ? `\\u${code.toString(16).padStart(4, "0")}`
        : character
  }
  return result
}

/**
 * Describes any failure of a command. Anything that is not a known error exits as a state error.
 * The hints that name a host's tools use its `words` (Claude's by default).
 */
export const describeFailure = (error: unknown, words: HostWords = CLAUDE_WORDS): Failure => {
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
    message: plainText(message),
    hint: plainText(
      error instanceof Usage
        ? error.hint
        : tag === "InsufficientAcceptance"
          ? insufficientAcceptanceHint(
              words,
              typeof error === "object" && error !== null && "id" in error
                ? String(error.id)
                : "<id>",
            )
          : (HINTS[tag] ?? "Run `holyagent --help` for the commands."),
    ),
    code: USAGE_ERRORS.has(tag) ? EXIT.usage : REFUSED_ERRORS.has(tag) ? EXIT.refused : EXIT.state,
  }
}
