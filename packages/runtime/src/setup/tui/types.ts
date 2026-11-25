import { Schema } from "effect"

import type { SetupProgressUpdate } from "../../../../core/src/setup/progress.ts"
import type { PiProvider, PiProviderSelection } from "../../config/schema.ts"
import type { BrowsePlan } from "../browse-setup.ts"

/** The setup choices: harnesses, Pi model providers, T3 settings and capability switches. */
export interface Choices {
  readonly worktrees: boolean
  readonly piProviders?: PiProviderSelection
  readonly deviceAccess: boolean
  /** Each offered capability's switch, by `pi.features` key. */
  readonly capabilities: Readonly<Record<string, boolean>>
  /** True only after the person chooses Configure or Update for this run. */
  readonly browseSetup?: boolean
  /** The detected browser profile picked for a new Browse pairing. */
  readonly browseProfile?: number
  /** Selected public harnesses in the combined setup. */
  readonly harnesses?: { readonly pi: boolean; readonly claude: boolean; readonly codex?: boolean }
}

/** One capability row of the choose screen. */
export interface CapabilityOffer {
  /** The `pi.features` key the row switches. */
  readonly feature: string
  /** The capability's name, the row's label. */
  readonly name: string
  /** What the capability gives. */
  readonly description: string
  /**
   * Why the form in force does not offer it, or `undefined`; it can still be switched in the
   * config.
   */
  readonly unavailable: string | undefined
}

/** What the machine allows, which decides the rows: the device row needs a host. */
export interface Offer {
  /** Whether the T3 review sections show. */
  readonly t3: boolean
  /** Pi provider ids from the integration schema. */
  readonly providers?: ReadonlyArray<PiProvider>
  /** What lets agents use devices here (Xcode or an Android SDK), or `undefined`: no device row. */
  readonly device: string | undefined
  /** Whether the worktree row is offered. */
  readonly worktrees: boolean
  /** The capability rows, in registry order; none when the config cannot be read or Pi is off. */
  readonly capabilities: ReadonlyArray<CapabilityOffer>
  /** The public graphical Pi setup's read-only OpenCode Browse plan. */
  readonly browse?: Pick<BrowsePlan, "state" | "action" | "profiles">
  /** The form in force, as a phrase for the capability heading (`headless (detected: CI is set)`). */
  readonly form: string
  /** Present only in bare public setup when the harness chooser is available. */
  readonly harnesses?: {
    readonly piAvailable: boolean
    readonly scope: string
    readonly codexHome?: string
  }
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
  /** Detection and what the selected Browse action will do, if Browser Use is enabled. */
  readonly browse?: ReadonlyArray<string>
  /** The Apply action will replace one previous Pi registration that the review lists. */
  readonly replacePiRegistration?: boolean
  /** The T3 settings file setup writes; `undefined` when the T3 part has no work. */
  readonly file: string | undefined
  /**
   * What each capability switch does: turned on, turned off, unchanged or not offered in the form;
   * none when absent.
   */
  readonly capabilities?: ReadonlyArray<ReviewLine>
  /** The groups the choices switch (the Pi provider, device access, worktrees). */
  readonly choices: ReadonlyArray<ReviewLine>
  /** The groups setup always applies. */
  readonly always: ReadonlyArray<ReviewLine>
  /** Planned setup operations for the selected harnesses, with no settings written yet. */
  readonly harnesses?: ReadonlyArray<{
    readonly name: string
    readonly lines: ReadonlyArray<string>
  }>
}

/** The result of the setup run the interface applied: its report lines and whether all passed. */
export interface Applied {
  readonly ok: boolean
  readonly lines: ReadonlyArray<string>
}

/** The active harness and its current phase, if that harness has finished planning. */
export interface SetupDisplayProgress {
  readonly harness?: { readonly index: number; readonly total: number; readonly label: string }
  readonly phase?: SetupProgressUpdate
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
  readonly apply: (
    choices: Choices,
    signal: AbortSignal,
    report?: (progress: SetupDisplayProgress) => void,
  ) => Promise<Applied>
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
