import { join } from "node:path"

import { Effect } from "effect"

import { CAPABILITIES } from "../config/capabilities.ts"
import { userConfigFile } from "../config/load.ts"
import { CONFIG_FILE, stateDirectory } from "../state/layout.ts"
import type { Env } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { isJsonObject, type JsonObject, readJsonObject, writeJsonObject } from "./json-file.ts"
import { type CapabilityChoices, loadPiConfig } from "./pi-check.ts"
import { added, present, skipped } from "./report.ts"
import type { Scope } from "./scope.ts"

/**
 * The HolyAgent config file that a scope's capability choices are written to: the user's
 * `config.json` for scope `user`, whose Pi work reads that file alone, and the project's for
 * `project` and `local`.
 */
export const capabilityConfigFile = (env: Env, cwd: string, scope: Scope): string =>
  scope === "user" ? userConfigFile(env) : join(stateDirectory(cwd), CONFIG_FILE)

const objectAt = (parent: JsonObject, key: string, file: string, path: string) => {
  const value = parent[key]
  if (value === undefined) return Effect.succeed<JsonObject>({})
  return isJsonObject(value)
    ? Effect.succeed(value)
    : Effect.fail(new SetupFailure({ message: `${file}: ${path} is not an object` }))
}

/**
 * The capability step of `holyagent setup`: records each capability the run switched (`--<name>
 * on|off`, or a row of the setup screen) as `pi.features.<key>` in the HolyAgent config of the
 * scope ({@link capabilityConfigFile}), so setup, doctor and the Pi extension agree afterwards. A
 * choice equal to what the config already decides gets an `=` line and no write, so a run never
 * freezes today's defaults into the file; every other key of the file stays. On a dry run the lines
 * say what would be written. A config that cannot be loaded, or whose `pi` or `pi.features` is not
 * an object, is a {@link SetupFailure}.
 */
export const applyCapabilityChoices = Effect.fn("applyCapabilityChoices")(function* (
  env: Env,
  options: {
    readonly scope: Scope
    readonly cwd: string
    readonly dryRun: boolean
    readonly choices: CapabilityChoices
  },
) {
  const chosen = CAPABILITIES.flatMap((capability) => {
    const value = options.choices[capability.feature]
    return value === undefined ? [] : [{ capability, value }]
  })
  if (chosen.length === 0) return []
  const current = (yield* loadPiConfig(env, options.cwd, options.scope)).pi.features
  const changed = chosen.filter(({ capability, value }) => current[capability.feature] !== value)
  const word = (value: boolean) => (value ? "on" : "off")
  const lines = chosen
    .filter(({ capability, value }) => current[capability.feature] === value)
    .map(({ capability, value }) =>
      present(`capability ${capability.name}: already ${word(value)}`),
    )
  if (changed.length === 0) return lines
  const file = capabilityConfigFile(env, options.cwd, options.scope)
  if (!options.dryRun) {
    const existing = yield* readJsonObject(file)
    const pi = yield* objectAt(existing, "pi", file, "pi")
    const features = yield* objectAt(pi, "features", file, "pi.features")
    yield* writeJsonObject(file, {
      ...existing,
      pi: {
        ...pi,
        features: {
          ...features,
          ...Object.fromEntries(
            changed.map(({ capability, value }) => [capability.feature, value]),
          ),
        },
      },
    })
  }
  return [
    ...lines,
    ...changed.map(({ capability, value }) => {
      const text = `capability ${capability.name}: ${options.dryRun ? "would turn" : "turned"} ${word(value)} (pi.features.${capability.feature} in ${file})`
      return value ? added(text) : skipped(text)
    }),
  ]
})
