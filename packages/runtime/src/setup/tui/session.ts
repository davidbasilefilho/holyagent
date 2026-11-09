import { Effect, Schema } from "effect"

import { inCloudSession } from "../../vcs/identity.ts"
import type { Env } from "../environment.ts"
import { piInUse } from "../pi-check.ts"
import { hint, type Report } from "../report.ts"
import type { Scope } from "../scope.ts"
import type { Shell } from "../shell.ts"
import { previewT3Settings, type T3Preview, type T3UnitPreview } from "../t3-settings.ts"
import { loadSetupTui, TuiUnavailable } from "./load.ts"
import {
  type Applied,
  type Choices,
  type Offer,
  type Review,
  type ReviewLine,
  type SetupTuiModule,
  type TuiInput,
  TuiOutcomeSchema,
} from "./types.ts"

/** Whether stdin and stdout of the process are terminals. */
export interface Terminal {
  readonly stdin: boolean
  readonly stdout: boolean
}

/** The choices the interface starts with and the flags apply when one is left out: all on. */
export const DEFAULT_CHOICES: Choices = { worktrees: true, deviceAccess: true }

const set = (value: string | undefined) => value !== undefined && value !== ""

/**
 * Why the interface is not used, or `undefined` when it can be: `--no-tui` or a choice flag was
 * given (the flags apply directly), stdin or stdout is not a terminal, `CI` is set (other than
 * `false`) or `TERM` is `dumb`.
 */
export const tuiFallbackReason = (options: {
  readonly env: Env
  readonly terminal: Terminal | undefined
  readonly noTui: boolean
  readonly choiceFlag: boolean
}): string | undefined => {
  const { env, terminal } = options
  if (options.noTui) return "--no-tui was passed"
  if (options.choiceFlag) return "a choice flag was passed, so it applies directly"
  if (terminal === undefined || !terminal.stdin || !terminal.stdout)
    return "stdin or stdout is not a terminal"
  if (set(env["CI"]) && env["CI"] !== "false") return "CI is set"
  if (env["TERM"] === "dumb") return "TERM is dumb"
  return undefined
}

/**
 * The T3 settings step as it would run: a {@link T3Preview} when the T3 part of setup has work on
 * this machine (not an undo, scope `user`, not a cloud session, Pi in use, T3 Code installed), else
 * `undefined`, in which case there is nothing to choose and no interface.
 */
export const t3Offer = Effect.fn("t3Offer")(function* (
  env: Env,
  cwd: string,
  options: { readonly scope: Scope; readonly undo: boolean },
) {
  if (options.undo || options.scope !== "user" || inCloudSession(env)) return undefined
  if (!(yield* piInUse(env))) return undefined
  // A settings file that cannot be read is reported by the line-based step, which then runs.
  const preview = yield* previewT3Settings(env, cwd, DEFAULT_CHOICES).pipe(
    Effect.catchTag("SetupFailure", () => Effect.succeed(undefined)),
  )
  return preview === undefined || "line" in preview ? undefined : preview
})

/** The rows the interface offers for a preview. */
export const offerOf = (preview: T3Preview): Offer => ({
  device: preview.device,
  worktrees: preview.worktreesAllowed,
})

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const lineOf = (unit: T3UnitPreview): ReviewLine => {
  const name = capitalized(unit.name)
  if (unit.own === true) return { mark: "=", name, detail: "already written by setup" }
  if (unit.left !== undefined) return { mark: "~", name, detail: `left out: ${unit.left}` }
  const kept = unit.kept.length === 0 ? [] : [`kept ${unit.kept.join(", ")} (yours wins)`]
  // Two keys fit a line with their values; more are counted and led by the first.
  const added =
    unit.added.length <= 2
      ? unit.added.join(", ")
      : `${unit.added.length} keys, starting with ${(unit.added[0] ?? "").split(" ")[0]}`
  if (unit.added.length > 0) return { mark: "+", name, detail: [added, ...kept].join("; ") }
  if (kept.length > 0) return { mark: "~", name, detail: kept.join("; ") }
  return { mark: "=", name, detail: "already set" }
}

const choiceLine = (name: string, unit: T3UnitPreview | undefined): ReviewLine =>
  unit === undefined
    ? { mark: "-", name, detail: "off; nothing written" }
    : lineOf({ ...unit, name })

/**
 * What the review screen lists for a preview and the choices: the groups the choices switch (a
 * group that is off says so), then every group setup always applies, each with its keys and values
 * or why nothing changes. `preview` was read with the same choices.
 */
