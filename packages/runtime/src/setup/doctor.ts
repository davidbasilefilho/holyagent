import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import type { Env } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { DEFAULT_FORM_CHOICE, type FormChoice } from "./form.ts"
import { piChecks } from "./pi-check.ts"
import { checkPiToolSettings } from "./pi-settings.ts"
import { fail, hint, pass, type Report } from "./report.ts"
import { type Scope, settingsFile } from "./scope.ts"
import { doctorToolLine, searchToolLines } from "./search-tools.ts"
import { mergeUserSettings, missingSettingKeys } from "./settings.ts"
import { Shell } from "./shell.ts"
import { asStep, installCtx7 } from "./steps.ts"
import { checkT3Settings } from "./t3-settings.ts"

const FIX = "run /holyagent:setup, or `holyagent doctor --fix`"

const checkBun = Effect.gen(function* () {
  const shell = yield* Shell
  const found = yield* shell.which("bun")
  return Option.isSome(found)
    ? pass("bun", found.value)
    : fail("bun", "not found on PATH; install Bun (https://bun.sh), which runs the plugin hooks")
})

/**
 * A command setup installs: on PATH or in Bun's global bin directory (where setup and the
 * SessionStart check look too), or skipped by design in a claude.ai cloud session. A command found
 * only in Bun's bin directory passes with a hint to add that directory to PATH.
 */
const checkCommand = (env: Env, command: string) =>
  Effect.gen(function* () {
    if (inCloudSession(env))
      return pass(command, "not installed in a claude.ai cloud session, by design")
    const shell = yield* Shell
    const onPath = yield* shell.which(command)
    if (Option.isSome(onPath)) return pass(command, onPath.value)
    const anywhere = yield* shell.which(command, { includeBunBin: true })
    return Option.isSome(anywhere)
      ? pass(command, `${anywhere.value} (not on PATH; add its directory to PATH)`)
      : fail(command, `not found on PATH or in Bun's bin directory; ${FIX}`)
  })

/** The fix for failing settings; a scope other than user is named, or the fix would target user. */
const fixFor = (scope: Scope) =>
  scope === "user"
    ? FIX
    : `run /holyagent:setup --scope ${scope}, or \`holyagent doctor --fix --scope ${scope}\``

const checkSettings = (file: string, scope: Scope) =>
  missingSettingKeys(file).pipe(
    Effect.map((missing) =>
      missing.length === 0
        ? pass("settings", file)
        : fail("settings", `${file} lacks ${missing.join(", ")}; ${fixFor(scope)}`),
    ),
    Effect.catchTag("SetupFailure", (error) => Effect.succeed(fail("settings", error.message))),
  )

const checks = (env: Env, file: string, scope: Scope) =>
  Effect.all([checkBun, checkCommand(env, "ctx7"), checkSettings(file, scope)])

/**
 * Checks the environment HolyAgent needs, one line per check: `bun` and `ctx7` on PATH, the
 * recommended keys of the settings of the chosen scope (`user` unless set; `project` and `local`
 * are found from `cwd`, the process directory when absent), then the Pi checks of {@link piChecks}
 * (the form in force and each enabled capability's health included) when Pi is in use and
 * `pi.enable` is on in the HolyAgent config of that scope (the user's file for `user`, so a
 * repository's own config cannot change what doctor expects of the global install; the project's
 * over it for `project` and `local`). A machine without Pi gets one informational line instead, and
 * a cloud session runs no Pi. When Pi is in use, a `~` line follows for each Pi tool settings file
 * that lacks keys setup writes ({@link checkPiToolSettings}), and at scope `user` one line on T3
 * Code's settings when T3 is installed ({@link checkT3Settings}). In a claude.ai cloud session
 * `ctx7` passes, since setup leaves it out there. With `fix`, the setup steps behind a failing
 * check run first, their lines come before the checks, and the checks then run again; Bun, Pi, Node
 * and the Pi packages are never installed, so the Pi lines are read once and name the command that
 * fixes them. The last lines are those of the user-installed `rg` and `fd` that `holyagent rg` and
 * `holyagent fd` run ({@link searchToolLines}): a missing one is a `~` warning with the install
 * commands, never a failure, and `--fix` installs neither. The report is ok when no check fails.
 */
export const doctor = Effect.fn("doctor")(function* (
  env: Env,
  options: {
    readonly fix: boolean
    readonly scope?: Scope
    readonly cwd?: string
    /** The form every capability is checked in; the normal form when absent. */
    readonly form?: FormChoice
  },
) {
  const scope = options.scope ?? "user"
  const cwd = options.cwd ?? process.cwd()
  const form = options.form ?? DEFAULT_FORM_CHOICE
  const pi = inCloudSession(env)
    ? []
    : [
        ...(yield* piChecks(env, cwd, scope, form)),
        ...(yield* checkPiToolSettings(env, cwd, scope, form.form)),
        ...(scope === "user" ? yield* checkT3Settings(env, cwd) : []),
      ]
  const located = yield* settingsFile(env, scope, cwd).pipe(
    Effect.catchTag("SetupFailure", (error) => Effect.succeed(error)),
  )
  if (located instanceof SetupFailure) {
    // The target is refused (a symlink): report it as the failing settings check, fix nothing.
    const lines = yield* Effect.all([
      checkBun,
      checkCommand(env, "ctx7"),
      Effect.succeed(fail("settings", located.message)),
    ])
    return {
      lines: [...lines, ...pi, ...(yield* searchToolLines(cwd, doctorToolLine))],
      ok: false,
    } satisfies Report
  }
  const { file, notice } = located
  // Like setup, name a git top-level that was refused; the settings check names the file used.
  const noted = (lines: ReadonlyArray<string>) =>
    notice === undefined ? lines : [hint(`${scope} settings: ${notice}`), ...lines]
  const before = yield* checks(env, file, scope)
  const failing = (name: string) => before.some((line) => line.startsWith(`FAIL ${name}:`))
  const fixes =
    options.fix && !inCloudSession(env)
      ? [...(failing("ctx7") ? yield* asStep("ctx7", installCtx7(env, false)) : [])]
      : []
  const settingsFixes =
    options.fix && failing("settings")
      ? yield* asStep(
          `${scope} settings`,
          mergeUserSettings({ env, file, subagentCacheTtl: "1h", dryRun: false }),
        )
      : []
  const ran = [...fixes, ...settingsFixes]
  const lines = noted([
    ...(ran.length === 0 ? before : [...ran, ...(yield* checks(env, file, scope))]),
    ...pi,
    ...(yield* searchToolLines(cwd, doctorToolLine)),
  ])
  return { lines, ok: lines.every((line) => !line.startsWith("FAIL ")) } satisfies Report
})
