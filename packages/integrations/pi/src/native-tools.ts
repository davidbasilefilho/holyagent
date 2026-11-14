import { type ExtensionAPI, VERSION } from "@earendil-works/pi-coding-agent"
import { makeContext } from "@holyagent/core"
import { Cause, Effect, Schema } from "effect"
import { type TSchema, Type } from "typebox"

import { canonicalPiToolName } from "../../../runtime/src/domain/host.ts"
import { CAPABILITIES, executeNative, inventory } from "../../../runtime/src/native/catalog.ts"
import { firstPassPrompt } from "../../../runtime/src/prompts/index.ts"

/** Explicit root capability; child sessions do not inherit extension flags on pinned Pi. */
export const NATIVE_ROOT_FLAG = "holyagent-native-root"

/** Settings supplied by the extension rather than a model tool input. */
export interface NativeHost {
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Controls current-session native capability and revokes in-flight operations. */
export interface NativeTools {
  readonly setEnabled: (enabled: boolean) => void
  readonly shutdown: () => Promise<void>
}

const safeText = (value: string): string =>
  Array.from(value, (character) => {
    const code = character.charCodeAt(0)
    return (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
      ? `\\u${code.toString(16).padStart(4, "0")}`
      : character
  }).join("")

/** Registers typed direct-core tools and an explicit, fail-closed root flag. */
export const registerNativeTools = (pi: ExtensionAPI, host: NativeHost): NativeTools => {
  let enabled = false
  let registered = false
  const active = new Map<AbortController, Promise<unknown>>()
  const rootFlag = () => {
    try {
      return VERSION === "1.5.0" && pi.getFlag(NATIVE_ROOT_FLAG) === true
    } catch {
      return false
    }
  }
  const allowed = () => enabled && rootFlag()
  const shutdown = async () => {
    setEnabled(false)
    await Promise.allSettled(active.values())
  }
  pi.registerFlag(NATIVE_ROOT_FLAG, {
    description: "Enable HolyAgent native tools in this root session",
    type: "boolean",
  })
  const setEnabled = (confirmed: boolean) => {
    enabled = confirmed && rootFlag()
    if (!enabled) for (const controller of active.keys()) controller.abort()
    if (!enabled && !registered) return
    for (const command of inventory(true)) {
      const capability = CAPABILITIES[command]
      if (capability?.kind !== "supported") continue
      const document = Schema.toJsonSchemaDocument(capability.schema)
      const schema = Type.Unsafe({
        ...document.schema,
        ...(document.definitions === undefined ? {} : { $defs: document.definitions }),
      }) as TSchema
      pi.registerTool({
        name: `holyagent_${command.replaceAll(" ", "_")}`,
        label: `holyagent ${command}`,
        description: `Run the typed HolyAgent ${command} operation.`,
        parameters: schema,
        exposure: enabled ? "codemode" : "hidden",
        execute: async (_id, input, signal, _update, ctx) => {
          const controller = new AbortController()
          const effectiveSignal =
            signal === undefined ? controller.signal : AbortSignal.any([signal, controller.signal])
          const work = (async () => {
            if (!allowed()) throw new Error("HolyAgent native root capability is unavailable")
            const effect = Effect.gen(function* () {
              const context = yield* makeContext({
                cwd: ctx.cwd,
                env: { ...host.env, HOLYAGENT_HOST: "pi" },
                host: "pi",
                authorize: () => allowed(),
                ...(["assignment dispatch", "plan"].includes(command)
                  ? {}
                  : { deferRouting: true as const }),
                workflowsAvailable:
                  pi
                    .getActiveTools()
                    .some((name) => canonicalPiToolName(name) === "SubagentWorkflow") &&
                  pi.getActiveTools().includes("codemode"),
                firstPass: {
                  "Reviewer.code": firstPassPrompt("Reviewer.code") ?? "",
                  "Reviewer.security": firstPassPrompt("Reviewer.security") ?? "",
                },
              })
              if (!allowed()) throw new Error("HolyAgent native root capability is unavailable")
              return yield* executeNative(context, command, input)
            }).pipe(
              Effect.matchCause({
                onFailure: (cause) => ({ ok: false as const, message: Cause.pretty(cause) }),
                onSuccess: (data) => ({ ok: true as const, data }),
              }),
            )
            return Effect.runPromise(effect, { signal: effectiveSignal })
          })()
          active.set(controller, work)
          try {
            const result = await work
            const cancelled = effectiveSignal.aborted
            const text = cancelled
              ? "Cancelled; a state update may have completed. Reconcile state before retrying."
              : result.ok
                ? JSON.stringify(result.data, null, 2)
                : result.message
            return {
              content: [{ type: "text" as const, text: safeText(text) }],
              details: result,
              ...(!result.ok || cancelled ? { isError: true } : {}),
            }
          } catch (error) {
            const text = effectiveSignal.aborted
              ? "Cancelled; a state update may have completed. Reconcile state before retrying."
              : error instanceof Error
                ? error.message
                : String(error)
            return {
              content: [{ type: "text" as const, text: safeText(text) }],
              details: { ok: false, cancelled: effectiveSignal.aborted },
              isError: true,
            }
          } finally {
            active.delete(controller)
          }
        },
      })
    }
    registered = true
  }
  return { setEnabled, shutdown }
}
