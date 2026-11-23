import { Effect } from "effect"

import { type CapabilityForm, FEATURE_PACKAGES } from "../../../runtime/src/config/capabilities.ts"
import { WEB_KIT_PACKAGE } from "../../../runtime/src/config/packages.ts"
import { type Config, defaultConfig } from "../../../runtime/src/config/schema.ts"
import { agentFor, type Route } from "../../../runtime/src/domain/route.ts"
import type { Family } from "../../../runtime/src/instructions/families.ts"
import { instructionsDirectory } from "../../../runtime/src/instructions/skills.ts"
import { FFF_TOOLS } from "../../../runtime/src/pi/fff/settings.ts"
import { PROVIDERS, webChoice } from "../../../runtime/src/pi/provider.ts"
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
import { HEADLESS_SCREEN_DESCRIPTION, HEADLESS_SCREEN_NOTE, SCREEN_DESCRIPTION } from "./screen.ts"

/** The folder of the built package that holds the agent files, relative to the package root. */
export const AGENTS_FOLDER = "agents"

// The package matches an extension by its npm name without the scope, lowercased (its
// `extensionPackageName`), which is how its `ext:` selectors name one.
const extensionName = (npmName: string): string =>
  (npmName.startsWith("@") ? npmName.slice(npmName.indexOf("/") + 1) : npmName).toLowerCase()

const BUILTINS: ReadonlySet<string> = new Set([...READ_TOOLS, ...WRITE_TOOLS, ...SHELL_TOOLS])

// The package reads one agent file per specialist, whichever provider the session runs, and the
// tools of a role live only there. A web tool is therefore listed through the web source of every
// provider (Kimi's own extension, `pi-web-kit` for a provider with no web tools), so the file is
// right under each. An entry for an extension the session did not load matches nothing.
const webEntries = (mode: Config["pi"]["features"]["web"]): ReadonlyArray<string> =>
  mode === "off"
    ? []
    : [
        ...PROVIDERS["kimi-coding-global"].webTools.map(
          (tool) => `ext:pi-provider-kimi-code/${tool}`,
        ),
        ...["web_search", "web_fetch"].map(
          (tool) => `ext:${extensionName(WEB_KIT_PACKAGE)}/${tool}`,
        ),
      ]

/**
 * The `tools:` entries of a specialist's agent file, from the tool arguments that decide its tools
 * (`toolArgs`). The package reads three kinds of entry: Pi's built-in tools by name;
 * `ext:<extension>` or `ext:<extension>/<tool>` for an extension's tools, where the extension is
 * named by its npm package without the scope (`ext:builtin:codemode` for Pi's own); and
 * `mcp__<server>__<tool>` patterns, which it matches itself. A web tool becomes the entries of
 * every provider's web source (`webEntries`), since all providers read the same file, and a
 * provider's own write tool gets none (the extension activates it). Any `ext:` entry turns
 * extension tools into an explicit allowlist, so a specialist has none of the root's tools (`todo`,
 * `ask_user_question`, the process tools). A tool no entry covers fails the build: dropping it
 * would leave the role under-tooled in silence. With `screen` the entries are those of a specialist
 * launched for an Assignment that carries the screen capability in the machine's `form` (`normal`
 * by default): the role's own, then the screen tools of the form (see `toolArgs`): computer use and
 * browse (`mcp__browse__*`) in the normal form, the browser-use server's `browser_exec` and
 * `browser_screenshot` in the headless one, and the T3 preview tools in both.
 */
