import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

import { canonicalPiToolName } from "../../../runtime/src/domain/host.ts"

/** A wait result; completion details remain with the host's ordinary notification. */
export type WaitResult =
  | { readonly reason: "agent"; readonly id: string; readonly status: "completed" | "failed" }
  | { readonly reason: "input" | "cancelled" | "unavailable"; readonly detail?: string }
  | { readonly reason: "timeout"; readonly timeoutMs: number; readonly cache: "unknown" }

/** The synchronous event bus exposed by Pi to extensions. */
export interface WaitBus {
  on(channel: string, handler: (payload: unknown) => void): () => void
}

/** The per-session ledger; it never consumes a host completion notification or user text. */
export const createAgentWait = (bus: WaitBus) => {
  const active = new Set<string>()
  const completed: Array<Extract<WaitResult, { reason: "agent" }>> = []
  let pendingInput = false
  let cancelled = false
  let ready = false
  let disposed = false
  let wake: (() => void) | undefined
  const idOf = (value: unknown): string | undefined =>
    typeof value === "object" && value !== null && "id" in value && typeof value.id === "string"
      ? value.id
      : undefined
  const start = (value: unknown) => {
    const id = idOf(value)
    if (id !== undefined) active.add(id)
  }
  const finish = (status: "completed" | "failed") => (value: unknown) => {
    const id = idOf(value)
    if (id === undefined) return
    active.delete(id)
    completed.push({ reason: "agent", id, status })
    wake?.()
  }
  const unsubscribe = [
    bus.on("subagents:ready", () => {
      ready = true
      wake?.()
    }),
    bus.on("subagents:created", start),
    bus.on("subagents:started", start),
    bus.on("subagents:completed", finish("completed")),
    bus.on("subagents:failed", finish("failed")),
    bus.on("subagents:disposed", () => {
      disposed = true
      wake?.()
    }),
  ]
  const next = (): WaitResult | undefined => {
    if (disposed) return { reason: "cancelled", detail: "session disposed" }
    if (cancelled) {
      cancelled = false
      return { reason: "cancelled", detail: "Pi configuration is unavailable" }
    }
    const agent = completed.shift()
    if (agent !== undefined) return agent
    if (pendingInput) {
      pendingInput = false
      return { reason: "input" }
    }
    return undefined
  }
  return {
    /** Cancel a pending wait if the integration is disabled or cannot verify its config. */
    cancel(): void {
      if (wake !== undefined) {
        cancelled = true
        wake()
      }
    },
    /** Record submitted interactive/RPC input without taking or returning the text. */
    input(source: string): void {
      if (source !== "interactive" && source !== "rpc") return
      pendingInput = true
      wake?.()
    },
    /** Wait only for observed top-level activity. Workflow children have no public event. */
    wait(options: {
      readonly timeoutMs: number
      readonly signal?: AbortSignal
      readonly workflowPending?: boolean
    }): Promise<WaitResult> {
      if (options.signal?.aborted === true) return Promise.resolve({ reason: "cancelled" })
      const immediate = next()
      if (immediate !== undefined) return Promise.resolve(immediate)
      if (options.workflowPending === true)
        return Promise.resolve({
          reason: "unavailable",
          detail: "workflow completion has no public wait event; return to host notifications",
        })
      if (!ready || active.size === 0)
        return Promise.resolve({
          reason: "unavailable",
          detail: !ready
            ? "agent lifecycle events unavailable"
            : "no observed top-level agent is running",
        })
      if (wake !== undefined)
        return Promise.resolve({ reason: "unavailable", detail: "a wait is already pending" })
      const timeoutMs = Math.max(1, Math.min(options.timeoutMs, 60_000))
      return new Promise((resolve) => {
        const timer = setTimeout(
          () => finishWait({ reason: "timeout", timeoutMs, cache: "unknown" }),
          timeoutMs,
        )
        const finishWait = (result: WaitResult) => {
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", abort)
          wake = undefined
          resolve(result)
        }
        const abort = () => finishWait({ reason: "cancelled" })
        wake = () => {
          const result = next()
          if (result !== undefined) finishWait(result)
        }
        options.signal?.addEventListener("abort", abort, { once: true })
        if (options.signal?.aborted === true) abort()
        else wake()
      })
    },
    /** Cancel pending work and unsubscribe before this extension/session is discarded. */
    dispose(): void {
      disposed = true
      wake?.()
      for (const off of unsubscribe) off()
    },
  }
}
/** Register the explicitly authorized root wait without relying on a session display name. */
export const registerAgentWait = (
  pi: ExtensionAPI,
  registerRootFlag = true,
  hostVersion = VERSION,
): { readonly enable: () => void; readonly disable: () => void } => {
  if (registerRootFlag)
    pi.registerFlag("holyagent-native-root", {
      type: "boolean",
      description: "Enable root-only HolyAgent tools",
    })
  if (hostVersion !== "1.5.0" || typeof pi.events?.on !== "function")
    return { enable: () => {}, disable: () => {} }
  let waiting = createAgentWait(pi.events)
  let closed = false
  let registered = false
  let permitted = false
  let suppressed = false
  let workflowPending = false
  pi.on("session_start", () => {
    if (closed) {
      waiting = createAgentWait(pi.events)
      closed = false
      workflowPending = false
    }
    permitted = false
  })
  const enable = () => {
    if (pi.getFlag("holyagent-native-root") !== true) return
    if (registered) {
      permitted = true
      if (suppressed) pi.setActiveTools([...new Set([...pi.getActiveTools(), "wait_for_agents"])])
      suppressed = false
      return
    }
    if (pi.getAllTools().some((tool) => tool.name === "wait_for_agents")) return
    registered = true
    permitted = true
    pi.registerTool({
      name: "wait_for_agents",
      label: "Wait for agents or input",
      description:
        "Wait for an observed top-level agent completion or submitted input. Workflows have no supported completion event: pass workflow_pending and return to host notifications. The timeout uses an explicit fallback, not a known cache TTL.",
      parameters: Type.Object({
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1, maximum: 60_000 })),
        workflow_pending: Type.Optional(Type.Boolean()),
      }),
      execute: async (_id, args, signal) => {
        const result =
          permitted && pi.getFlag("holyagent-native-root") === true
            ? await waiting.wait({
                timeoutMs: args.timeout_ms ?? 30_000,
                ...(signal === undefined ? {} : { signal }),
                workflowPending: workflowPending || args.workflow_pending === true,
              })
            : {
                reason: "unavailable" as const,
                detail: "root capability or enabled Pi configuration is unavailable",
              }
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }
      },
    })
  }
  pi.on("tool_call", (event) => {
    if (canonicalPiToolName(event.toolName) === "SubagentWorkflow") workflowPending = true
  })
  pi.on("input", (event) => {
    if (event.streamingBehavior !== undefined) waiting.input(event.source)
    return { action: "continue" }
  })
  pi.on("session_shutdown", () => {
    waiting.dispose()
    closed = true
    permitted = false
  })
  return {
    enable,
    disable: () => {
      permitted = false
      waiting.cancel()
      if (registered && pi.getActiveTools().includes("wait_for_agents")) {
        suppressed = true
        pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "wait_for_agents"))
      }
    },
  }
}
