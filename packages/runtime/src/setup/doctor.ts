import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import { type Env, userFiles } from "./environment.ts"
import { findLeftovers } from "./leftovers.ts"
import { type Report } from "./report.ts"
import { mergeUserSettings, missingSettingKeys } from "./settings.ts"
import { Shell } from "./shell.ts"
import { asStep, installCtx7 } from "./steps.ts"

const FIX = "run /holyagent:setup, or `holyagent doctor --fix`"

const pass = (name: string, detail: string) => `ok   ${name}: ${detail}`
const fail = (name: string, detail: string) => `FAIL ${name}: ${detail}`
const warn = (name: string, detail: string) => `warn ${name}: ${detail}`

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

const checkSettings = (env: Env) =>
  missingSettingKeys(env).pipe(
    Effect.map((missing) =>
      missing.length === 0
        ? pass("settings", userFiles(env).settings)
        : fail("settings", `${userFiles(env).settings} lacks ${missing.join(", ")}; ${FIX}`),
    ),
    Effect.catchTag("SetupFailure", (error) => Effect.succeed(fail("settings", error.message))),
  )

/**
 * Warns when an earlier Billion Context setup left entries in the Claude Code files, and when a
 * file could not be read, because then its entries were not checked.
 */
const checkLeftovers = (env: Env) =>
  findLeftovers(userFiles(env)).pipe(
    Effect.map((leftovers) => {
      const notes = [
        ...(leftovers.found.length === 0
          ? []
          : [
              `${leftovers.found.length} leftover(s) from an earlier setup: ${leftovers.found.join("; ")}; run /holyagent:setup`,
            ]),
        ...(leftovers.unreadable.length === 0
          ? []
          : [`not checked, ${leftovers.unreadable.join("; ")}`]),
      ]
      return notes.length === 0
        ? pass("billion-context", "no leftovers from an earlier setup")
        : warn("billion-context", notes.join(" | "))
    }),
  )

const checks = (env: Env) =>
  Effect.all([checkBun, checkCommand(env, "ctx7"), checkSettings(env), checkLeftovers(env)])

/**
 * Checks the environment HolyAgent needs, one line per check: `bun` and `ctx7` on PATH, the
 * recommended keys of the user settings (not those of a project), and leftovers of an earlier
 * Billion Context setup (a warning, not a failure). In a claude.ai cloud session `ctx7` passes,
 * since setup leaves it out there. With `fix`, the setup steps behind a failing check run first,
 * their lines come before the checks, and the checks then run again; Bun is never installed, and
 * leftovers are removed by `holyagent setup`, not here. The report is ok when no check fails.
 */
export const doctor = Effect.fn("doctor")(function* (env: Env, options: { readonly fix: boolean }) {
  const before = yield* checks(env)
  const failing = (name: string) => before.some((line) => line.startsWith(`FAIL ${name}:`))
  const fixes =
    options.fix && !inCloudSession(env)
      ? [...(failing("ctx7") ? yield* asStep("ctx7", installCtx7(env, false)) : [])]
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
