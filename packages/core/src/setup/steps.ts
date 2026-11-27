import { Effect, Option } from "effect"

import { CAPABILITIES } from "../config/capabilities.ts"
import type { PiProviderSelection } from "../config/schema.ts"
import { inCloudSession } from "../vcs/identity.ts"
import { reportBrowserUse } from "./browser-use.ts"
import { applyCapabilityChoices } from "./capabilities.ts"
import { CTX7_MISE_UNVERIFIED, lookupCtx7 } from "./context7.ts"
import { deviceToolchains } from "./device-toolchains.ts"
import { type Env, homeDirectory } from "./environment.ts"
import type { SetupFailure } from "./errors.ts"
import { DEFAULT_FORM_CHOICE, describeForm, type FormChoice } from "./form.ts"
import {
  type CapabilityChoices,
  loadPiConfig,
  piExecutionSurface,
  piInUse,
  usesStandaloneSearch,
} from "./pi-check.ts"
import { installPiPackages } from "./pi-install.ts"
import { installPiToolSettings, undoPiToolSettings } from "./pi-settings.ts"
import { reportSetupActivity, withSetupPhase } from "./progress.ts"
import { added, failed, hint, present, type Report, skipped } from "./report.ts"
import { type Scope, settingsFile } from "./scope.ts"
import { searchToolLines, setupToolLine } from "./search-tools.ts"
import { type CacheTtl, mergeUserSettings, undoUserSettings } from "./settings.ts"
import { EMPTY_BUNFIG, Shell } from "./shell.ts"
import {
  checkT3Prerequisites,
  devicePreparationRefusal,
  installT3Settings,
  undoT3Settings,
} from "./t3-settings.ts"

/** Why ctx7 is left out of a claude.ai cloud session. */
const CLOUD_SKIP =
  "skipped in a claude.ai cloud session (CLAUDE_CODE_REMOTE=true), which has no machine of yours to install it on"

/**
 * The directory every setup child runs in: the home directory, not the process directory, which is
 * the user's project and may hold a .npmrc, bunfig.toml or .env that would steer an install.
 */
const neutralDirectory = (env: Env) => homeDirectory(env)

/** Install the Context7 CLI without installing external instructions or accessing credentials. */
export const installCtx7 = Effect.fn("installCtx7")(function* (env: Env, dryRun: boolean) {
  const installed = yield* lookupCtx7(env)
  if (installed.kind === "mise")
    return [
      present(
        `ctx7: already installed with mise at ${installed.path} (not on PATH; add its directory to PATH)`,
      ),
    ]
  if (installed.kind === "unverified") return [`! ctx7: ${CTX7_MISE_UNVERIFIED}`]
  if (installed.kind === "path" || installed.kind === "bun")
    return [present("ctx7: already installed")]
  if (dryRun) return [added("ctx7: would install with bun add -g ctx7")]

  const shell = yield* Shell
  // Bun reads no .env and the empty config, so a project's own files cannot redirect the install.
  yield* reportSetupActivity("Installing ctx7")
  const result = yield* shell.run(
    "bun",
    ["--no-env-file", `--config=${EMPTY_BUNFIG}`, "add", "-g", "ctx7"],
    { cwd: neutralDirectory(env) },
  )
  if (result.exitCode !== 0) return [failed("bun add -g ctx7", result)]
  const lines = [added("ctx7: installed with bun add -g ctx7")]
  const onPath = yield* shell.which("ctx7")
  const anywhere = yield* shell.which("ctx7", { includeBunBin: true })
  if (Option.isNone(onPath) && Option.isSome(anywhere)) {
    lines.push(hint(`ctx7: ${anywhere.value} is not on PATH; add its directory to PATH`))
  }
  return lines
})

/** Turns a step that cannot finish (an unreadable settings file) into a failed line, not an abort. */
export const asStep = <R>(
  label: string,
  step: Effect.Effect<ReadonlyArray<string>, SetupFailure, R>,
) =>
  step.pipe(
    Effect.catchTag("SetupFailure", (error) => Effect.succeed([`! ${label}: ${error.message}`])),
  )

