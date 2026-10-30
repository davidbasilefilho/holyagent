import { Effect, Option } from "effect"

import { inCloudSession } from "../vcs/identity.ts"
import { type Env, userFiles } from "./environment.ts"
import { findLeftovers, hasRemovableLeftovers } from "./leftovers.ts"
import { missingSettingKeys } from "./settings.ts"
import { findCommand } from "./shell.ts"

/**
 * The one line a SessionStart hook adds when HolyAgent's setup is incomplete, or undefined when it
 * is complete. It looks for `ctx7` on the search path (and in Bun's global bin directory, where
 * `bun add -g` puts it), for the recommended keys of the user settings, and for what an earlier
 * Billion Context setup left in the Claude Code files that `/holyagent:setup` can remove (a project
 * install whose folder setup will not run `claude` in is left out, since the line could never
 * clear). It reads files and looks commands up and nothing more: no process is spawned, nothing is
 * installed and nothing is written. In a claude.ai cloud session it says nothing, because setup
 * leaves ctx7 out there and the session has no user settings to complete. A file that is not a JSON
 * object is not reported, since setup cannot repair it.
 */
export const setupNotice = (env: Env): Effect.Effect<string | undefined> => {
  if (inCloudSession(env)) return Effect.succeed(undefined)
  const missing = Option.isNone(findCommand(env, "ctx7", { includeBunBin: true })) ? ["ctx7"] : []
  return Effect.all([
    missingSettingKeys(env).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
    findLeftovers(userFiles(env)).pipe(
      Effect.flatMap(hasRemovableLeftovers),
      Effect.orElseSucceed(() => false),
    ),
  ]).pipe(
    Effect.map(([keys, leftovers]) => {
      const lacking = [...missing, ...(keys.length === 0 ? [] : ["user settings keys"])]
      const details = [
        ...(lacking.length === 0 ? [] : [`missing ${lacking.join(", ")}`]),
        ...(leftovers ? ["leftovers from an earlier Billion Context setup"] : []),
      ]
      return details.length === 0
        ? undefined
        : `holyagent: setup is incomplete (${details.join("; ")}). Offer the user to run /holyagent:setup, which installs, configures and cleans up; do not run it unasked.`
    }),
  )
}
