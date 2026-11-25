import { Effect, Schema } from "effect"

import { enabledPiProviders } from "../../../../core/src/pi/provider.ts"
import {
  CAPABILITIES,
  type CapabilityDefinition,
  formContent,
  unavailableIn,
} from "../../config/capabilities.ts"
import { type Config, PiProvider } from "../../config/schema.ts"
import { inCloudSession } from "../../vcs/identity.ts"
import type { Env } from "../environment.ts"
import { describeForm, type FormChoice, inCi } from "../form.ts"
import { type CapabilityChoices, loadPiConfig, piInUse } from "../pi-check.ts"
import { hint, type Report } from "../report.ts"
import type { Scope } from "../scope.ts"
import type { Shell } from "../shell.ts"
import { previewT3Settings, type T3Preview, type T3UnitPreview } from "../t3-settings.ts"
import { loadPackagedSetupTui, loadSetupTui, plain, TuiUnavailable } from "./load.ts"
import {
  type Applied,
  type CapabilityOffer,
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

/**
 * The T3 choices the interface starts with and the flags apply when one is left out: all on. The
 * capability switches start from the config, not from here.
 */
export const DEFAULT_CHOICES: Choices = { worktrees: true, deviceAccess: true, capabilities: {} }

/**
 * Why the interface is not used, or `undefined` when it can be: `--no-tui` or a choice flag was
 * given (the flags apply directly), stdin or stdout is not a terminal, `CI` is set to a truthy
 * value ({@link inCi}) or `TERM` is `dumb`.
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
  if (inCi(env)) return "CI is set"
  if (env["TERM"] === "dumb") return "TERM is dumb"
  return undefined
}

/**
 * The T3 settings step as it would run: a {@link T3Preview} when the T3 part of setup has work on
 * this machine (not an undo, scope `user`, not a cloud session, Pi in use, T3 Code installed), else
 * `undefined`, in which case there is nothing to choose and no interface. The caller has probed
 * whether Pi is in use (`piUsed`) and loaded the config of the scope (`config`, `undefined` when it
 * cannot be loaded), so neither is repeated here; at scope `user` that is the config the step
 * reads.
 */
export const t3Offer = Effect.fn("t3Offer")(function* (
  env: Env,
  cwd: string,
  options: {
    readonly scope: Scope
    readonly undo: boolean
    readonly piUsed: boolean
    readonly config: Config | undefined
  },
) {
  if (options.undo || options.scope !== "user" || inCloudSession(env)) return undefined
  if (!options.piUsed || options.config === undefined) return undefined
  // A settings file that cannot be read is reported by the line-based step, which then runs.
  const preview = yield* previewT3Settings(env, cwd, {
    ...DEFAULT_CHOICES,
    config: options.config,
  }).pipe(Effect.catchTag("SetupFailure", () => Effect.succeed(undefined)))
  return preview === undefined || "line" in preview ? undefined : preview
})

/** The capability rows for a form: one for each registry entry, with why the form leaves it out. */
export const capabilityOffers = (
  form: FormChoice,
  definitions: ReadonlyArray<CapabilityDefinition> = CAPABILITIES,
): ReadonlyArray<CapabilityOffer> =>
  definitions.map((capability) => ({
    feature: capability.feature,
    name: capability.name,
    description: capability.description,
    unavailable: unavailableIn(capability, form.form),
  }))

/**
 * The rows the interface offers: those of a T3 preview, if the T3 part has work, and the
 * capabilities.
 */
export const offerOf = (
  preview: T3Preview | undefined,
  capabilities: ReadonlyArray<CapabilityOffer>,
  form: FormChoice,
): Offer => ({
  t3: preview !== undefined,
  device: preview?.device,
  worktrees: preview?.worktreesAllowed ?? false,
  capabilities,
  form: describeForm(form),
})

/** The switches a config holds, by `pi.features` key, for the capabilities of the registry. */
export const featureSwitches = (
  features: Config["pi"]["features"],
  definitions: ReadonlyArray<CapabilityDefinition> = CAPABILITIES,
): Readonly<Record<string, boolean>> =>
  Object.fromEntries(
    definitions.map((capability) => [
      capability.feature,
      (features as Readonly<Record<string, unknown>>)[capability.feature] === true,
    ]),
  )

/**
 * The capability choices that differ from the switches the screen started with: what the run writes
 * to the config, so an untouched row never freezes its default into the file.
 */
export const changedSwitches = (
  initial: Readonly<Record<string, boolean>>,
  chosen: Readonly<Record<string, boolean>>,
): CapabilityChoices =>
  Object.fromEntries(
    CAPABILITIES.flatMap((capability) => {
      const value = chosen[capability.feature]
      return value === undefined || value === initial[capability.feature]
        ? []
        : [[capability.feature, value]]
    }),
  )

/**
 * The review lines of the capability switches: for each, whether the choice turns it on or off or
 * leaves it, and what that does to the packages in the form in force. The packages of a capability
 * the form does not offer are never installed, so it says so instead.
 */
export const capabilityReview = (
  initial: Readonly<Record<string, boolean>>,
  chosen: Readonly<Record<string, boolean>>,
  form: FormChoice,
  definitions: ReadonlyArray<CapabilityDefinition> = CAPABILITIES,
): ReadonlyArray<ReviewLine> =>
  definitions.map((capability): ReviewLine => {
    const was = initial[capability.feature] === true
    const now = chosen[capability.feature] === true
    const reason = unavailableIn(capability, form.form)
    const packages = formContent(capability, form.form)?.packages ?? []
    const names = packages.length === 0 ? "no package" : packages.join(", ")
    const name = capability.name
    if (reason !== undefined)
      return {
        mark: "~",
        name,
        detail: `${now ? "on" : "off"} in the config; not offered in the ${form.form} form (${reason})`,
      }
    if (now === was) return { mark: "=", name, detail: now ? `stays on (${names})` : "stays off" }
    return now
      ? { mark: "+", name, detail: `turned on (${names})` }
      : { mark: "-", name, detail: `turned off (${names} removed)` }
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
 * or why nothing changes. `preview` was read with the same choices; it is `undefined` when the T3
 * part has no work, and the review then holds the `capabilities` lines alone.
 */
export const reviewOf = (
  preview: T3Preview | undefined,
  choices: Choices,
  capabilities: ReadonlyArray<ReviewLine> = [],
): Review => {
  if (preview === undefined) return { file: undefined, capabilities, choices: [], always: [] }
  const unit = (choice: T3UnitPreview["choice"]) => preview.units.find((u) => u.choice === choice)
  const pi = unit("pi")
  return {
    file: preview.file,
    capabilities,
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
  /** Public setup loads the packaged renderer and stops if it fails. */
  readonly t3Workflow?: boolean
  /** The form in force, which decides what each capability row says it installs. */
  readonly form: FormChoice
  /** Overrides the packaged or private renderer loader, for tests. */
  readonly load?: (
    env: Env,
    notify: (text: string) => Effect.Effect<void>,
  ) => Effect.Effect<SetupTuiModule, TuiUnavailable, Shell>
  /** Prints a line now, for the notice before a first install. */
  readonly notify: (text: string) => Effect.Effect<void>
  /**
   * Runs the whole setup with the choices and the capability switches that differ from the
   * config's, and returns its report.
   */
  readonly apply: (
    choices: Choices,
    capabilities: CapabilityChoices,
    replacePiRegistration: boolean,
  ) => Effect.Effect<Report>
  /** The explicit public Pi command uses this for preflight of changed providers. */
  readonly previewPi?: (choices: Choices, capabilities: CapabilityChoices) => Effect.Effect<Report>
  /** Read-only preview and confirmed application of the public harness selections. */
  readonly combined?: {
    readonly run: (
      target: "pi" | "claude",
      choices: Choices,
      capabilities: CapabilityChoices,
      dryRun: boolean,
      skipSharedPrerequisites: boolean,
      replacePiRegistration: boolean,
    ) => Effect.Effect<Report>
  }
}

/** How {@link runInteractive} ended: the line-based setup runs, or the person decided. */
export type Interactive =
  | { readonly kind: "line"; readonly notes: ReadonlyArray<string> }
  | { readonly kind: "done"; readonly report: Report }
  | { readonly kind: "applied"; readonly report: Report }

const fallback = (reason: string): Interactive => ({
  kind: "line",
  notes: [hint(`t3 tui: ${plain(reason)}; using the line-based setup`)],
})

const stopped = (reason: string, applyStarted = false): Interactive => ({
  kind: "done",
  report: {
    ok: false,
    lines: [
      `! t3 tui: ${plain(reason)}`,
      hint(
        applyStarted
          ? "setup stopped after apply began; check your settings before retrying"
          : "setup changed no settings; fix the installation or rerun with --no-tui",
      ),
    ],
  },
})

const decodeOutcome = Schema.decodeUnknownEffect(TuiOutcomeSchema, { onExcessProperty: "error" })

/**
 * Offers the capability switches and the T3 choices in the interface when Pi is in use (and setup
 * is not an undo or in a cloud session) and there is something to choose: a capability row for each
 * registry entry while the config loads with `pi.enable` on, and the T3 rows when the T3 part of
 * setup has work. It falls back to the line-based setup when a flag or the terminal rules the
 * interface out (with one note saying why, unless the T3 part has no work and the capability rows
 * are all there was to show). Public setup also stops if the selected renderer cannot load, start,
 * or report its outcome. Before apply, the private workflow retains its legacy fallback. Cancelling
 * writes nothing and reports it; an applied run reports the setup it ran.
 */
export const runInteractive = Effect.fn("runInteractive")(function* (options: InteractiveOptions) {
  const line = { kind: "line", notes: [] } satisfies Interactive
  if (options.undo || inCloudSession(options.env)) return line
  const fallbackReason = tuiFallbackReason(options)
  const combined = fallbackReason === undefined ? options.combined : undefined
  const piUsed = yield* piInUse(options.env)
  if (!piUsed && combined === undefined) return line
  // Loaded once for the run: a config that cannot be read is reported by the line-based Pi steps,
  // which then run.
  const config = yield* loadPiConfig(options.env, options.cwd, options.scope).pipe(
    Effect.catchTag("SetupFailure", () => Effect.succeed(undefined)),
  )
  const preview = yield* t3Offer(options.env, options.cwd, { ...options, piUsed, config })
  const features =
    config === undefined || !config.pi.enable ? undefined : featureSwitches(config.pi.features)
  const offers =
    features === undefined
      ? []
      : capabilityOffers(options.form).filter(
          (offer) =>
            options.t3Workflow !== true ||
            (options.form.form === "normal" &&
              offer.unavailable === undefined &&
              (offer.feature === "browserUse" || offer.feature === "computerUse")),
        )
  if (preview === undefined && offers.length === 0 && combined === undefined) return line
  // With no T3 work the capability rows are all the screen would hold; a scripted run has nothing
  // to explain then, as before the rows existed.
  if (fallbackReason !== undefined) return preview === undefined ? line : fallback(fallbackReason)
  const load =
    options.load ??
    (options.t3Workflow
      ? () => loadPackagedSetupTui()
      : (env, notify) => loadSetupTui(env, { notify }))
  const loaded = yield* load(options.env, options.notify).pipe(
    Effect.catchTag("TuiUnavailable", (error) => Effect.succeed(error)),
  )
  const fail = options.t3Workflow ? stopped : fallback
  if (loaded instanceof TuiUnavailable) return fail(`unavailable (${loaded.reason})`)
  const initialSwitches = features === undefined ? {} : features
  const piAvailable = piUsed && config?.pi.enable === true
  const providerChoices =
    piAvailable &&
    config !== undefined &&
    (combined !== undefined || options.previewPi !== undefined)
      ? { provider: config.pi.provider, providers: enabledPiProviders(config) }
      : undefined
  const withProviderChanges = (choices: Choices): Choices => {
    const selection = choices.piProviders
    return selection !== undefined &&
      providerChoices !== undefined &&
      selection.provider === providerChoices.provider &&
      selection.providers.length === providerChoices.providers.length &&
      selection.providers.every((provider) => providerChoices.providers.includes(provider))
      ? {
          worktrees: choices.worktrees,
          deviceAccess: choices.deviceAccess,
          capabilities: choices.capabilities,
          ...(choices.harnesses === undefined ? {} : { harnesses: choices.harnesses }),
        }
      : choices
  }
  const failedReport = (report: Report) =>
    new Error(report.lines.filter((entry) => entry.startsWith("!")).join(" ") || "preflight failed")
  const selectionOf = (choices: Choices) =>
    (["pi", "claude"] as const).filter((target) => choices.harnesses?.[target] === true)
  const label = (target: "pi" | "claude") => (target === "pi" ? "Pi / T3 Code" : "Claude Code")
  let applyStarted = false
  let reviewedChoices: Choices | undefined
  let reviewSequence = 0
  let reviewedReplacement: string | undefined
  const replacementOf = (report: Report) =>
    report.lines.find((line) => line.startsWith("+ pi package: replace "))
  const input: TuiInput = {
    env: options.env,
    offer: {
      ...offerOf(preview, offers, options.form),
      ...(providerChoices === undefined ? {} : { providers: PiProvider.literals }),
      ...(combined === undefined ? {} : { harnesses: { piAvailable, scope: options.scope } }),
    },
    initial: {
      ...DEFAULT_CHOICES,
      capabilities: initialSwitches,
      ...(providerChoices === undefined ? {} : { piProviders: providerChoices }),
      ...(combined === undefined ? {} : { harnesses: { pi: piAvailable, claude: false } }),
    },
    dryRun: options.dryRun,
    review: (choices) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (combined !== undefined) {
            const sequence = ++reviewSequence
            reviewedChoices = undefined
            const targets = selectionOf(choices)
            if (targets.length === 0)
              return yield* Effect.fail(new Error("Enable at least one available harness."))
            if (targets.includes("pi") && !piAvailable)
              return yield* Effect.fail(new Error("Pi is not available for setup here."))
            const changed = changedSwitches(initialSwitches, choices.capabilities)
            const plans = yield* Effect.forEach(targets, (target, index) =>
              combined
                .run(target, withProviderChanges(choices), changed, true, index > 0, true)
                .pipe(Effect.map((report) => ({ name: label(target), ...report }))),
            )
            const error = plans.find((plan) => !plan.ok)
            if (error !== undefined)
              return yield* Effect.fail(
                new Error(
                  `${error.name}: ${error.lines.filter((entry) => entry.startsWith("!")).join(" ") || "preflight failed"}`,
                ),
              )
            const replacement = plans.flatMap((plan) => replacementOf(plan) ?? [])[0]
            if (sequence === reviewSequence) {
              reviewedChoices = choices
              reviewedReplacement = replacement
            }
            return {
              replacePiRegistration: replacement !== undefined,
              file: undefined,
              choices: [],
              always: [],
              harnesses: plans.map(({ name, lines }) => ({ name, lines })),
            } satisfies Review
          }
          const chosen = withProviderChanges(choices)
          if (options.previewPi !== undefined) {
            const sequence = ++reviewSequence
            reviewedChoices = undefined
            const report = yield* options.previewPi(
              chosen,
              changedSwitches(initialSwitches, choices.capabilities),
            )
            if (!report.ok) return yield* Effect.fail(failedReport(report))
            const replacement = replacementOf(report)
            if (sequence === reviewSequence) {
              reviewedChoices = choices
              reviewedReplacement = replacement
            }
            if (replacement !== undefined || chosen.piProviders !== undefined)
              return {
                replacePiRegistration: replacement !== undefined,
                file: undefined,
                choices: [],
                always: [],
                harnesses: [{ name: label("pi"), lines: report.lines }],
              } satisfies Review
          }
          const next =
            preview === undefined
              ? undefined
              : yield* previewT3Settings(options.env, options.cwd, {
                  ...choices,
                  ...(config === undefined ? {} : { config }),
                })
          if (preview !== undefined && (next === undefined || "line" in next))
            return yield* Effect.fail(new Error("the T3 settings step has nothing to do any more"))
          return reviewOf(
            next === undefined || "line" in next ? undefined : next,
            choices,
            capabilityReview(initialSwitches, choices.capabilities, options.form),
          )
        }),
      ),
    apply: (choices, signal) => {
      const chosen = withProviderChanges(choices)
      if (
        (combined !== undefined || chosen.piProviders !== undefined) &&
        reviewedChoices !== choices
      )
        return Effect.runPromise(
          Effect.fail(new Error("Review the current harness selection before applying.")),
        )
      const replacement = reviewedChoices === choices ? reviewedReplacement : undefined
      reviewedChoices = undefined
      reviewedReplacement = undefined
      applyStarted = true
      const changed = changedSwitches(initialSwitches, choices.capabilities)
      const confirmReplacement = (report: Report) =>
        report.ok && replacementOf(report) === replacement
          ? Effect.void
          : Effect.fail(
              new Error(
                "The Pi package plan changed. Review it again before replacing the previous registration.",
              ),
            )
      const applySingle = options.apply(chosen, changed, replacement !== undefined)
      return Effect.runPromise(
        combined === undefined
          ? replacement === undefined || options.previewPi === undefined
            ? applySingle
            : options
                .previewPi(chosen, changed)
                .pipe(Effect.flatMap(confirmReplacement), Effect.andThen(applySingle))
          : Effect.forEach(selectionOf(choices), (target, index) => {
              const replace = target === "pi" && replacement !== undefined
              const perform = combined.run(
                target,
                chosen,
                changed,
                options.dryRun,
                index > 0,
                replace,
              )
              return replace
                ? combined
                    .run(target, chosen, changed, true, index > 0, true)
                    .pipe(Effect.flatMap(confirmReplacement), Effect.andThen(perform))
                : perform
            }).pipe(
              Effect.map((reports) => ({
                ok: reports.length > 0 && reports.every(({ ok }) => ok),
                lines: reports.flatMap(({ lines }) => lines),
              })),
            ),
        { signal },
      )
    },
  }
  return yield* Effect.tryPromise({
    try: () => loaded.runSetupTui(input),
    catch: (cause) => cause,
  }).pipe(
    Effect.flatMap(decodeOutcome),
    Effect.map((outcome): Interactive => {
      if (outcome._tag === "Applied") {
        const applied: Applied = outcome.applied
        return {
          kind: options.t3Workflow === true ? "applied" : "done",
          report: { lines: applied.lines, ok: applied.ok },
        }
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
    Effect.catch((cause) => {
      const detail = oneLine(cause)
      if (applyStarted) return Effect.succeed(stopped(`failed (${detail})`, true))
      return Effect.succeed(fail(`failed to start (${detail})`))
    }),
  )
})

const oneLine = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).trim().split("\n")[0] ?? ""
