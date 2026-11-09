import { Schema } from "effect"

/** The two setup choices the interface offers; the Pi provider is fixed and not one of them. */
export interface Choices {
  readonly worktrees: boolean
  readonly deviceAccess: boolean
}

/** What the machine allows, which decides the rows: the device row needs a host. */
export interface Offer {
  /** What lets agents use devices here (Xcode or an Android SDK), or `undefined`: no device row. */
  readonly device: string | undefined
  /** Whether the worktree row is offered. */
  readonly worktrees: boolean
}

/** One line of the review: what setup does with a group of T3 settings keys. */
export interface ReviewLine {
  /** `+` added, `=` already set, `~` kept or left out, `-` switched off. */
  readonly mark: "+" | "=" | "~" | "-"
  readonly name: string
  readonly detail: string
}

/** What the review screen lists for the current choices. */
export interface Review {
  /** The T3 settings file setup writes. */
  readonly file: string
  /** The groups the choices switch (the Pi provider, device access, worktrees). */
  readonly choices: ReadonlyArray<ReviewLine>
  /** The groups setup always applies. */
  readonly always: ReadonlyArray<ReviewLine>
}

/** The result of the setup run the interface applied: its report lines and whether all passed. */
export interface Applied {
  readonly ok: boolean
  readonly lines: ReadonlyArray<string>
}

/** What the setup interface needs from the command; the host builds it, the interface only calls. */
export interface TuiInput {
  /** The environment of the process, for the colour policy and the glyph set. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly offer: Offer
  /** The choices the rows start with. */
  readonly initial: Choices
  /** Whether the run writes nothing (the review says so). */
  readonly dryRun: boolean
  /** Lists what the choices change; rejects with an `Error` when the files cannot be read. */
  readonly review: (choices: Choices) => Promise<Review>
  /** Runs setup with the choices; `signal` aborts it when the person interrupts. */
  readonly apply: (choices: Choices, signal: AbortSignal) => Promise<Applied>
}

/** How the interface ended: the person applied, cancelled, or interrupted a running apply. */
export type TuiOutcome =
  | { readonly _tag: "Applied"; readonly applied: Applied }
  | { readonly _tag: "Cancelled" }
  | { readonly _tag: "Interrupted" }

/** What the TUI bundle exports: the one function the command calls. */
export interface SetupTuiModule {
  /** Shows the interface and resolves with how it ended. */
  readonly runSetupTui: (input: TuiInput) => Promise<TuiOutcome>
}

const AppliedSchema = Schema.Struct({
  ok: Schema.Boolean,
  lines: Schema.Array(Schema.String),
})

/** The shape of {@link TuiOutcome}, which crosses from the separately built bundle. */
export const TuiOutcomeSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("Applied"), applied: AppliedSchema }),
  Schema.Struct({ _tag: Schema.Literal("Cancelled") }),
  Schema.Struct({ _tag: Schema.Literal("Interrupted") }),
])