/** Harnesses that can be selected directly for setup. */
export const SETUP_TARGETS = ["pi", "claude"] as const

/** A directly selected setup harness. */
export type SetupTarget = (typeof SETUP_TARGETS)[number]

/** What `holyagent setup` was asked to do. */
export interface SetupOptions {
  readonly subagentCacheTtl: CacheTtl
  readonly dryRun: boolean
  readonly skipCtx7: boolean
  /** Run public T3 Code onboarding, not the internal Claude settings step. */
  readonly t3Workflow?: boolean
  /** Limit setup and undo to one harness. Omitted for legacy callers. */
  readonly target?: SetupTarget
  /** The installed public package location to register with Pi. */
  readonly installedPackageRoot?: string
  /** Only the interactive public review may opt into replacement. */
  readonly replacePiRegistration?: boolean
  /** The settings scope to write, `user` when absent. */
  readonly scope?: Scope
  /** Back out the settings setup wrote instead of writing them; ctx7 is left installed. */
  readonly undo?: boolean
  /** The directory a `project` or `local` scope is found from, the process directory when absent. */
  readonly cwd?: string
  /** Whether new T3 Code threads start in worktrees (see `installT3Settings`); `true` when absent. */
  readonly worktrees?: boolean
  /** Whether agents may use devices in T3 Code (see `installT3Settings`); `true` when absent. */
  readonly deviceAccess?: boolean
  /** Opt-in screenless support for device tools. Only apply mode can invoke installers. */
  readonly devicePreparation?: "preview" | "apply"
  /** The public entry separately performs and reports the requested desktop Browse handoff. */
  readonly desktopBrowseHandoff?: boolean
  /**
   * The capabilities the run switches on or off, by `pi.features` key (see
   * `applyCapabilityChoices`).
   */
  readonly capabilities?: CapabilityChoices
  /** Confirmed Pi model providers, omitted in unattended setup. */
  readonly piProviders?: PiProviderSelection
  /** The form every capability is applied in; the normal form when absent (see `chooseForm`). */
  readonly form?: FormChoice
}

/**
 * Sets up HolyAgent for the current user: ctx7, the capability choices of the run (written to the
 * HolyAgent config, {@link applyCapabilityChoices}), the Pi packages the config enables in the form
 * in force, the Pi tool settings, a report on browser use (the form, the unmet needs and whether a
 * browser is paired with browse; it changes nothing, {@link reportBrowserUse}) and, at scope `user`,
 * T3 Code's server settings ({@link installPiPackages}, {@link installPiToolSettings} and
 * {@link installT3Settings}; all only when Pi is in use, never in a cloud session), and the
 * recommended keys of the settings of the chosen scope (`user` unless set); a report on the `rg`
 * and `fd` the user installs ({@link searchToolLines}; it changes nothing and is never a failure)
 * comes before the settings lines. Every step checks its own result first, and a step that fails
 * does not stop the next one, except that when the capability choices cannot be saved the Pi
 * packages, tool settings and T3 steps are not run, so no package changes without the config that
 * explains it. On a dry run nothing is installed or written, and the lines say what would be. In a
 * claude.ai cloud session ctx7 is skipped, and the settings are still merged. With `undo` only
 * settings change: the values setup recorded adding are removed from the chosen scope's file and
 * from the Pi tool settings files ({@link undoPiToolSettings}) and T3's ({@link undoT3Settings});
 * ctx7 and the Pi packages stay installed. A `project` or `local` target that is a symlink is
 * refused with a `!` line and nothing is written to the settings.
 */
