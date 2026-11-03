import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import { type Env, userFiles } from "./environment.ts"
import { projectSettingsFiles } from "./scope.ts"
import { missingSettingKeys } from "./settings.ts"
import { findCommand } from "./shell.ts"

/**
 * The one line a SessionStart hook adds when HolyAgent's setup is incomplete, or undefined when it
 * is complete. It looks for `ctx7` on the search path (and in Bun's global bin directory, where
 * `bun add -g` puts it) and for the recommended keys of the user settings, which the project and
 * local settings of the session's folder (`cwd`) count towards too, so the line stops once `setup
 * --scope project|local` has run there. It reads files and looks commands up and nothing more: no
 * process is spawned, nothing is installed and nothing is written. In a claude.ai cloud session it
 * says nothing, because setup leaves ctx7 out there and the session has no user settings to
 * complete. A file that is not a JSON object is not reported, since setup cannot repair it.
 */
export const setupNotice = (env: Env, cwd?: string): Effect.Effect<string | undefined> => {
  if (inCloudSession(env)) return Effect.succeed(undefined)
  const missing = Option.isNone(findCommand(env, "ctx7", { includeBunBin: true })) ? ["ctx7"] : []
  // A project or local file that cannot be read (or is no JSON object) adds nothing, so it never
  // hides a key; the user file that cannot be read silences the key check, as before.
  const lacking = (file: string) =>
    missingSettingKeys(file).pipe(
      Effect.map((keys): ReadonlyArray<string> | undefined => keys),
      Effect.orElseSucceed(() => undefined),
    )
  const missingKeys = Effect.gen(function* () {
    const user = yield* missingSettingKeys(userFiles(env).settings)
    if (cwd === undefined || user.length === 0) return user
    const others = yield* Effect.all((yield* projectSettingsFiles(cwd)).map(lacking))
    return user.filter((key) => others.every((keys) => keys === undefined || keys.includes(key)))
  })
  return missingKeys.pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.map((keys) => {
      const lacking = [...missing, ...(keys.length === 0 ? [] : ["user settings keys"])]
      return lacking.length === 0
        ? undefined
        : `holyagent: setup is incomplete (missing ${lacking.join(", ")}). Offer the user to run /holyagent:setup, which installs and configures; do not run it unasked.`
    }),
  )
}
