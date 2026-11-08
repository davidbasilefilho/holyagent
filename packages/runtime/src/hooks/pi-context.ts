import { decode } from "@toon-format/toon"
import { Data, Effect, Schema } from "effect"

import { bareContext, SESSION_REMINDER, sessionContext } from "../cli/sessioncontext.ts"
import delegating from "../instructions/kimi-k3.1/root/delegating.md" with { type: "text" }
import dispatch from "../instructions/kimi-k3.1/root/dispatch.md" with { type: "text" }
import identity from "../instructions/kimi-k3.1/root/identity.md" with { type: "text" }
import taskList from "../instructions/kimi-k3.1/root/task-list.md" with { type: "text" }
import reminder from "../instructions/kimi-k3.1/session-reminder.md" with { type: "text" }
import precedence from "../instructions/kimi-k3.1/shared/precedence.md" with { type: "text" }
import { stripCitations } from "../instructions/skills.ts"

/**
 * What a Pi session is for, which decides the context it gets at start: `root` is the default
 * session that carries the root rules in its system prompt and gets the status only; `specialist`
 * is a child the root launches, which gets the status and no root rules; `session` is any other Pi
 * session, which gets the core of the root rules and the status.
 */
export const PI_ROLES = ["root", "specialist", "session"] as const

/** One role of a Pi session: an entry of {@link PI_ROLES}. */
export type PiRole = (typeof PI_ROLES)[number]

/** The role of a session that is not given one: plain `pi` starts the HolyAgent root. */
export const DEFAULT_PI_ROLE: PiRole = "root"

/** The schema of a role, for decoding the value of the launch flag. */
export const PiRoleSchema = Schema.Literals(PI_ROLES)

/**
 * The placeholder of the root text for the absolute path of the installed Pi package, which holds
 * `scripts/holyagent`. Whoever delivers the text fills it in.
 */
export const PI_ROOT_PLACEHOLDER = "${HOLYAGENT_PI_ROOT}"

/**
 * The core of the root rules for the Kimi family, with {@link PI_ROOT_PLACEHOLDER} unfilled: the
 * same files in the same order as the Claude core (`ROOT_CORE_FILES`), joined the same way, with
 * the maintainers' notes removed as the generators remove them.
 */
export const PI_ROOT_CORE: string = [identity, precedence, delegating, dispatch, taskList]
  .map((text) => stripCitations(text).trim())
  .join("\n\n")

/**
 * The block of rules the core leaves out, in the Kimi family's words: it ends the context of a root
 * or session role and replaces the Claude block that the shared context builder ends with.
 */
export const PI_SESSION_REMINDER: string = stripCitations(reminder).trim()

/** The core of the root rules with {@link PI_ROOT_PLACEHOLDER} replaced by `piRoot`. */
export const piRootCore = (piRoot: string): string =>
  PI_ROOT_CORE.replaceAll(PI_ROOT_PLACEHOLDER, () => piRoot)

/**
 * What the CLI printed for a status or reconcile call, as the context builders read it: the decoded
 * fields of the TOON output.
 */
export type CommandOutput = Readonly<Record<string, unknown>>

/** A command's output that is not TOON, or not an object of fields. */
export class OutputUnreadable extends Data.TaggedError("OutputUnreadable")<{
  readonly command: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `the output of \`holyagent ${this.command}\` could not be read: ${this.reason}`
  }
}

const Fields = Schema.Record(Schema.String, Schema.Unknown)

/** Decodes the TOON on a command's stdout into its fields, or fails with OutputUnreadable. */
export const parseOutput = (
  command: string,
  text: string,
): Effect.Effect<CommandOutput, OutputUnreadable> =>
  Effect.try({
    try: (): unknown => decode(text),
    catch: (cause) => new OutputUnreadable({ command, reason: String(cause) }),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Fields)),
    Effect.mapError((error) =>
      error instanceof OutputUnreadable
        ? error
        : new OutputUnreadable({ command, reason: error.message }),
    ),
  )

/** The state of a project that has a `.holyagent` folder, as `status` and `reconcile` print it. */
export interface ProjectState {
  readonly status: CommandOutput
  /** The `reconcile` result, read after a resume or a compaction only. */
  readonly reconcile?: CommandOutput
}

// The shared builder ends every context with the Claude reminder; the Pi reminder, or none for a
// specialist, takes its place. A text that does not end with it is returned as it is.
const withReminder = (text: string, replacement: string | undefined): string => {
  if (!text.endsWith(SESSION_REMINDER)) return text
  const head = text.slice(0, text.length - SESSION_REMINDER.length).trimEnd()
  return replacement === undefined ? head : `${head}\n\n${replacement}`
}

/**
 * The context a Pi session gets at its start or after a compaction, as the Claude `session-start`
 * hook builds it and within its character budget: the status, and the Running rows of the reconcile
 * result when given, led by the core of the root rules for a `session` role. A project with no
 * state folder (`state` undefined) gets nothing, except that a `session` role still gets the core,
 * as the Claude hook gives it to a main thread that is not the root. A `specialist` gets no
 * reminder, since the reminder restates root rules. `piRoot` fills the core's placeholder.
 */
export const piContext = (
  role: PiRole,
  piRoot: string,
  state: ProjectState | undefined,
): string | undefined => {
  const core = role === "session" ? piRootCore(piRoot) : undefined
  const closing = role === "specialist" ? undefined : PI_SESSION_REMINDER
  if (state === undefined)
    return core === undefined ? undefined : withReminder(bareContext(core), closing)
  return withReminder(sessionContext(state.status, core, state.reconcile), closing)
}