export const setup = Effect.fn("setup")(function* (env: Env, options: SetupOptions) {
  const scope = options.scope ?? "user"
  const label = `${scope} settings`
  const piOnly =
    options.target === "pi" || (options.target === undefined && options.t3Workflow === true)
  const includePi = options.target !== "claude"
  // A target that cannot be used (a symlink) is a failed settings step, not an abort.
  const onSettings = (
    run: (file: string) => Effect.Effect<ReadonlyArray<string>, SetupFailure, Shell>,
  ) =>
    asStep(
      label,
      Effect.gen(function* () {
        const target = yield* settingsFile(env, scope, options.cwd ?? process.cwd())
        const lines = yield* run(target.file)
        return target.notice === undefined ? lines : [hint(`${label}: ${target.notice}`), ...lines]
      }),
    )
  const choices = options.capabilities ?? {}
  const form = options.form ?? DEFAULT_FORM_CHOICE
  const piOptions = {
    scope,
    cwd: options.cwd ?? process.cwd(),
    dryRun: options.dryRun,
    ...(piOnly && options.installedPackageRoot !== undefined
      ? {
          installedPackageRoot: options.installedPackageRoot,
          ...(options.replacePiRegistration === true ? { replacePiRegistration: true } : {}),
        }
      : {}),
    form: form.form,
    choices,
    ...(options.piProviders === undefined ? {} : { providers: options.piProviders }),
  }
  if (options.undo === true) {
    const lines = [
      hint("ctx7: left installed; --undo only removes the settings setup recorded adding"),
      ...(piOnly
        ? []
        : yield* onSettings((file) => undoUserSettings({ env, file, dryRun: options.dryRun }))),
      // Only files with a setup record get a line, so a machine that never ran the step prints none.
      ...(includePi ? yield* asStep("tool settings", undoPiToolSettings(env, piOptions)) : []),
      // T3 Code's settings are the user's, whatever scope was asked for; the step undoes at scope user.
      ...(includePi && scope === "user"
        ? yield* asStep("t3 settings", undoT3Settings(env, { dryRun: options.dryRun }))
        : []),
    ]
    return { lines, ok: !lines.some((line) => line.startsWith("! ")) } satisfies Report
  }
  const cloud = inCloudSession(env)
  const piUsed = includePi && !cloud && (yield* piInUse(env))
  const surface = piExecutionSurface(env, piOnly ? "t3" : undefined)
  if (piOnly) {
    const blockers = yield* checkT3Prerequisites(env, piUsed)
    if (blockers.length > 0)
      return {
        lines: [
          ...blockers.map((line) => `! ${line}`),
          hint(
            "If you meant native Codex, see holyagent setup codex --help to prepare its profile before launch. Neither a package install nor a dry run activates the current session.",
          ),
        ],
        ok: false,
      } satisfies Report
  }
  // A failed capability write blocks the dependent phases. They remain in the plan but never
  // report progress as though they ran.
  let piSteps = true
  let deviceReadiness: string | null | undefined
  const whenPiSaved = () => piSteps
  const phase = (
    label: string,
    run: Effect.Effect<ReadonlyArray<string>, never, Shell>,
    runIf = () => true,
  ) => ({ label, run, runIf })
  const report = (lines: () => ReadonlyArray<string>) => ({ lines })
  const plan = [
    ...(options.skipCtx7
      ? [report(() => [skipped("ctx7: skipped by flag")])]
      : cloud
        ? [report(() => [skipped(`ctx7: ${CLOUD_SKIP}`)])]
        : [phase("Context7", asStep("ctx7", installCtx7(env, options.dryRun)))]),
    ...(piUsed
      ? [
          report(() => [hint(`form: ${describeForm(form)}`)]),
          phase(
            "Capability settings",
            asStep(
              "capabilities",
              applyCapabilityChoices(env, {
                scope,
                cwd: piOptions.cwd,
                dryRun: options.dryRun,
                choices,
                ...(options.piProviders === undefined ? {} : { providers: options.piProviders }),
              }),
            ).pipe(
              Effect.tap((lines) =>
                Effect.sync(() => {
                  piSteps = !lines.some((line) => line.startsWith("! "))
                }),
              ),
            ),
          ),
          report(() =>
            piSteps
              ? []
              : [
                  skipped(
                    `pi packages, tool settings and t3 settings: not run, because the choice for ${CAPABILITIES.filter(
                      (capability) => choices[capability.feature] !== undefined,
                    )
                      .map((capability) => capability.name)
                      .join(", ")} was not saved`,
                  ),
                ],
          ),
          phase(
            "Pi packages",
            asStep("pi packages", installPiPackages(env, piOptions)),
            whenPiSaved,
          ),
          phase(
            "Pi tool settings",
            asStep("tool settings", installPiToolSettings(env, piOptions)),
            whenPiSaved,
          ),
          phase(
            "Browser-use checks",
            asStep(
              "browser use",
              reportBrowserUse(env, {
                ...piOptions,
                surface,
                pairingHandledByCaller: options.desktopBrowseHandoff === true,
              }),
            ),
            whenPiSaved,
          ),
          // T3 Code's server settings are the user's own, so the step runs at scope user only.
          ...(scope === "user"
            ? [
                ...(piOnly &&
                options.deviceAccess === true &&
                options.devicePreparation !== undefined
                  ? [
                      phase(
                        "Device Simulator tools",
                        Effect.gen(function* () {
                          const config = yield* loadPiConfig(
                            env,
                            piOptions.cwd,
                            "user",
                            choices,
                            options.piProviders,
                          ).pipe(Effect.orElseSucceed(() => undefined))
                          if (
                            config?.pi.enable !== true ||
                            !config.pi.t3.deviceAccess ||
                            config.pi.t3.scope === "project"
                          )
                            return [
                              hint(
                                "Device Simulator: skipped by the existing Pi or T3 Code settings",
                              ),
                            ]
                          deviceReadiness = null
                          const t3 = yield* Effect.result(devicePreparationRefusal(env))
                          if (t3._tag === "Failure")
                            return [
                              hint(
                                "Device Simulator: not prepared because T3 Code settings could not be read",
                              ),
                            ]
                          if (t3.success !== undefined)
                            return [hint(`Device Simulator: ${t3.success}`)]
                          const mode =
                            options.dryRun || form.form !== "normal"
                              ? "preview"
                              : (options.devicePreparation ?? "preview")
                          const prepared = yield* deviceToolchains(env, {
                            mode,
                            cwd: piOptions.cwd,
                          })
                          deviceReadiness = prepared.ready ?? null
                          return prepared.lines
                        }),
                        whenPiSaved,
                      ),
                    ]
                  : []),
                phase(
                  "T3 Code settings",
                  asStep(
                    "t3 settings",
                    Effect.suspend(() =>
                      installT3Settings(env, piOptions.cwd, {
                        dryRun: options.dryRun,
                        ...(options.piProviders === undefined
                          ? {}
                          : { providers: options.piProviders }),
                        ...(options.worktrees === undefined
                          ? {}
                          : { worktrees: options.worktrees }),
                        ...(options.deviceAccess === undefined
                          ? {}
                          : { deviceAccess: options.deviceAccess }),
                        ...(deviceReadiness === undefined ? {} : { deviceReadiness }),
                      }),
                    ),
                  ),
                  whenPiSaved,
                ),
              ]
            : []),
        ]
      : Object.keys(choices).length === 0
        ? []
        : [
            report(() => [
              skipped("capabilities: Pi is not in use, so the capability choices were not applied"),
            ]),
          ]),
    ...(usesStandaloneSearch(env, piUsed, surface)
      ? [phase("Search-tool checks", searchToolLines(piOptions.cwd, setupToolLine))]
      : []),
    ...(piOnly
      ? []
      : [
          phase(
            "Claude Code settings",
            onSettings((file) =>
              mergeUserSettings({
                env,
                file,
                subagentCacheTtl: options.subagentCacheTtl,
                dryRun: options.dryRun,
              }),
            ),
          ),
        ]),
  ]
  const total = plan.filter((step) => "run" in step).length
  const lines: Array<string> = []
  let index = 0
  for (const step of plan) {
    if ("lines" in step) {
      lines.push(...step.lines())
      continue
    }
    index += 1
    if (step.runIf()) {
      lines.push(...(yield* withSetupPhase({ index, total, label: step.label }, step.run)))
    }
  }
  return { lines, ok: !lines.some((line) => line.startsWith("! ")) } satisfies Report
})
