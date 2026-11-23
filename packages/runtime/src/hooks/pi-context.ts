import { decode } from "@toon-format/toon"
import { Data, Effect, Schema } from "effect"

import { bareContext, SESSION_REMINDER, sessionContext } from "../cli/sessioncontext.ts"
import type { PiFamily } from "../instructions/families.ts"
import gpt62Reminder from "../instructions/gpt-6.2/session-reminder.md" with { type: "text" }
import gptReminder from "../instructions/gpt-6/session-reminder.md" with { type: "text" }
import kimiReminder from "../instructions/kimi-k3.1/session-reminder.md" with { type: "text" }
import { stripCitations } from "../instructions/skills.ts"
import { fillPackageRoot } from "../pi/bun-flags.ts"
import { piRootSection } from "../pi/root-prompt.ts"

export { PI_ROOT_PLACEHOLDER } from "../pi/bun-flags.ts"

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

const defaultFamily: PiFamily = "kimi-k3.1"

// Match the opening sections of the root system prompt, with no context or tools specific to
// the launch. Keep this order aligned with the Claude core (checked in the Pi context tests).
const coreSections = [
  "identity.md",
  "../shared/precedence.md",
  "delegating.md",
  "dispatch.md",
  "task-list.md",
]
const coreOf = (family: PiFamily): string =>
  coreSections.map((file) => piRootSection(family, file)).join("\n\n")

const reminders: Readonly<Record<PiFamily, string>> = {
  "kimi-k3.1": stripCitations(kimiReminder).trim(),
  "gpt-6": stripCitations(gptReminder).trim(),
  "gpt-6.2": stripCitations(gpt62Reminder).trim(),
}

/** The Kimi root’s core rules, with the package-root placeholder unfilled. */
export const PI_ROOT_CORE: string = coreOf(defaultFamily)

/** The Kimi reminder restated with a root or session role’s context. */
export const PI_SESSION_REMINDER: string = reminders[defaultFamily]

/** The family’s core rules with its installed agent CLI command and paths filled in. */
export const piRootCore = (piRoot: string, family: PiFamily = defaultFamily): string =>
  fillPackageRoot(coreOf(family), piRoot)

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
  family: PiFamily = defaultFamily,
): string | undefined => {
  const core = role === "session" ? piRootCore(piRoot, family) : undefined
  const closing = role === "specialist" ? undefined : reminders[family]
  if (state === undefined)
    return core === undefined ? undefined : withReminder(bareContext(core), closing)
  return withReminder(sessionContext(state.status, core, state.reconcile), closing)
}
