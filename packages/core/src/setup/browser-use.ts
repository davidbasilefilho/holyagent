import { Effect } from "effect"

import {
  type CapabilityDefinition,
  type CapabilityForm,
  enabledCapabilities,
  formContent,
  formNeeds,
  serversWithheld,
  unavailableIn,
} from "../config/capabilities.ts"
import { fileSystem } from "../ports/filesystem.ts"
import { describeBrowseState, readBrowseState } from "./browse.ts"
import { findChromiumWith } from "./chromium.ts"
import type { Env } from "./environment.ts"
import { loadPiConfig, unmetNeed } from "./pi-check.ts"
import type { PiInstallOptions } from "./pi-install.ts"
import { hint, present } from "./report.ts"

const reportOne = (
  env: Env,
  capability: CapabilityDefinition,
  features: Readonly<Record<string, unknown>>,
  options: PiInstallOptions,
  platform: string,
) =>
  Effect.gen(function* () {
    const form: CapabilityForm = options.form ?? "normal"
    const label = capability.name
    const reason = unavailableIn(capability, form)
    if (reason !== undefined)
      return [
        hint(
          `${label}: not offered in the ${form} form (${reason}); screen specialists get no tools of it here`,
        ),
      ]
    const content = formContent(capability, form)
    const withheld = serversWithheld(capability, form, features)
    const unmet = yield* Effect.forEach(formNeeds(capability, form), (need) =>
      unmetNeed(env, need, platform),
    )
    const needs = unmet.flatMap((problem) =>
      problem === undefined ? [] : [hint(`${label}: ${problem}`)],
    )
    const launched = (content?.mcpServers ?? []).some(
      ({ launchesChromium }) => launchesChromium === true,
    )
    const servers = (content?.mcpServers ?? []).map(
      ({ command, args }) => `${command} ${args.join(" ")}`,
    )
    const chromium = launched ? findChromiumWith(yield* fileSystem, env, platform) : undefined
    const browser =
      chromium === undefined
        ? []
        : [present(`${label}: the headless browser is the Chromium at ${chromium}`)]
    // A form with a server that drives a paired browser reports where that stands. A pairing file
    // that cannot be read is a line here, not a failure of the step; doctor fails on it.
    const pairing =
      content?.pairing === true && withheld === undefined
        ? yield* readBrowseState(env, platform).pipe(
            Effect.map((state) => {
              const { text, fix } = describeBrowseState(state)
              return state.state === "paired"
                ? present(`${label}: ${text}`)
                : hint(`${label}: ${text}${fix === undefined ? "" : `; ${fix}`}`)
            }),
            Effect.catchTag("SetupFailure", (error) =>
              Effect.succeed(
                hint(`${label}: cannot tell whether a browser is paired: ${error.message}`),
              ),
            ),
            Effect.map((line) => [line]),
          )
        : []
    return [
      withheld === undefined
        ? present(
            `${label}: ${form} form; the extension registers \`${servers.join("`, `")}\` for screen specialists${launched ? " through `holyagent browser-server`, which starts the headless browser and stops it with the server" : ""} and writes no file for it`,
          )
        : hint(`${label}: ${form} form; ${withheld}`),
      ...needs,
      ...browser,
      ...pairing,
    ]
  })

/**
 * The browser-use step of `holyagent setup`: one report, and no change, for each enabled capability
 * that registers an MCP server for screen specialists (opencode browse in the normal form, the
 * browser-use MCP server in the headless form). It says the form in force, the MCP server the
 * extension registers (or that `pi.features.mcp` is off, so none is), each system need that is not
 * met, in the headless form the Chromium the browser runs on, and in the normal form where browse
 * stands: paired with a browser, installed in one but not paired, or not installed
 * ({@link readBrowseState}). A form the capability does not offer says why, as a `~` line, and
 * nothing is dropped silently. With `pi.enable` off, or the capability off, there are no lines. The
 * config is the one the Pi steps read at the scope ({@link loadPiConfig}). The `platform` (the
 * machine's by default) decides the graphical-session need, the Chromium paths and the browsers'
 * folders.
 */
export const reportBrowserUse = Effect.fn("reportBrowserUse")(function* (
  env: Env,
  options: PiInstallOptions,
  platform: string = process.platform,
) {
  const config = yield* loadPiConfig(env, options.cwd, options.scope, options.choices)
  if (!config.pi.enable) return []
  const reporting = enabledCapabilities(config.pi.features, {
    provider: config.pi.provider,
  }).filter((capability) =>
    Object.values(capability.forms).some(
      (form) => "mcpServers" in form && form.mcpServers.length > 0,
    ),
  )
  const lines = yield* Effect.forEach(reporting, (capability) =>
    reportOne(env, capability, config.pi.features, options, platform),
  )
  return lines.flat()
})
