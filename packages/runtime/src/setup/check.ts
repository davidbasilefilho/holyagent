import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import { type Env, userFiles } from "./environment.ts"
import { missingSettingKeys } from "./settings.ts"
import { findCommand } from "./shell.ts"

/**
 * The one line a SessionStart hook adds when HolyAgent's setup is incomplete, or undefined when it
 * is complete. It looks for `ctx7` on the search path (and in Bun's global bin directory, where
 * `bun add -g` puts it) and for the recommended keys of the user settings. It reads files and looks
 * commands up and nothing more: no process is spawned, nothing is installed and nothing is written.
 * In a claude.ai cloud session it says nothing, because setup leaves ctx7 out there and the session
 * has no user settings to complete. A file that is not a JSON object is not reported, since setup
 * cannot repair it.
 */
export const setupNotice = (env: Env): Effect.Effect<string | undefined> => {
  if (inCloudSession(env)) return Effect.succeed(undefined)
  const missing = Option.isNone(findCommand(env, "ctx7", { includeBunBin: true })) ? ["ctx7"] : []
  return missingSettingKeys(userFiles(env).settings).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.map((keys) => {
      const lacking = [...missing, ...(keys.length === 0 ? [] : ["user settings keys"])]
      return lacking.length === 0
        ? undefined
        : `holyagent: setup is incomplete (missing ${lacking.join(", ")}). Offer the user to run /holyagent:setup, which installs and configures; do not run it unasked.`
    }),
  )
}
