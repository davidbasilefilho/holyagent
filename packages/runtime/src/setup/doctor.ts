import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import { type Env, userFiles } from "./environment.ts"
import { type Report } from "./report.ts"
import { mergeUserSettings, missingSettingKeys } from "./settings.ts"
import { Shell } from "./shell.ts"
import { asStep, installBillionContext, installCtx7 } from "./steps.ts"

const FIX = "run /holyagent:setup, or `holyagent doctor --fix`"

const pass = (name: string, detail: string) => `ok   ${name}: ${detail}`
const fail = (name: string, detail: string) => `FAIL ${name}: ${detail}`

const checkBun = Effect.gen(function* () {
  const shell = yield* Shell
  const found = yield* shell.which("bun")
  return Option.isSome(found)
    ? pass("bun", found.value)
    : fail("bun", "not found on PATH; install Bun (https://bun.sh), which runs the plugin hooks")
})

/** A command setup installs: on PATH, or skipped by design in a claude.ai cloud session. */
const checkCommand = (env: Env, command: string) =>
  Effect.gen(function* () {
    if (inCloudSession(env))
      return pass(command, "not installed in a claude.ai cloud session, by design")
    const shell = yield* Shell
    const found = yield* shell.which(command)
    return Option.isSome(found)
      ? pass(command, found.value)
      : fail(command, `not found on PATH; ${FIX}`)
  })

const checkSettings = (env: Env) =>
  missingSettingKeys(env).pipe(
    Effect.map((missing) =>
      missing.length === 0
        ? pass("settings", userFiles(env).settings)
        : fail("settings", `${userFiles(env).settings} lacks ${missing.join(", ")}; ${FIX}`),
    ),
    Effect.catchTag("SetupFailure", (error) => Effect.succeed(fail("settings", error.message))),
  )

const checks = (env: Env) =>
  Effect.all([checkBun, checkCommand(env, "bili"), checkCommand(env, "ctx7"), checkSettings(env)])

/**
 * Checks the environment HolyAgent needs, one line per check: `bun`, `bili` and `ctx7` on PATH and
 * the recommended keys of the user settings (not those of a project). In a claude.ai cloud session
 * `bili` and `ctx7` pass, since setup leaves them out there. With `fix`, the setup steps behind a
 * failing check run first, their lines come before the checks, and the checks then run again; Bun
 * is never installed. The report is ok only when every check passes.
 */
export const doctor = Effect.fn("doctor")(function* (env: Env, options: { readonly fix: boolean }) {
  const before = yield* checks(env)
  const failing = (name: string) => before.some((line) => line.startsWith(`FAIL ${name}:`))
  const fixes =
    options.fix && !inCloudSession(env)
      ? [
          ...(failing("bili")
            ? yield* asStep("billion-context", installBillionContext(env, false))
            : []),
          ...(failing("ctx7") ? yield* asStep("ctx7", installCtx7(env, false)) : []),
        ]
      : []
  const settingsFixes =
    options.fix && failing("settings")
      ? yield* asStep(
          "user settings",
          mergeUserSettings(env, { subagentCacheTtl: "1h", dryRun: false }),
        )
      : []
  const ran = [...fixes, ...settingsFixes]
  const lines = ran.length === 0 ? before : [...ran, ...(yield* checks(env))]
  return { lines, ok: lines.every((line) => !line.startsWith("FAIL ")) } satisfies Report
})
