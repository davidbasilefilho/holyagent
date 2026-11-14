import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent"
import {
  assignment,
  loadConfigWithSource,
  makeContext,
  resolveState,
  stateDirectory,
} from "@holyagent/core"
import { dispatchedAssignment } from "@holyagent/core/api/report.ts"
import { agentFor, routeFor } from "@holyagent/core/domain/route.ts"
import { selectConfiguredRoute } from "@holyagent/core/routing/selection.ts"
import { Effect } from "effect"

import { AGENT_TYPES } from "./specialists.ts"

/** Matches the names Pi resolves after trimming and case folding. */
export const isManagedProfileAgent = (value: unknown): boolean =>
  typeof value === "string" && AGENT_TYPES.includes(value.trim().toLowerCase())

/** Refuse fuzzy provider fallback on profile launches; workflows lack a per-child veto. */
export const refuseProfileLaunch = (
  event: { readonly toolName: string; readonly input: Readonly<Record<string, unknown>> },
  active: boolean,
  registry:
    | {
        readonly getAvailable: () => ReadonlyArray<{
          readonly provider: string
          readonly id: string
        }>
      }
    | undefined,
): ToolCallEventResult | undefined => {
  if (!active) return undefined
  if (event.toolName === "SubagentWorkflow" || event.toolName === "subagent_workflow")
    return {
      block: true,
      reason:
        "Profile routing requires direct Agent calls: this workflow host may substitute a different provider. Run plan and use its direct-agent fallback.",
    }
  if (event.toolName !== "Agent" && event.toolName !== "agent") return undefined
  if (typeof event.input["resume"] === "string" && event.input["resume"] !== "")
    return {
      block: true,
      reason: "Profile routing cannot verify a resumed Agent. Redispatch the Assignment.",
    }
  if (!isManagedProfileAgent(event.input["subagent_type"])) return undefined
  const model = event.input["model"]
  if (typeof model !== "string" || !model.includes("/"))
    return {
      block: true,
      reason:
        "Profile routing requires the exact provider/model from assignment dispatch; no inherited or fuzzy model is allowed.",
    }
  const slash = model.indexOf("/")
  const provider = model.slice(0, slash)
  const id = model.slice(slash + 1)
  const available = Effect.runSync(
    Effect.try(() => registry?.getAvailable()).pipe(Effect.orElseSucceed(() => undefined)),
  )
  if (!available?.some((entry) => entry.provider === provider && entry.id === id))
    return {
      block: true,
      reason: `Exact model ${model} is not available with configured authentication. Check the provider, model and login; entitlement remains unverified.`,
    }
  return undefined
}

/** Reads the user's current enable flag without consulting a project's configuration. */
export const currentUserDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  loadConfigWithSource({ projectDirectories: [], env }).pipe(
    Effect.map(({ config }) => !config.pi.enable),
    Effect.catch(() => Effect.succeed(undefined)),
  )

/** Reads the current profile flag without initializing project state. */
export const currentProfileRouting = (
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    if (env.HOLYAGENT_ROUTING_PROFILE?.trim()) return true
    const { root } = yield* resolveState(cwd, env, "peek", false)
    const { config } = yield* loadConfigWithSource({
      projectDirectories: [stateDirectory(root)],
      env,
    })
    return config.pi.profile !== undefined
  }).pipe(Effect.catch(() => Effect.succeed(undefined)))

/** Validates a managed launch against fresh read-only Core state and configuration. */
export const checkProfileLaunch = (
  input: Readonly<Record<string, unknown>>,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
) =>
  Effect.gen(function* () {
    const prompt = input["prompt"]
    const id = typeof prompt === "string" ? dispatchedAssignment(prompt) : undefined
    if (id === undefined)
      return "The Agent prompt does not identify a dispatched Assignment. Redispatch it."
    const context = yield* makeContext({
      cwd,
      env,
      host: "pi",
      authorize: (capability) => capability === "assignment.show",
      deferRouting: true,
    })
    const found = yield* assignment.show(context, { id })
    if (found.state !== "Running" || found.specialist?.intendedLaunch === undefined)
      return "The Assignment has no current profiled dispatch. Redispatch it."
    const form = context.execution.screenForm
    if (input["subagent_type"] !== agentFor(routeFor(found.roleTask), found.screen, form))
      return "The Agent role or screen capability does not match the current Assignment. Redispatch it."
    const { root } = yield* resolveState(cwd, env, "peek", false)
    const { config, written } = yield* loadConfigWithSource({
      projectDirectories: [stateDirectory(root)],
      env,
    })
    const raw = env.HOLYAGENT_ROUTING_PROFILE?.trim()
    const profile = raw ? raw : config.pi.profile
    if ((profile !== "normal" && profile !== "fast") || !config.pi.enable)
      return "The current routing profile is unavailable. Redispatch the Assignment."
    const selected = selectConfiguredRoute(
      config,
      written,
      "pi",
      found.roleTask,
      found.screen === true,
      profile,
      new Date().toISOString(),
    )
    const saved = found.specialist.intendedLaunch
    if (
      selected.error !== undefined ||
      saved.host !== "pi" ||
      saved.provider !== selected.provider ||
      saved.model !== selected.model ||
      saved.effort !== selected.effort ||
      saved.profile !== selected.profile ||
      saved.evidenceRevision !== selected.evidenceRevision
    )
      return "The Assignment routing selection is stale or conflicts with current configuration. Redispatch it."
    if (input["model"] !== saved.model || input["thinking"] !== saved.effort)
      return "The Agent model or thinking does not match the trusted Assignment selection. Redispatch it."
    return undefined
  }).pipe(
    Effect.catch(() =>
      Effect.succeed(
        "Trusted Assignment routing state is unavailable. Redispatch the Assignment and retry.",
      ),
    ),
  )
