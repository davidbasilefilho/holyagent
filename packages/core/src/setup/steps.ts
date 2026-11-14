import { Effect, Option } from "effect"

import { CAPABILITIES } from "../config/capabilities.ts"
import { inCloudSession } from "../vcs/identity.ts"
import { reportBrowserUse } from "./browser-use.ts"
import { applyCapabilityChoices } from "./capabilities.ts"
import { type Env, homeDirectory } from "./environment.ts"
import type { SetupFailure } from "./errors.ts"
import { DEFAULT_FORM_CHOICE, describeForm, type FormChoice } from "./form.ts"
import { type CapabilityChoices, piInUse } from "./pi-check.ts"
import { installPiPackages } from "./pi-install.ts"
import { installPiToolSettings, undoPiToolSettings } from "./pi-settings.ts"
import { added, failed, hint, present, type Report, skipped } from "./report.ts"
import { type Scope, settingsFile } from "./scope.ts"
import { searchToolLines, setupToolLine } from "./search-tools.ts"
import { type CacheTtl, mergeUserSettings, undoUserSettings } from "./settings.ts"
import { EMPTY_BUNFIG, Shell } from "./shell.ts"
import { installT3Settings, undoT3Settings } from "./t3-settings.ts"

/** Why ctx7 is left out of a claude.ai cloud session. */
const CLOUD_SKIP =
  "skipped in a claude.ai cloud session (CLAUDE_CODE_REMOTE=true), which has no machine of yours to install it on"

/**
 * The directory every setup child runs in: the home directory, not the process directory, which is
 * the user's project and may hold a .npmrc, bunfig.toml or .env that would steer an install.
 */
const neutralDirectory = (env: Env) => homeDirectory(env)

/**
 * Installs a command with `bun add -g` unless it is already available. Returns the report lines and
 * whether the command can be used afterwards (on a dry run, whether it would be).
 */
const ensureGlobal = Effect.fn("ensureGlobal")(function* (
  env: Env,
  command: string,
  packageName: string,
  dryRun: boolean,
) {
  const shell = yield* Shell
  if (Option.isSome(yield* shell.which(command, { includeBunBin: true }))) {
    return { usable: true, lines: [present(`${command}: already installed`)] }
  }
  if (dryRun) {
    return {
      usable: true,
      lines: [added(`${command}: would install with bun add -g ${packageName}`)],
    }
  }
  // Bun reads no .env and the empty config, so a project's own files cannot redirect the install.
  const result = yield* shell.run(
    "bun",
    ["--no-env-file", `--config=${EMPTY_BUNFIG}`, "add", "-g", packageName],
    { cwd: neutralDirectory(env) },
  )
  if (result.exitCode !== 0)
    return { usable: false, lines: [failed(`bun add -g ${packageName}`, result)] }
  const lines = [added(`${command}: installed with bun add -g ${packageName}`)]
  const onPath = yield* shell.which(command)
  const anywhere = yield* shell.which(command, { includeBunBin: true })
  if (Option.isNone(onPath) && Option.isSome(anywhere)) {
    lines.push(hint(`${command}: ${anywhere.value} is not on PATH; add its directory to PATH`))
  }
  return { usable: true, lines }
})

/** Install the Context7 CLI without installing external instructions or accessing credentials. */
export const installCtx7 = Effect.fn("installCtx7")(function* (env: Env, dryRun: boolean) {
  const result = yield* ensureGlobal(env, "ctx7", "ctx7", dryRun)
  return result.lines
})

/** Turns a step that cannot finish (an unreadable settings file) into a failed line, not an abort. */
export const asStep = <R>(
  label: string,
  step: Effect.Effect<ReadonlyArray<string>, SetupFailure, R>,
) =>
  step.pipe(
    Effect.catchTag("SetupFailure", (error) => Effect.succeed([`! ${label}: ${error.message}`])),
  )

/** What `holyagent setup` was asked to do. */
export interface SetupOptions {
  readonly subagentCacheTtl: CacheTtl
  readonly dryRun: boolean
  readonly skipCtx7: boolean
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
  /**
   * The capabilities the run switches on or off, by `pi.features` key (see
   * `applyCapabilityChoices`).
   */
  readonly capabilities?: CapabilityChoices
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
    form: form.form,
    choices,
  }
  if (options.undo === true) {
    const lines = [
      hint("ctx7: left installed; --undo only removes the settings setup recorded adding"),
      ...(yield* onSettings((file) => undoUserSettings({ env, file, dryRun: options.dryRun }))),
      // Only files with a setup record get a line, so a machine that never ran the step prints none.
      ...(yield* asStep("tool settings", undoPiToolSettings(env, piOptions))),
      // T3 Code's settings are the user's, whatever scope was asked for; the step undoes at scope user.
      ...(scope === "user"
        ? yield* asStep("t3 settings", undoT3Settings(env, { dryRun: options.dryRun }))
        : []),
    ]
    return { lines, ok: !lines.some((line) => line.startsWith("! ")) } satisfies Report
  }
  const cloud = inCloudSession(env)
  const piUsed = !cloud && (yield* piInUse(env))
  const ctx7Lines = options.skipCtx7
    ? [skipped("ctx7: skipped by flag")]
    : cloud
      ? [skipped(`ctx7: ${CLOUD_SKIP}`)]
      : yield* asStep("ctx7", installCtx7(env, options.dryRun))
  const capabilityLines = piUsed
    ? yield* asStep(
        "capabilities",
        applyCapabilityChoices(env, {
          scope,
          cwd: piOptions.cwd,
          dryRun: options.dryRun,
          choices,
        }),
      )
    : Object.keys(choices).length > 0
      ? [skipped("capabilities: Pi is not in use, so the capability choices were not applied")]
      : []
  // The Pi steps plan from the choices laid over the config, so when they could not be saved those
  // steps stop: a package must not change without the config that explains it.
  const piSteps = piUsed && !capabilityLines.some((line) => line.startsWith("! "))
  const lines = [
    ...ctx7Lines,
    ...(piUsed ? [hint(`form: ${describeForm(form)}`)] : []),
    ...capabilityLines,
    ...(piUsed && !piSteps
      ? [
          skipped(
            `pi packages, tool settings and t3 settings: not run, because the choice for ${CAPABILITIES.filter(
              (capability) => choices[capability.feature] !== undefined,
            )
              .map((capability) => capability.name)
              .join(", ")} was not saved`,
          ),
        ]
      : []),
    ...(piSteps ? yield* asStep("pi packages", installPiPackages(env, piOptions)) : []),
    ...(piSteps ? yield* asStep("tool settings", installPiToolSettings(env, piOptions)) : []),
    ...(piSteps ? yield* asStep("browser use", reportBrowserUse(env, piOptions)) : []),
    // T3 Code's server settings are the user's own, so the step runs at scope user only.
    ...(piSteps && scope === "user"
      ? yield* asStep(
          "t3 settings",
          installT3Settings(env, piOptions.cwd, {
            dryRun: options.dryRun,
            ...(options.worktrees === undefined ? {} : { worktrees: options.worktrees }),
            ...(options.deviceAccess === undefined ? {} : { deviceAccess: options.deviceAccess }),
          }),
        )
      : []),
    ...(yield* searchToolLines(piOptions.cwd, setupToolLine)),
    ...(yield* onSettings((file) =>
      mergeUserSettings({
        env,
        file,
        subagentCacheTtl: options.subagentCacheTtl,
        dryRun: options.dryRun,
      }),
    )),
  ]
  return { lines, ok: !lines.some((line) => line.startsWith("! ")) } satisfies Report
})
