import { Effect } from "effect"

import {
  type CapabilityDefinition,
  enabledCapabilities,
  formContent,
  unavailableIn,
} from "../config/capabilities.ts"
import { BROWSE_PAIR_FIX, describePairing, readBrowsePairing } from "./browse.ts"
import type { Env } from "./environment.ts"
import { loadPiConfig, unmetNeed } from "./pi-check.ts"
import type { PiInstallOptions } from "./pi-install.ts"
import { hint, present } from "./report.ts"

const reportOne = (env: Env, capability: CapabilityDefinition, options: PiInstallOptions) =>
  Effect.gen(function* () {
    const form = options.form ?? "normal"
    const label = capability.name
    const reason = unavailableIn(capability, form)
    if (reason !== undefined)
      return [
        hint(
          `${label}: not offered in the ${form} form (${reason}); screen specialists get no tools of it here`,
        ),
      ]
    const servers = (formContent(capability, form)?.mcpServers ?? []).map(
      ({ command, args }) => `${command} ${args.join(" ")}`,
    )
    const unmet = yield* Effect.forEach(capability.needs, (need) => unmetNeed(env, need))
    const pairing = yield* readBrowsePairing(env)
    return [
      present(
        `${label}: ${form} form; the extension registers \`${servers.join("`, `")}\` for screen specialists and writes no file for it`,
      ),
      ...unmet.flatMap((problem) => (problem === undefined ? [] : [hint(`${label}: ${problem}`)])),
      pairing.state === "paired"
        ? present(`${label}: ${describePairing(pairing)}`)
        : hint(`${label}: ${describePairing(pairing)}; ${BROWSE_PAIR_FIX}`),
    ]
  })

/**
 * The browser-use step of `holyagent setup`: one report, and no change, for each enabled capability
 * that probes pairing (opencode browse). It says the form in force and, in the normal form, the MCP
 * server the extension registers, each system need that is not met, and whether a browser is paired
 * with browse, which is whether its extension is installed and paired as far as browse's stored
 * state tells ({@link readBrowsePairing}). A form the capability does not offer says why, as a `~`
 * line, and nothing is dropped silently. With `pi.enable` off, or the capability off, there are no
 * lines. The config is the one the Pi steps read at the scope ({@link loadPiConfig}).
 */
export const reportBrowserUse = Effect.fn("reportBrowserUse")(function* (
  env: Env,
  options: PiInstallOptions,
) {
  const config = yield* loadPiConfig(env, options.cwd, options.scope, options.choices)
  if (!config.pi.enable) return []
  const probing = enabledCapabilities(config.pi.features, { provider: config.pi.provider }).filter(
    (capability) => capability.health.includes("pairing"),
  )
  const lines = yield* Effect.forEach(probing, (capability) => reportOne(env, capability, options))
  return lines.flat()
})
