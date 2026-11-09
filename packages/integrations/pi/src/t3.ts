import type { ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent"

import { isDeactivatedT3Tool } from "../../../runtime/src/pi/tools.ts"

/**
 * The environment variable in which T3 Code puts the thread's access mode (`approval-required`,
 * `auto-accept-edits` or `full-access`) when it injects its bridge extension into Pi.
 */
export const T3_RUNTIME_MODE_ENV = "T3_PI_RUNTIME_MODE"

/** The environment variable in which T3 Code puts the URL of its MCP server for the session. */
export const T3_MCP_URL_ENV = "T3_MCP_URL"

/** The access mode in which T3 Code asks for no approval of any tool call. */
export const T3_FULL_ACCESS = "full-access"

/** The key of the status HolyAgent shows near T3 Code's composer. */
export const T3_STATUS_KEY = "holyagent"

/** The status line under a thread below Full access. */
export const T3_ACCESS_STATUS = "HolyAgent needs Full access: switch this thread's access mode"

/**
 * The notice for a thread below Full access: why it matters and how to switch. T3 Code applies the
 * mode through a blocking `tool_call` confirmation that covers every extension tool.
 */
export const T3_ACCESS_NOTICE =
  "this T3 Code thread is below Full access, so every HolyAgent tool call asks for approval and background specialists can stall. Switch the thread's access mode to Full access in the composer; T3 Code restarts the session."

const present = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== ""

/**
 * Whether the session runs under T3 Code: Pi's RPC mode, which T3 drives, and one of the variables
 * T3 sets when it injects its bridge. The environment is read first, so a session outside T3 never
 * touches the context.
 */
export const isT3Session = (
  context: Pick<ExtensionContext, "mode">,
  env: Readonly<Record<string, string | undefined>>,
): boolean =>
  (present(env[T3_RUNTIME_MODE_ENV]) || present(env[T3_MCP_URL_ENV])) && context.mode === "rpc"

/**
 * Whether T3 Code's access mode asks for approvals: it is set and is not Full access. T3's bridge
 * treats an unset mode as Full access, so an unset mode is not below it.
 */
export const belowFullAccess = (env: Readonly<Record<string, string | undefined>>): boolean => {
  const mode = env[T3_RUNTIME_MODE_ENV]
  return present(mode) && mode.trim() !== T3_FULL_ACCESS
}

/**
 * Refuses a call to a T3 Code tool the root keeps off (see {@link isDeactivatedT3Tool}). Taking the
 * tool out of the active set does not stop a deferred one that `tool_search` activates, or a
 * `codemode` script. Returns the `tool_call` result that blocks the call, or undefined to let it
 * run.
 */
export const refuseDeactivatedT3Tool = (event: {
  readonly toolName: string
}): ToolCallEventResult | undefined =>
  isDeactivatedT3Tool(event.toolName)
    ? {
        block: true,
        reason: `The root may not use ${event.toolName}: HolyAgent keeps T3 Code's orchestration, thread and schedule tools off and delegates through its own specialists.`,
      }
    : undefined
