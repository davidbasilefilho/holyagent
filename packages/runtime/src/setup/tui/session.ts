import { Effect, Schema } from "effect"

import { enabledPiProviders } from "../../../../core/src/pi/provider.ts"
import {
  checkBrowserExecutable,
  discoverBrowsers,
  systemDefaultBrowser,
} from "../../../../core/src/setup/browser-discovery.ts"
import {
  type PiRegistrationConflict,
  PiRegistrationReview,
} from "../../../../core/src/setup/pi-install.ts"
import { SetupProgress } from "../../../../core/src/setup/progress.ts"
import {
  CAPABILITIES,
  type CapabilityDefinition,
  formContent,
  unavailableIn,
} from "../../config/capabilities.ts"
import { type Config, PiProvider } from "../../config/schema.ts"
import { inCloudSession } from "../../vcs/identity.ts"
import {
  type BrowsePair,
  type BrowsePlan,
  type BrowseTarget,
  browseReview,
  configureBrowse,
  pairBrowseOnTerminal,
  planBrowse,
} from "../browse-setup.ts"
import { BROWSE_EXTENSION_STORE } from "../browse.ts"
import { readBrowserPreference, writeBrowserPreference } from "../browser-preferences.ts"
import {
  type CodexBrowserChoice,
  detectCodexBrowserHandoff,
  openCodexBrowserHandoff,
} from "../codex-browser-handoff.ts"
import type { Env } from "../environment.ts"
import { SetupFailure } from "../errors.ts"
import { describeForm, type FormChoice, inCi } from "../form.ts"
import { type CapabilityChoices, loadPiConfigSource, piInUse } from "../pi-check.ts"
import { hint, type Report } from "../report.ts"
import type { Scope } from "../scope.ts"
import type { Shell } from "../shell.ts"
import { previewT3Settings, type T3Preview, type T3UnitPreview } from "../t3-settings.ts"
import { loadPackagedSetupTui, loadSetupTui, plain, TuiUnavailable } from "./load.ts"
import {
  type Applied,
  type BrowserOption,
  type CapabilityOffer,
  type Choices,
  type Offer,
  type Review,
  type ReviewLine,
  type SetupDisplayProgress,
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
              "T3 Device Simulator",
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
  /** Available only on public Pi setup; uses the runner that installed the public CLI. */
  readonly browse?: {
    readonly packageRoot: string | undefined
    readonly executable?: string
    readonly pair?: BrowsePair
  }
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
    readonly codexHome?: string
    readonly onlyCodex?: boolean
    readonly run: (
      target: "pi" | "claude" | "codex",
      choices: Choices,
      capabilities: CapabilityChoices,
      dryRun: boolean,
      skipSharedPrerequisites: boolean,
      replacePiRegistration: boolean,
      checkReviewedPlan?: boolean,
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
const BROWSE_HANDOFF = "OpenCode Browse: close this screen to "
const CODEX_BROWSER_HANDOFF = "ChatGPT browser extension: close this screen to open "

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
  const onlyCodex = options.combined?.onlyCodex === true
  const piUsed = onlyCodex ? false : yield* piInUse(options.env)
  if (!piUsed && combined === undefined) return line
  // Loaded once for the run: a config that cannot be read is reported by the line-based Pi steps,
  // which then run.
  const source = onlyCodex
    ? undefined
    : yield* loadPiConfigSource(options.env, options.cwd, options.scope).pipe(
        Effect.orElseSucceed(() => undefined),
      )
  const config = source?.config
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
  const initialSwitches = features === undefined ? {} : features
  const piAvailable = piUsed && config?.pi.enable === true
  const browse =
    options.browse !== undefined &&
    piAvailable &&
    config.pi.features.mcp === true &&
    options.form.form === "normal" &&
    offers.some(({ feature }) => feature === "browserUse")
      ? yield* planBrowse(options.env, options.browse.packageRoot)
      : undefined
  const desktopOptions = { cwd: options.cwd }
  const detectDesktop = combined?.codexHome !== undefined && options.form.form === "normal"
  const detected =
    browse === undefined && !detectDesktop ? [] : yield* discoverBrowsers(options.env)
  const explicit = options.browse?.executable
  const manual =
    browse === undefined || explicit === undefined
      ? undefined
      : yield* checkBrowserExecutable(options.env, explicit)
  const browsers =
    manual === undefined ? detected : [...detected.filter(({ id }) => id !== manual.id), manual]
  const preference =
    browse === undefined
      ? undefined
      : yield* readBrowserPreference(options.env).pipe(
          Effect.catchTag("SetupFailure", (error) => Effect.succeed(error)),
        )
  const defaultBrowser =
    preference !== undefined &&
    !(preference instanceof SetupFailure) &&
    preference.browsers === undefined
      ? yield* systemDefaultBrowser(options.env, options.cwd, detected)
      : undefined
  const initialBrowsers =
    preference === undefined
      ? undefined
      : preference instanceof SetupFailure
        ? []
        : (preference.browsers ?? (defaultBrowser === undefined ? [] : [defaultBrowser]))
  const codexHandoff = detectDesktop
    ? yield* detectCodexBrowserHandoff(options.env, detected, desktopOptions)
    : undefined
  const desktop = codexHandoff?.desktop
  if (onlyCodex && desktop === undefined) return line
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
  const requestedHandoff = (choices: Choices) =>
    choices.harnesses?.codex === true && codexHandoff?.status === "candidate"
      ? codexHandoff.browsers.find(({ id }) => id === choices.codexBrowserHandoff)
      : undefined
  const browserOptions: ReadonlyArray<BrowserOption> = browsers.map(
    ({ id, name, browseCompatibility }) => ({ id, name, browseCompatibility }),
  )
  const selectedBrowsers = (choices: Choices) =>
    browserOptions.filter(
      ({ id, browseCompatibility }) =>
        browseCompatibility === "supported" && choices.browseBrowserIds?.includes(id),
    )
  const browserSelectionToSave = (choices: Choices) => {
    const chosen = choices.browseBrowserIds
    const enabled = choices.capabilities["browserUse"] === true
    const saved =
      preference !== undefined &&
      !(preference instanceof SetupFailure) &&
      preference.browsers !== undefined
    return options.scope === "user" &&
      choices.harnesses?.pi !== false &&
      (enabled || saved) &&
      preference !== undefined &&
      initialBrowsers !== undefined &&
      chosen !== undefined &&
      ((enabled && !(preference instanceof SetupFailure) && !saved) ||
        chosen.length !== initialBrowsers.length ||
        chosen.some((id) => !initialBrowsers.includes(id)))
      ? chosen
      : undefined
  }
  const browseFor = (choices: Choices): BrowsePlan | undefined => {
    if (
      browse === undefined ||
      choices.harnesses?.pi === false ||
      choices.capabilities["browserUse"] !== true
    )
      return undefined
    const selected = selectedBrowsers(choices)
    if (selected.length === 0) return undefined
    const requested = browse.profiles?.[choices.browseProfile ?? -1]
    const targets = selected.map(({ name }): BrowseTarget => {
      const profile =
        requested?.browser === name
          ? requested
          : browse.profiles?.find(({ browser }) => browser === name)
      const target = profile === undefined ? name : `${name}, ${profile.profile}`
      if (profile?.extension === "enabled") {
        if (browse.alreadyPaired === true)
          return {
            target,
            next: "manual",
            guidance: `keep existing pairings. Check browse pair --list, then run ${browse.command ?? "the official browse pair command"} only for a profile not yet paired`,
          }
        return { target, next: "pair" }
      }
      return {
        target,
        next: "extension",
        guidance:
          profile?.extension === "disabled"
            ? "enable the existing Browse extension in this profile, then review setup again"
            : `add the official Browse extension from ${BROWSE_EXTENSION_STORE}, then review setup again`,
      }
    })
    const ready = targets.find(({ next }) => next === "pair")
    return {
      ...browse,
      targets,
      ...(ready === undefined ? {} : { next: "pair", target: ready.target }),
    }
  }
  const providerChoices =
    piAvailable &&
    config !== undefined &&
    (combined !== undefined || options.previewPi !== undefined)
      ? {
          providers:
            source?.written.pi?.provider === undefined &&
            source?.written.pi?.providers === undefined
              ? [
                  ...new Set(
                    Object.values(source?.written.pi?.routes ?? {}).flatMap((route) =>
                      route.provider === undefined ? [] : [route.provider],
                    ),
                  ),
                ]
              : enabledPiProviders(config),
        }
      : undefined
  const withProviderChanges = (choices: Choices): Choices => {
    const selection = choices.piProviders
    if (
      selection !== undefined &&
      providerChoices !== undefined &&
      selection.providers.length === providerChoices.providers.length &&
      selection.providers.every((provider) => providerChoices.providers.includes(provider))
    ) {
      const { piProviders: _unchanged, ...rest } = choices
      return rest
    }
    return choices
  }
  const failedReport = (report: Report) =>
    new Error(report.lines.filter((entry) => entry.startsWith("!")).join(" ") || "preflight failed")
  const selectionOf = (choices: Choices) =>
    (["pi", "claude", "codex"] as const).filter((target) => choices.harnesses?.[target] === true)
  const needsProvider = (choices: Choices) =>
    providerChoices !== undefined &&
    (combined === undefined || selectionOf(choices).includes("pi")) &&
    (choices.piProviders?.providers.length ?? 0) === 0
  const noProvider = () => new Error("Select at least one Pi model provider.")
  const label = (target: "pi" | "claude" | "codex") =>
    target === "pi" ? "Pi / T3 Code" : target === "claude" ? "Claude Code" : "Codex"
  let applyStarted = false
  let reviewedChoices: Choices | undefined
  let reviewSequence = 0
  let reviewedPi: PiRegistrationConflict | undefined
  let reviewedCodexConflict = false
  let stagedBrowse: BrowsePlan | undefined
  let stagedHandoff: CodexBrowserChoice | undefined
  const previewRegistration = (run: Effect.Effect<Report>) =>
    Effect.gen(function* () {
      let registration: PiRegistrationConflict | undefined
      const report = yield* run.pipe(
        Effect.provideService(PiRegistrationReview, {
          preview: (conflict) => {
            registration = conflict
          },
        }),
      )
      return { report, registration }
    })
  const piConflict = ({ file, prior, source }: PiRegistrationConflict) => ({
    harness: label("pi"),
    file: plain(file),
    detail: plain(
      `Replace ${JSON.stringify(prior)} with ${JSON.stringify(source)} and save the previous package entry.`,
    ),
  })
  const skippedConflicts = (target: "pi" | "codex") =>
    hint(`setup harness: ${label(target)} setup skipped to keep the current files and settings.`)
  const input: TuiInput = {
    env: options.env,
    offer: {
      ...offerOf(preview, offers, options.form),
      ...(browse === undefined
        ? {}
        : {
            browse: {
              state: plain(
                explicit !== undefined && manual === undefined
                  ? `${browse.state}. The supplied browser executable could not be verified.`
                  : browse.state,
              ),
              ...(browse.action === undefined ? {} : { action: browse.action }),
              ...(browse.profiles === undefined ? {} : { profiles: browse.profiles }),
              browsers: browserOptions,
            },
          }),
      ...(providerChoices === undefined ? {} : { providers: PiProvider.literals }),
      ...(combined === undefined
        ? {}
        : {
            harnesses: {
              piAvailable,
              scope: options.scope,
              ...(combined.codexHome === undefined ? {} : { codexHome: combined.codexHome }),
              ...(onlyCodex ? { onlyCodex: true } : {}),
              ...(desktop === undefined
                ? {}
                : {
                    codexDesktop: {
                      name: desktop.name,
                      ...(desktop.version === undefined ? {} : { version: desktop.version }),
                      ...(codexHandoff?.status === "candidate"
                        ? {
                            extensionBrowsers: codexHandoff.browsers.map(({ id, name }) => ({
                              id,
                              name,
                            })),
                          }
                        : {}),
                      ...(codexHandoff?.unavailableBrowsers === undefined
                        ? {}
                        : { extensionUnavailableBrowsers: codexHandoff.unavailableBrowsers }),
                    },
                  }),
            },
          }),
    },
    initial: {
      ...DEFAULT_CHOICES,
      capabilities: initialSwitches,
      ...(initialBrowsers === undefined ? {} : { browseBrowserIds: initialBrowsers }),
      ...(browse?.action === undefined || initialSwitches["browserUse"] !== true
        ? {}
        : { browseSetup: true }),
      ...(providerChoices === undefined ? {} : { piProviders: providerChoices }),
      ...(combined === undefined
        ? {}
        : {
            harnesses: {
              pi: piAvailable,
              claude: false,
              ...(combined.codexHome === undefined ? {} : { codex: onlyCodex }),
            },
          }),
    },
    dryRun: options.dryRun,
    review: (choices) =>
      Effect.runPromise(
        Effect.gen(function* () {
          if (needsProvider(choices)) {
            ++reviewSequence
            reviewedChoices = undefined
            return yield* Effect.fail(noProvider())
          }
          const sequence = ++reviewSequence
          const plan = browseFor(choices)
          const selection = selectedBrowsers(choices)
          const selectedNotes =
            browse === undefined ||
            choices.harnesses?.pi === false ||
            choices.capabilities["browserUse"] !== true
              ? []
              : [
                  hint(
                    `Browser Use: ${selection.length === 0 ? "no browser selected" : selection.map(({ name }) => name).join(", ")}`,
                  ),
                  ...(plan === undefined
                    ? [hint("OpenCode Browse: no compatible selected profile will be paired")]
                    : []),
                ]
          const browserReview =
            plan === undefined && selectedNotes.length === 0
              ? {}
              : {
                  browse: [
                    ...selectedNotes,
                    ...(plan === undefined
                      ? []
                      : browseReview(plan, choices.browseSetup === true, options.dryRun)),
                  ].map(plain),
                }
          if (combined !== undefined) {
            reviewedChoices = undefined
            const targets = selectionOf(choices)
            if (targets.length === 0)
              return yield* Effect.fail(new Error("Enable at least one available harness."))
            if (targets.includes("pi") && !piAvailable)
              return yield* Effect.fail(new Error("Pi is not available for setup here."))
            if (targets.includes("codex") && combined.codexHome === undefined)
              return yield* Effect.fail(new Error("Codex setup is not available here."))
            const handoff = requestedHandoff(choices)
            const changed = changedSwitches(initialSwitches, choices.capabilities)
            const plans = yield* Effect.forEach(targets, (target, index) =>
              previewRegistration(
                combined.run(target, withProviderChanges(choices), changed, true, index > 0, true),
              ).pipe(
                Effect.map(({ report, registration }) => ({
                  target,
                  registration,
                  conflicts: [
                    ...(registration === undefined ? [] : [piConflict(registration)]),
                    ...(report.managedConflicts ?? []).map(({ file, detail }) => ({
                      harness: label(target),
                      file: plain(file),
                      detail: plain(detail),
                    })),
                  ],
                  name: label(target),
                  ok: report.ok,
                  lines: [
                    ...report.lines,
                    ...(target !== "codex" || handoff === undefined
                      ? []
                      : [
                          hint(
                            `ChatGPT browser extension: ${options.dryRun ? "would open" : "open"} OpenAI's setup guide in ${handoff.name} after closing. No extension or approval is applied by setup.`,
                          ),
                        ]),
                  ],
                })),
              ),
            )
            const error = plans.find((plan) => !plan.ok)
            if (error !== undefined)
              return yield* Effect.fail(
                new Error(
                  `${error.name}: ${error.lines.filter((entry) => entry.startsWith("!")).join(" ") || "preflight failed"}`,
                ),
              )
            const registration = plans.find(({ target }) => target === "pi")?.registration
            const conflicts = plans.flatMap((plan) => plan.conflicts)
            if (sequence === reviewSequence) {
              reviewedChoices = choices
              reviewedPi = registration
              reviewedCodexConflict = plans.some(
                ({ target, conflicts }) => target === "codex" && conflicts.length > 0,
              )
            }
            return {
              file: undefined,
              choices: [],
              always: [],
              conflicts,
              ...(choices.keepManagedConflicts === true && registration !== undefined
                ? {}
                : browserReview),
              harnesses: plans.map(({ target, conflicts, name, lines }) => ({
                name,
                lines:
                  choices.keepManagedConflicts === true &&
                  target !== "claude" &&
                  conflicts.length > 0
                    ? [skippedConflicts(target)]
                    : lines,
              })),
            } satisfies Review
          }
          const chosen = withProviderChanges(choices)
          if (options.previewPi !== undefined) {
            reviewedChoices = undefined
            const { report, registration } = yield* previewRegistration(
              options.previewPi(chosen, changedSwitches(initialSwitches, choices.capabilities)),
            )
            if (!report.ok) return yield* Effect.fail(failedReport(report))
            if (sequence === reviewSequence) {
              reviewedChoices = choices
              reviewedPi = registration
            }
            if (registration !== undefined || chosen.piProviders !== undefined)
              return {
                file: undefined,
                choices: [],
                always: [],
                conflicts: registration === undefined ? [] : [piConflict(registration)],
                ...(choices.keepManagedConflicts === true && registration !== undefined
                  ? {}
                  : browserReview),
                harnesses: [
                  {
                    name: label("pi"),
                    lines:
                      choices.keepManagedConflicts === true && registration !== undefined
                        ? [skippedConflicts("pi")]
                        : report.lines,
                  },
                ],
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
          if (sequence === reviewSequence) reviewedChoices = choices
          return {
            ...reviewOf(
              next === undefined || "line" in next ? undefined : next,
              choices,
              capabilityReview(initialSwitches, choices.capabilities, options.form),
            ),
            ...browserReview,
          }
        }),
      ),
    apply: (choices, signal, reportProgress) => {
      if (needsProvider(choices)) return Effect.runPromise(Effect.fail(noProvider()))
      const chosen = withProviderChanges(choices)
      const browserChanges = browserSelectionToSave(choices)
      if (
        (combined !== undefined ||
          options.previewPi !== undefined ||
          chosen.piProviders !== undefined ||
          browserChanges !== undefined ||
          (choices.browseSetup === true && browseFor(choices)?.action !== undefined)) &&
        reviewedChoices !== choices
      )
        return Effect.runPromise(
          Effect.fail(new Error("Review the current harness selection before applying.")),
        )
      const registration = reviewedChoices === choices ? reviewedPi : undefined
      const codexConflict = reviewedChoices === choices && reviewedCodexConflict
      const keepPi = registration !== undefined && choices.keepManagedConflicts === true
      const keepCodex = codexConflict && choices.keepManagedConflicts === true
      const replacement = keepPi ? undefined : registration
      const plan = keepPi ? undefined : browseFor(choices)
      const wantsBrowse = plan?.action !== undefined && choices.browseSetup === true
      const handoff = keepCodex ? undefined : requestedHandoff(choices)
      reviewedChoices = undefined
      reviewedPi = undefined
      reviewedCodexConflict = false
      applyStarted = true
      const changed = changedSwitches(initialSwitches, choices.capabilities)
      const targets = selectionOf(choices).filter(
        (target) => !(target === "pi" && keepPi) && !(target === "codex" && keepCodex),
      )
      const validate = Effect.gen(function* () {
        if (!keepPi && browserChanges !== undefined && preference instanceof SetupFailure)
          return yield* Effect.fail(
            new Error("The saved HolyAgent browser selection is invalid. It was not changed."),
          )
        if (!keepPi) {
          const preview =
            combined === undefined
              ? options.previewPi?.(chosen, changed)
              : targets.includes("pi")
                ? combined.run("pi", chosen, changed, true, false, true)
                : undefined
          if (preview !== undefined) {
            const current = yield* previewRegistration(preview)
            if (!current.report.ok) return yield* Effect.fail(failedReport(current.report))
            if (current.registration?.fingerprint !== replacement?.fingerprint)
              return yield* Effect.fail(
                new Error("The Pi package plan changed. Review it again before applying."),
              )
          }
        }
        if (
          combined !== undefined &&
          targets.includes("codex") &&
          (codexConflict || targets.length > 1)
        ) {
          const current = yield* combined.run("codex", chosen, changed, true, false, false, true)
          if (!current.ok) return yield* Effect.fail(failedReport(current))
        }
      })
      const authorizedPi = (run: Effect.Effect<Report>) =>
        replacement === undefined
          ? run
          : run.pipe(
              Effect.provideService(PiRegistrationReview, { expected: replacement.fingerprint }),
            )
      const observed = (run: Effect.Effect<Report>, harness?: SetupDisplayProgress["harness"]) =>
        reportProgress === undefined
          ? run
          : run.pipe(
              Effect.provideService(SetupProgress, (phase) =>
                reportProgress({
                  ...(harness === undefined ? {} : { harness }),
                  phase:
                    phase.activity === undefined
                      ? phase
                      : { ...phase, activity: plain(phase.activity) },
                }),
              ),
            )
      const applySingle = keepPi
        ? Effect.succeed({ ok: true, lines: [skippedConflicts("pi")] })
        : observed(authorizedPi(options.apply(chosen, changed, replacement !== undefined)))
      return Effect.runPromise(
        validate.pipe(
          Effect.andThen(
            combined === undefined
              ? applySingle
              : Effect.forEach(targets, (target, index) => {
                  const harness = { index: index + 1, total: targets.length, label: label(target) }
                  const replace = target === "pi" && replacement !== undefined
                  const run = combined.run(
                    target,
                    chosen,
                    changed,
                    options.dryRun,
                    index > 0,
                    replace,
                  )
                  const perform = observed(replace ? authorizedPi(run) : run, harness)
                  return Effect.sync(() => reportProgress?.({ harness })).pipe(
                    Effect.andThen(perform),
                  )
                }).pipe(
                  Effect.map((reports) => ({
                    ok: reports.every(({ ok }) => ok),
                    lines: [
                      ...(keepPi ? [skippedConflicts("pi")] : []),
                      ...(keepCodex ? [skippedConflicts("codex")] : []),
                      ...reports.flatMap(({ lines }) => lines),
                    ],
                  })),
                ),
          ),
          Effect.flatMap((report) => {
            if (
              !report.ok ||
              options.dryRun ||
              keepPi ||
              browserChanges === undefined ||
              preference === undefined ||
              preference instanceof SetupFailure
            )
              return Effect.succeed(report)
            return writeBrowserPreference(preference, browserChanges).pipe(
              Effect.map(() => ({
                ...report,
                lines: [...report.lines, hint("Browser selection saved")],
              })),
              Effect.catchTag("SetupFailure", () =>
                Effect.succeed({
                  ok: false,
                  lines: [
                    ...report.lines,
                    "! Browser selection could not be saved. Existing selection was not replaced.",
                  ],
                }),
              ),
            )
          }),
          Effect.map((report): Applied => {
            if (report.ok && handoff !== undefined && !options.dryRun) stagedHandoff = handoff
            const lines = [
              ...report.lines,
              ...(handoff === undefined || !report.ok
                ? []
                : [
                    hint(
                      options.dryRun
                        ? `ChatGPT browser extension: would open OpenAI's guide in ${handoff.name}`
                        : `${CODEX_BROWSER_HANDOFF}OpenAI's guide in ${handoff.name}`,
                    ),
                  ]),
            ]
            if (plan === undefined || plan.action === undefined) return { ok: report.ok, lines }
            if (report.ok && wantsBrowse && !options.dryRun) stagedBrowse = plan
            return {
              ok: report.ok,
              lines: [
                ...lines,
                ...(options.dryRun
                  ? browseReview(plan, wantsBrowse, true)
                  : !wantsBrowse
                    ? [hint("OpenCode Browse: setup skipped; no Browse command ran")]
                    : report.ok
                      ? [
                          hint(
                            plan.next === "pair"
                              ? `${BROWSE_HANDOFF}start the official pairing command`
                              : `${BROWSE_HANDOFF}verify the pinned CLI`,
                          ),
                        ]
                      : []),
              ],
            }
          }),
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
    Effect.flatMap((outcome) =>
      Effect.gen(function* (): Effect.fn.Return<Interactive, never, Shell> {
        if (outcome._tag === "Applied") {
          const applied: Applied = outcome.applied
          const finishedBrowse =
            applied.ok && stagedBrowse !== undefined
              ? yield* options
                  .notify(
                    plain(
                      stagedBrowse.targets !== undefined && stagedBrowse.next === "pair"
                        ? "OpenCode Browse: verifying the pinned CLI, then pairing the reviewed profiles one at a time."
                        : stagedBrowse.next === "pair"
                          ? `OpenCode Browse: verifying the pinned CLI, then pairing ${stagedBrowse.target ?? "your browser"}.`
                          : "OpenCode Browse: verifying the pinned CLI.",
                    ),
                  )
                  .pipe(
                    Effect.andThen(
                      configureBrowse(
                        options.env,
                        stagedBrowse,
                        options.browse?.pair ?? pairBrowseOnTerminal,
                        options.notify,
                      ),
                    ),
                  )
              : { ok: true, lines: [] }
          const finishedHandoff =
            applied.ok && codexHandoff !== undefined && stagedHandoff !== undefined
              ? yield* openCodexBrowserHandoff(
                  options.env,
                  codexHandoff,
                  stagedHandoff.id,
                  desktopOptions,
                )
              : { ok: true, lines: [] }
          return {
            kind: options.t3Workflow === true ? "applied" : "done",
            report: {
              lines: [
                ...applied.lines.filter(
                  (line) =>
                    !line.startsWith(hint(BROWSE_HANDOFF)) &&
                    !line.startsWith(hint(CODEX_BROWSER_HANDOFF)),
                ),
                ...finishedBrowse.lines,
                ...finishedHandoff.lines,
              ],
              ok: applied.ok && finishedBrowse.ok && finishedHandoff.ok,
            },
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
    ),
    Effect.catch((cause) => {
      const detail = oneLine(cause)
      if (applyStarted) return Effect.succeed(stopped(`failed (${detail})`, true))
      return Effect.succeed(fail(`failed to start (${detail})`))
    }),
  )
})

const oneLine = (cause: unknown): string =>
  (cause instanceof Error ? cause.message : String(cause)).trim().split("\n")[0] ?? ""
