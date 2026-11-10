import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import {
  type CapabilityForm,
  enabledCapabilities,
  formContent,
  type McpServer,
  T3_PREVIEW_TOOLS,
} from "../../../runtime/src/config/capabilities.ts"
import type { Config } from "../../../runtime/src/config/schema.ts"
import { isHeadlessScreenAgent } from "../../../runtime/src/domain/route.ts"
import { toolMatches } from "../../../runtime/src/pi/tools.ts"
import { SCREEN_SPECIALIST_NAMES } from "./specialists.ts"

/**
 * What the description of a screen specialist adds to the role's own: the root reads it, in the
 * `Agent` tool's list, to see that the file is the one a screen Assignment is dispatched to, and
 * that it is the form for a machine with a graphical session (the other is
 * {@link HEADLESS_SCREEN_DESCRIPTION}).
 */
export const SCREEN_DESCRIPTION =
  "Launched for an Assignment that carries the screen capability on a machine with a graphical session: it also has the computer-use, browser-use and T3 preview tools."

/**
 * What the description of a headless screen specialist adds to the role's: the machine has no
 * desktop, so the file lists the headless browser's tools and no computer-use or browse tools.
 */
export const HEADLESS_SCREEN_DESCRIPTION =
  "Launched for an Assignment that carries the screen capability on a headless machine: it has a headless browser (browser-use) and the T3 preview tools, and no desktop."

/**
 * What the prompt of a headless screen specialist adds after the role's: it has a headless browser
 * and no desktop, and says so when a tool is missing instead of working around it.
 */
export const HEADLESS_SCREEN_NOTE =
  "## Headless screen\n\nThis machine has no graphical session. You have a headless browser: the browser-use MCP tools (`mcp__browser_use__browser_exec`, which runs Python on the browser, and `mcp__browser_use__browser_screenshot`; a temporary profile that is removed when the session ends) and, where T3 hosts the session, T3's preview tools. You have no desktop: computer use and the user's real browser are not available. Report a missing tool instead of working around it."

/**
 * Whether an agent name is a screen specialist's: one of the 18 roles' names with the `-screen`
 * suffix (`SCREEN_AGENT_SUFFIX`).
 */
export const isScreenAgent = (agent: string | undefined): boolean =>
  agent !== undefined && SCREEN_SPECIALIST_NAMES.includes(agent)

/**
 * The form a screen specialist runs in, from its agent name: the headless files are for a headless
 * machine and the others for one with a graphical session, so the specialist agrees with the file
 * it was launched from.
 */
export const screenFormOf = (agent: string | undefined): CapabilityForm =>
  isHeadlessScreenAgent(agent) ? "headless" : "normal"

/**
 * The MCP servers the capabilities of a config add in a form, for a specialist that carries the
 * screen capability: those of the enabled capabilities the form offers (opencode browse in the
 * normal form, the browser-use MCP server in the headless one), none while `pi.features.mcp` is off
 * (Pi's MCP extension, which runs them, is not loaded then), and none for a capability the config
 * switches off.
 */
export const screenServers = (config: Config, form: CapabilityForm): ReadonlyArray<McpServer> =>
  config.pi.features.mcp
    ? enabledCapabilities(config.pi.features, { form, provider: config.pi.provider }).flatMap(
        (capability) => formContent(capability, form)?.mcpServers ?? [],
      )
    : []

/**
 * Whether a tool call is one of T3 Code's preview or render tools ({@link T3_PREVIEW_TOOLS}) made
 * by a screen specialist outside a session T3 hosts. The tools grant a view into T3's own browser,
 * so a session that T3 does not host (`t3`, see `isT3Session`) is refused them even where their
 * names are registered, for example by a T3 MCP server the user added by hand.
 */
export const refuseT3PreviewOutsideT3 = (
  event: { readonly toolName: string },
  agent: string | undefined,
  t3: boolean,
): ToolCallEventResult | undefined =>
  !t3 &&
  isScreenAgent(agent) &&
  T3_PREVIEW_TOOLS.some((pattern) => toolMatches(pattern, event.toolName))
    ? {
        block: true,
        reason: `${event.toolName} is T3 Code's tool, and T3 does not host this session. Use the browser tools you were given instead.`,
      }
    : undefined

/**
 * Registers the screen MCP servers in the session of a specialist, and only a screen specialist's
 * (see {@link isScreenAgent}): every other process, the root included, would start a server it
 * never calls, since Pi starts the servers of each session, a child's too. `register` is
 * `pi.registerMcpServer`; its failure for one server is returned as a reason and the others still
 * register. A server launched through `npx`, or through the browser launcher, starts in
 * `neutralDirectory`, not in the project: npx runs a package it finds in a `node_modules` of its
 * working directory or above without fetching it, so a repository's own `node_modules` could stand
 * in for the pinned package of a server with browser control, and the launcher's `uvx` would read
 * the project's files the same way. A server that launches a Chromium (see
 * {@link McpServer.launchesChromium}) is registered as the command `launch` returns for it, which
 * throws when there is none. The result lists the servers registered and the reasons for those that
 * were not.
 */
export const registerScreenServers = (
  register: (
    name: string,
    config: { readonly command: string; readonly args: Array<string>; readonly cwd?: string },
  ) => void,
  agent: string | undefined,
  servers: ReadonlyArray<McpServer>,
  neutralDirectory: string,
  launch: (server: McpServer) => { readonly command: string; readonly args: ReadonlyArray<string> },
): { readonly registered: ReadonlyArray<string>; readonly failures: ReadonlyArray<string> } => {
  if (!isScreenAgent(agent)) return { registered: [], failures: [] }
  const outcomes = servers.map((server) =>
    Effect.runSync(
      Effect.try({
        try: () => {
          const { command, args } = server.launchesChromium === true ? launch(server) : server
          return register(server.name, {
            command,
            args: [...args],
            ...(server.command === "npx" || server.launchesChromium === true
              ? { cwd: neutralDirectory }
              : {}),
          })
        },
        catch: (cause) =>
          `${server.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }).pipe(
        Effect.as({ name: server.name, failure: undefined as string | undefined }),
        Effect.catch((failure) => Effect.succeed({ name: server.name, failure })),
      ),
    ),
  )
  return {
    registered: outcomes.flatMap(({ name, failure }) => (failure === undefined ? [name] : [])),
    failures: outcomes.flatMap(({ failure }) => (failure === undefined ? [] : [failure])),
  }
}
