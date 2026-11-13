import { join } from "node:path"

import { Clock, Effect, Schema } from "effect"

import { loadConfig as loadHolyagentConfig, loadConfigWithSource } from "../config/load.ts"
import { DEFAULT_CONFIG, type ExecutionConfig } from "../domain/directive.ts"
import { AGENT_HOSTS, type AgentHost } from "../domain/host.ts"
import { type IntendedLaunch, type RoleTask, routeFor } from "../domain/route.ts"
import { routeModel, subagentModel } from "../pi/provider.ts"
import { type RoutingSelection, selectConfiguredRoute } from "../routing/selection.ts"
import { claudeConfigDirectory } from "../setup/environment.ts"
import { detectForm } from "../setup/form.ts"
import { readText } from "../state/files.ts"
import { stateDirectory } from "../state/layout.ts"
import { Usage } from "./errors.ts"
import type { Host } from "./types.ts"

const TTL_VARIABLE = "HOLYAGENT_REUSE_TTL_MINUTES"

/** The environment variable that names the agent host: `claude` (the default) or `pi`. */
export const HOST_VARIABLE = "HOLYAGENT_HOST"

/**
 * The environment variable that says whether the host offers workflows: `1` or `0`. It decides on
 * either host when set; unset, Claude's own settings decide and pi has none.
 */
export const WORKFLOWS_VARIABLE = "HOLYAGENT_WORKFLOWS"

const Minutes = Schema.NumberFromString.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))

const reuseTtl = (env: Host["env"]) => {
  const raw = env[TTL_VARIABLE]
  return raw === undefined || raw.trim() === ""
    ? Effect.succeed(DEFAULT_CONFIG.ttlMinutes)
    : Schema.decodeUnknownEffect(Minutes)(raw.trim()).pipe(
        Effect.mapError(
          () =>
            new Usage({
              message: `${TTL_VARIABLE} must be a number of minutes, not "${raw}"`,
              hint: `Unset ${TTL_VARIABLE} for the default of ${DEFAULT_CONFIG.ttlMinutes}.`,
            }),
        ),
      )
}

/** A setting's value without surrounding space; undefined when it is unset or blank. */
const given = (raw: string | undefined): string | undefined =>
  raw === undefined || raw.trim() === "" ? undefined : raw.trim()

/**
 * The agent host the process runs under: `HOLYAGENT_HOST` (`claude` or `pi`), `claude` when unset.
 * The pi extension sets it so the output names pi's tools.
 */
export const agentHostOf = (env: Host["env"]) => {
  const value = given(env[HOST_VARIABLE])
  return value === undefined
    ? Effect.succeed<AgentHost>("claude")
    : Schema.decodeUnknownEffect(Schema.Literals(AGENT_HOSTS))(value).pipe(
        Effect.mapError(
          () =>
            new Usage({
              message: `${HOST_VARIABLE} must be ${AGENT_HOSTS.join(" or ")}, not "${value}"`,
              hint: `Unset ${HOST_VARIABLE} for the default of claude.`,
            }),
        ),
      )
}

const WorkflowsSwitch = Schema.Literals(["0", "1"])

// Other keys of a settings file are none of our business, so unlike our own state this decode
// ignores them, and a settings file that cannot be read or parsed counts as not saying anything.
const WorkflowSettings = Schema.Struct({
  disableWorkflows: Schema.optionalKey(Schema.Boolean),
  enableWorkflows: Schema.optionalKey(Schema.Boolean),
})

const disablesWorkflows = (path: string) =>
  readText(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(false)
        : Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowSettings))(text).pipe(
            Effect.map(
              (settings) =>
                settings.disableWorkflows === true || settings.enableWorkflows === false,
            ),
          ),
    ),
    Effect.orElseSucceed(() => false),
  )

const claudeWorkflowsAvailable = (env: Host["env"], root: string) => {
  if (env.CLAUDE_CODE_DISABLE_WORKFLOWS === "1") return Effect.succeed(false)
  const files = [
    join(claudeConfigDirectory(env), "settings.json"),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ]
  return Effect.forEach(files, disablesWorkflows).pipe(
    Effect.map((disabled) => !disabled.includes(true)),
  )
}

/**
 * Whether the host offers workflows. `HOLYAGENT_WORKFLOWS` decides when set (`1` or `0`, on either
 * host). Unset, Claude offers them unless `CLAUDE_CODE_DISABLE_WORKFLOWS=1` or one of the user's
 * `settings.json` (see {@link claudeConfigDirectory}), `<root>/.claude/settings.json` and
 * `<root>/.claude/settings.local.json` sets `disableWorkflows` true or `enableWorkflows` false, and
 * pi does not: only its extension can see whether `SubagentWorkflow` is active, so it sets the
 * variable and the plan falls back to direct subagents until it does.
 */
