import { Effect } from "effect"

import { FEATURE_PACKAGES } from "../../../runtime/src/config/capabilities.ts"
import { WEB_KIT_PACKAGE } from "../../../runtime/src/config/packages.ts"
import { type Config, defaultConfig } from "../../../runtime/src/config/schema.ts"
import type { Route } from "../../../runtime/src/domain/route.ts"
import type { Family } from "../../../runtime/src/instructions/families.ts"
import { instructionsDirectory } from "../../../runtime/src/instructions/skills.ts"
import { providerProfile, webChoice } from "../../../runtime/src/pi/provider.ts"
import {
  CODEMODE_TOOL,
  COMPUTER_USE_TOOLS,
  READ_TOOLS,
  SHELL_TOOLS,
  toolArgs,
  WRITE_TOOLS,
} from "../../../runtime/src/pi/tools.ts"
// The specialist prompt is the Claude generator's: both families mirror the same files, so one
// builder names what each role and the shared conduct are made of.
import { frontmatter, specialistFiles } from "../../claude/src/agents.ts"
import { DIST_DIRECTORY, type GeneratedFile, generatedNote, PI_FAMILY } from "./files.ts"

/** The folder of the built package that holds the agent files, relative to the package root. */
export const AGENTS_FOLDER = "agents"

// The package matches an extension by its npm name without the scope, lowercased (its
// `extensionPackageName`), which is how its `ext:` selectors name one.
const extensionName = (npmName: string): string =>
  (npmName.startsWith("@") ? npmName.slice(npmName.indexOf("/") + 1) : npmName).toLowerCase()

const BUILTINS: ReadonlySet<string> = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS])

/**
 * The `tools:` entries of a specialist's agent file, from the tool arguments that decide its tools
 * (`toolArgs`). The package reads three kinds of entry: Pi's built-in tools by name;
 * `ext:<extension>` or `ext:<extension>/<tool>` for an extension's tools, where the extension is
 * named by its npm package without the scope (`ext:builtin:codemode` for Pi's own); and
 * `mcp__<server>__<tool>` patterns, which it matches itself. Any `ext:` entry turns extension tools
 * into an explicit allowlist, so a specialist has none of the root's tools (`todo`,
 * `ask_user_question`, the process tools). A tool no entry covers fails the build: dropping it
 * would leave the role under-tooled in silence.
 */
export const agentTools = (config: Config, route: Route): ReadonlyArray<string> => {
  const profile = providerProfile(config)
  const web = webChoice(profile, config.pi.features.web)
  const webExtension = extensionName(web.source === "provider" ? profile.package : WEB_KIT_PACKAGE)
  const entries = toolArgs(config, route.roleTask, profile).tools.map((tool) => {
    if (BUILTINS.has(tool) || tool.startsWith("mcp__")) return tool
    if (tool === CODEMODE_TOOL) return "ext:builtin:codemode"
    if (COMPUTER_USE_TOOLS.includes(tool))
      return `ext:${extensionName(FEATURE_PACKAGES.computerUse)}`
    if ((web.tools as ReadonlyArray<string>).includes(tool)) return `ext:${webExtension}/${tool}`
    throw new Error(`${route.agent}: no package tools entry for ${tool}`)
  })
  return [...new Set(entries)]
}

/**
 * One agent file for each of the 18 specialists, for the package `@tintinweb/pi-subagents` loads
 * through `pi.subagents.agents` in the manifest. The body is the family's specialist prompt, made
 * by the Claude generator's `specialistFiles` (the role sections, the shared conduct and the
 * conditional sections the role needs, with the maintainers' notes stripped). The tools come from
 * the default config (see {@link agentTools}), the same ones the root passes the specialist's route.
 */
export const agentFiles = async (
  family: Family = PI_FAMILY,
  config?: Config,
): Promise<ReadonlyArray<GeneratedFile>> => {
  const resolved = config ?? (await Effect.runPromise(defaultConfig))
  return specialistFiles({
    instructions: instructionsDirectory(family),
    path: (route) => `${DIST_DIRECTORY}/${AGENTS_FOLDER}/${route.agent}.md`,
    // No `model:` or `thinking:`: the package ranks an agent file above the call's parameters on its
    // `Agent` path, and the route values are per user, so the root passes them on each call.
    // `prompt_mode: replace` makes the body the child's whole prompt: the child inherits neither the
    // root's prompt nor AGENTS.md. The `${HOLYAGENT_PI_ROOT}` placeholders in the body are filled
    // when the child starts (`fillPackageRoot` in the extension), since the install path is not
    // known at build time.
    head: (route, source, description) =>
      frontmatter(generatedNote(source), [
        `name: ${route.agent}`,
        `description: ${JSON.stringify(description)}`,
        "prompt_mode: replace",
        `tools: ${JSON.stringify(agentTools(resolved, route).join(", "))}`,
      ]),
    runtime: () => "",
  })
}
