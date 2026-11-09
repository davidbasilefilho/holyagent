import { Effect } from "effect"

import {
  type CapabilityForm,
  enabledCapabilities,
  formContent,
  type McpServer,
} from "../../../runtime/src/config/capabilities.ts"
import type { Config } from "../../../runtime/src/config/schema.ts"
import { SCREEN_SPECIALIST_NAMES } from "./specialists.ts"

/**
 * What the description of a screen specialist adds to the role's own: the root reads it, in the
 * `Agent` tool's list, to see that the file is the one a screen Assignment is dispatched to.
 */
export const SCREEN_DESCRIPTION =
  "Launched for an Assignment that carries the screen capability: it also has the computer-use, browser-use and T3 preview tools."

/**
 * Whether an agent name is a screen specialist's: one of the 18 roles' names with the `-screen`
 * suffix (`SCREEN_AGENT_SUFFIX`).
 */
export const isScreenAgent = (agent: string | undefined): boolean =>
  agent !== undefined && SCREEN_SPECIALIST_NAMES.includes(agent)

/**
 * The MCP servers the capabilities of a config add in a form, for a specialist that carries the
 * screen capability: those of the enabled capabilities the form offers (opencode browse, in the
 * normal form). The headless form offers none, and a capability the config switches off adds none.
 */
export const screenServers = (config: Config, form: CapabilityForm): ReadonlyArray<McpServer> =>
  enabledCapabilities(config.pi.features, { form, provider: config.pi.provider }).flatMap(
    (capability) => formContent(capability, form)?.mcpServers ?? [],
  )

/**
 * Registers the screen MCP servers in the session of a specialist, and only a screen specialist's
 * (see {@link isScreenAgent}): every other process, the root included, would start a server it never
 * calls, since Pi starts the servers of each session, a child's too. `register` is
 * `pi.registerMcpServer`; its failure for one server is returned as a reason and the others still
 * register. The result lists the servers registered and the reasons for those that were not.
 */
export const registerScreenServers = (
  register: (
    name: string,
    config: { readonly command: string; readonly args: Array<string> },
  ) => void,
  agent: string | undefined,
  servers: ReadonlyArray<McpServer>,
): { readonly registered: ReadonlyArray<string>; readonly failures: ReadonlyArray<string> } => {
  if (!isScreenAgent(agent)) return { registered: [], failures: [] }
  const outcomes = servers.map((server) =>
    Effect.runSync(
      Effect.try({
        try: () => register(server.name, { command: server.command, args: [...server.args] }),
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