export const reviewOf = (preview: T3Preview, choices: Choices): Review => {
  const unit = (choice: T3UnitPreview["choice"]) => preview.units.find((u) => u.choice === choice)
  const pi = unit("pi")
  return {
    file: preview.file,
    choices: [
      ...(pi === undefined ? [] : [lineOf({ ...pi, name: "Pi provider" })]),
      ...(preview.device === undefined
        ? []
        : [
            choiceLine(
              "Agent device access",
              choices.deviceAccess ? unit("deviceAccess") : undefined,
            ),
          ]),
      ...(preview.worktreesAllowed
        ? [
            choiceLine(
              "New threads in worktrees",
              choices.worktrees ? unit("worktrees") : undefined,
            ),
          ]
        : []),
    ],
    always: preview.units.filter((u) => u.choice === undefined).map(lineOf),
  }
}

/** What the command gives {@link runInteractive}. */
export interface InteractiveOptions {
  readonly env: Env
  readonly cwd: string
  readonly scope: Scope
  readonly undo: boolean
  readonly dryRun: boolean
  readonly terminal: Terminal | undefined
  readonly noTui: boolean
  readonly choiceFlag: boolean
  /** Loads the interface; {@link loadSetupTui} (with a notice before a first install) when absent. */
  readonly load?: (
    env: Env,
    notify: (text: string) => Effect.Effect<void>,
  ) => Effect.Effect<SetupTuiModule, TuiUnavailable, Shell>
  /** Prints a line now, for the notice before a first install. */
  readonly notify: (text: string) => Effect.Effect<void>
  /** Runs the whole setup with the choices and returns its report. */
  readonly apply: (choices: Choices) => Effect.Effect<Report>
}

/** How {@link runInteractive} ended: the line-based setup runs, or the person decided. */
export type Interactive =
  | { readonly kind: "line"; readonly notes: ReadonlyArray<string> }
  | { readonly kind: "done"; readonly report: Report }

const fallback = (reason: string): Interactive => ({
  kind: "line",
  notes: [hint(`t3 tui: ${reason}; using the line-based setup`)],
})

const decodeOutcome = Schema.decodeUnknownEffect(TuiOutcomeSchema, { onExcessProperty: "error" })

/**
 * Offers the T3 choices in the interface when the T3 part of setup has work and the terminal allows
 * it. It falls back to the line-based setup, with one note saying why, when a flag or the terminal
 * rules the interface out, when it cannot be installed or imported (offline), or when it fails to
 * start or answers in a shape the command does not know. Cancelling writes nothing and reports it;
 * an applied run reports the setup it ran.
 */
export const runInteractive = Effect.fn("runInteractive")(function* (options: InteractiveOptions) {
  const preview = yield* t3Offer(options.env, options.cwd, options)
  if (preview === undefined) return { kind: "line", notes: [] } satisfies Interactive
  const reason = tuiFallbackReason(options)
  if (reason !== undefined) return fallback(reason)
  const load = options.load ?? ((env, notify) => loadSetupTui(env, { notify }))
  const loaded = yield* load(options.env, options.notify).pipe(
    Effect.catchTag("TuiUnavailable", (error) => Effect.succeed(error)),
  )
  if (loaded instanceof TuiUnavailable) return fallback(`unavailable (${loaded.reason})`)
  const input: TuiInput = {
    env: options.env,
    offer: offerOf(preview),
    initial: DEFAULT_CHOICES,
    dryRun: options.dryRun,
    review: (choices) =>
      Effect.runPromise(
        previewT3Settings(options.env, options.cwd, choices).pipe(
          Effect.flatMap((next) =>
            next === undefined || "line" in next
              ? Effect.fail(new Error("the T3 settings step has nothing to do any more"))
              : Effect.succeed(reviewOf(next, choices)),
          ),
        ),
      ),
    apply: (choices, signal) => Effect.runPromise(options.apply(choices), { signal }),
  }
  return yield* Effect.tryPromise({
    try: () => loaded.runSetupTui(input),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap(decodeOutcome),
    Effect.map((outcome): Interactive => {
      if (outcome._tag === "Applied") {
        const applied: Applied = outcome.applied
        return { kind: "done", report: { lines: applied.lines, ok: applied.ok } }
      }
      return {
        kind: "done",
        report:
          outcome._tag === "Cancelled"
            ? { lines: [hint("setup cancelled; nothing was written")], ok: false }
            : {
                lines: [
                  "! setup was interrupted while applying; run holyagent setup again to finish",
                ],
                ok: false,
              },
      }
    }),
    Effect.catch((cause) => Effect.succeed(fallback(`failed to start (${oneLine(cause)})`))),
  )
})

const oneLine = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).trim().split("\n")[0] ?? ""