export const workflowsAvailable = (env: Host["env"], root: string) => {
  const setting = given(env[WORKFLOWS_VARIABLE])
  if (setting !== undefined)
    return Schema.decodeUnknownEffect(WorkflowsSwitch)(setting).pipe(
      Effect.map((value) => value === "1"),
      Effect.mapError(
        () =>
          new Usage({
            message: `${WORKFLOWS_VARIABLE} must be 1 or 0, not "${setting}"`,
            hint: `Unset ${WORKFLOWS_VARIABLE} to let the host decide.`,
          }),
      ),
    )
  return agentHostOf(env).pipe(
    Effect.flatMap((host) =>
      host === "pi" ? Effect.succeed(false) : claudeWorkflowsAvailable(env, root),
    ),
  )
}

/**
 * The execution settings: the TTL from the environment, whether workflows are available, the agent
 * host and the form of the machine (the one setup and doctor detect), which picks the agent file of
 * a screen Assignment.
 */
export const loadConfig = (env: Host["env"], root: string) =>
  Effect.gen(function* () {
    const host = yield* agentHostOf(env)
    const workflows = yield* workflowsAvailable(env, root)
    // Pi's workflow host can resolve a requested model to a different provider. A profile uses
    // direct Agent calls, whose explicit model can be checked by the host's tool-call gate.
    const piConfig =
      host === "pi"
        ? yield* loadHolyagentConfig({ projectDirectories: [stateDirectory(root)], env }).pipe(
            Effect.map((config) => config.pi),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined
    const profileRouting =
      piConfig?.enable === false
        ? false
        : given(env["HOLYAGENT_ROUTING_PROFILE"]) !== undefined || piConfig?.profile !== undefined
    return {
      ttlMinutes: yield* reuseTtl(env),
      workflowsAvailable: workflows && !(host === "pi" && profileRouting),
      host,
      screenForm: detectForm(env).form,
      ...(profileRouting ? { profileRouting: true as const } : {}),
    } satisfies ExecutionConfig
  })

/**
 * The model and effort a dispatch prints for a specialist, which the root passes to its launcher as
 * printed. Either is absent when the host should pick it.
 */
export interface Launch {
  /** The model the host launches the specialist on. */
  readonly model?: string
  /** The reasoning effort (pi: thinking level) the host launches the specialist at. */
  readonly effort?: string
  /** Present only for an explicitly activated subscription profile. */
  readonly routing?: RoutingSelection
  /** Requested launch identity; it is not an observation of the running model. */
  readonly intendedLaunch?: IntendedLaunch
}

/** Explicit session profile activation; absent keeps the existing host policy. */
export const ROUTING_PROFILE_VARIABLE = "HOLYAGENT_ROUTING_PROFILE"

/** Resolves each specialist launch before dispatch, preserving explicit per-role overrides. */
export const launchesOf = (env: Host["env"], root: string, host: AgentHost) =>
  Effect.gen(function* () {
    const raw = given(env[ROUTING_PROFILE_VARIABLE])
    const requested =
      raw === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(Schema.Literals(["normal", "fast"]))(raw).pipe(
            Effect.mapError(
              () =>
                new Usage({
                  message: `${ROUTING_PROFILE_VARIABLE} must be normal or fast, not "${raw}"`,
                  hint: `Unset ${ROUTING_PROFILE_VARIABLE} to retain the current policy.`,
                }),
            ),
          )
    // Claude's old path never read a HolyAgent config. Preserve it unless the profile is explicit.
    if (host === "claude" && requested === undefined)
      return (roleTask: RoleTask, _screen?: boolean): Launch => {
        const { model, effort } = routeFor(roleTask)
        return { model, effort }
      }
    const { config, written } = yield* loadConfigWithSource({
      projectDirectories: [stateDirectory(root)],
      env,
    })
    const profile = requested ?? (host === "pi" ? config.pi.profile : undefined)
    const now = new Date(yield* Clock.currentTimeMillis).toISOString()
    return (roleTask: RoleTask, screen?: boolean): Launch => {
      if (host === "pi" && !config.pi.enable) return {}
      if (profile === undefined) {
        const route = routeModel(config, roleTask, { screen: screen === true })
        return { model: subagentModel(route), effort: route.thinking }
      }
      const chosen = selectConfiguredRoute(
        config,
        written,
        host,
        roleTask,
        screen === true,
        profile,
        now,
      )
      return {
        model: chosen.model,
        effort: chosen.effort,
        routing: chosen,
        intendedLaunch: {
          host,
          provider: chosen.provider,
          model: chosen.model,
          effort: chosen.effort,
          profile,
          ...(chosen.evidenceRevision === undefined
            ? {}
            : { evidenceRevision: chosen.evidenceRevision }),
        },
      }
    }
  })
