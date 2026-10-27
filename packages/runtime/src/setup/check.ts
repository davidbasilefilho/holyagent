import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import type { Env } from "./environment.ts"
import { missingSettingKeys } from "./settings.ts"
import { findCommand } from "./shell.ts"

/**
 * The one line a SessionStart hook adds when HolyAgent's setup is incomplete, or undefined when it
 * is complete. It looks for `bili` and `ctx7` on the search path (and in Bun's global bin
 * directory, where `bun add -g` puts them) and for the recommended keys of the user settings. It
 * reads files and looks commands up and nothing more: no process is spawned, nothing is installed
 * and nothing is written. In a claude.ai cloud session it says nothing, because setup leaves
 * Billion Context and ctx7 out there and the session has no user settings to complete. A settings
 * file that is not a JSON object is not reported, since setup cannot repair it.
 */
export const setupNotice = (env: Env): Effect.Effect<string | undefined> => {
  if (inCloudSession(env)) return Effect.succeed(undefined)
  const missing = [
    ...(Option.isNone(findCommand(env, "bili", { includeBunBin: true })) ? ["bili"] : []),
    ...(Option.isNone(findCommand(env, "ctx7", { includeBunBin: true })) ? ["ctx7"] : []),
  ]
  return missingSettingKeys(env).pipe(
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
    Effect.map((keys) => [...missing, ...(keys.length === 0 ? [] : ["user settings keys"])]),
    Effect.map((all) =>
      all.length === 0
        ? undefined
        : `holyagent: setup is incomplete (missing ${all.join(", ")}). Offer the user to run /holyagent:setup, which installs and configures them; do not run it unasked.`,
    ),
  )
}