export const agentTools = (
  config: Config,
  route: Route,
  screen: boolean = false,
  form: CapabilityForm = "normal",
): ReadonlyArray<string> => {
  const profile = PROVIDERS[config.pi.routes[route.roleTask].provider ?? config.pi.provider]
  const web = webChoice(profile, config.pi.features.web)
  const entries = toolArgs(config, route.roleTask, profile, { screen, form }).tools.flatMap(
    (tool) => {
      if (BUILTINS.has(tool) || tool.startsWith("mcp__")) return [tool]
      // The provider's own write tool (Codex's `apply_patch`) is HolyAgent's, registered inactive:
      // the extension adds it to the specialist's active tools at its start (`activateApplyPatch`).
      if (profile.writeTools.includes(tool)) return []
      if (FFF_TOOLS.includes(tool)) return [`ext:pi-fff/${tool}`]
      if (tool === CODEMODE_TOOL) return ["ext:builtin:codemode"]
      if (COMPUTER_USE_TOOLS.includes(tool))
        return [`ext:${extensionName(FEATURE_PACKAGES.computerUse)}`]
      if ((web.tools as ReadonlyArray<string>).includes(tool))
        return webEntries(config.pi.features.web)
      throw new Error(`${route.agent}: no package tools entry for ${tool}`)
    },
  )
  return [...new Set(entries)]
}

/**
 * Three agent files for each of the 18 specialists, for the package `@tintinweb/pi-subagents` loads
 * through `pi.subagents.agents` in the manifest: the role's own, and two launched for an Assignment
 * that carries the screen capability, one for a machine with a graphical session (`<agent>-screen`)
 * and one for a headless machine (`<agent>-headless-screen`). They have the same prompt and the
 * screen tools of their form added to the role's (a launcher grants tools only through the agent
 * file, so the Assignments without the capability keep the short tool list, and a headless
 * specialist has no computer-use or browse tool); the headless prompt adds a note that it has a
 * headless browser and no desktop. The body is the family's specialist prompt, made by the Claude
 * generator's `specialistFiles` (the role sections, the shared conduct and the conditional sections
 * the role needs, with the maintainers' notes stripped). The tools come from the default config
 * (see {@link agentTools}), the same ones the root passes the specialist's route. The files go to
 * `folder` of the package, `agents/` by default; the other families' copies go below `families/`
 * (see `familyAgents`), where the extension finds the prompt of the family a provider runs.
 */
export const agentFiles = async (
  family: Family = PI_FAMILY,
  config?: Config,
  folder: string = AGENTS_FOLDER,
): Promise<ReadonlyArray<GeneratedFile>> => {
  const resolved = config ?? (await Effect.runPromise(defaultConfig))
  const variant = (screen: boolean, form: CapabilityForm = "normal") =>
    specialistFiles({
      instructions: instructionsDirectory(family),
      guidanceFamily: family,
      guidanceRoot: "${HOLYAGENT_PI_ROOT}",
      path: (route) => `${DIST_DIRECTORY}/${folder}/${agentFor(route, screen, form)}.md`,
      // No `model:` or `thinking:`: the package ranks an agent file above the call's parameters on
      // its `Agent` path, and the route values are per user, so the root passes them on each call.
      // `prompt_mode: replace` makes the body the child's whole prompt: the child inherits neither
      // the root's prompt nor AGENTS.md. The `${HOLYAGENT_PI_ROOT}` placeholders in the body are
      // filled when the child starts (`fillPackageRoot` in the extension), since the install path
      // is not known at build time.
      head: (route, source, description) =>
        frontmatter(generatedNote(source), [
          `name: ${agentFor(route, screen, form)}`,
          `description: ${JSON.stringify(
            !screen
              ? description
              : `${description} ${form === "headless" ? HEADLESS_SCREEN_DESCRIPTION : SCREEN_DESCRIPTION}`,
          )}`,
          "prompt_mode: replace",
          `tools: ${JSON.stringify(agentTools(resolved, route, screen, form).join(", "))}`,
        ]),
      runtime: () => "",
      ...(screen && form === "headless" ? { appendix: () => HEADLESS_SCREEN_NOTE } : {}),
    })
  return [
    ...(await variant(false)),
    ...(await variant(true, "normal")),
    ...(await variant(true, "headless")),
  ]
}
