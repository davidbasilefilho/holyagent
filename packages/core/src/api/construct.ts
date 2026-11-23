import { join } from "node:path"

import { Effect, Schema } from "effect"

import { firstNonEmpty, homeDirectory } from "../config/environment.ts"
import { loadConfig } from "../config/load.ts"
import { DEFAULT_CONFIG, type ExecutionConfig } from "../domain/directive.ts"
import { InvalidDraft } from "../domain/errors.ts"
import type { AgentHost } from "../domain/host.ts"
import type { RoleTask } from "../domain/route.ts"
import { readText } from "../state/files.ts"
import { stateDirectory } from "../state/layout.ts"
import { resolveState } from "../state/tree.ts"
import type { Capability, Context } from "./context.ts"

/** Trusted host inputs to context construction; no field comes from operation input. */
export interface ContextOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly host: AgentHost
  readonly authorize: (capability: Capability) => boolean
  readonly firstPass?: Readonly<Partial<Record<RoleTask, string>>>
  /** Current workflow-tool exposure when the host can establish it. */
  readonly workflowsAvailable?: boolean
  /** Skip launch-only settings for operations that do not choose a model or warm worker. */
  readonly deferRouting?: true
}

const setting = (raw: string | undefined) => raw?.trim() || undefined
const WorkflowSettings = Schema.Struct({
  disableWorkflows: Schema.optionalKey(Schema.Boolean),
  enableWorkflows: Schema.optionalKey(Schema.Boolean),
})
const disables = (path: string) =>
  readText(path).pipe(
    Effect.flatMap((text) =>
      text === undefined
        ? Effect.succeed(false)
        : Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowSettings))(text).pipe(
            Effect.map(
              (value) => value.disableWorkflows === true || value.enableWorkflows === false,
            ),
          ),
    ),
    Effect.orElseSucceed(() => false),
  )
const screenForm = (env: ContextOptions["env"]): "headless" | "normal" => {
  const ci = setting(env.CI)?.toLowerCase()
  const inCi = ci !== undefined && !["0", "false", "no", "off"].includes(ci)
  const display =
    process.platform === "win32" ||
    process.platform === "darwin" ||
    !!setting(env.DISPLAY) ||
    !!setting(env.WAYLAND_DISPLAY)
  return env.CLAUDE_CODE_REMOTE === "true" || inCi || !display ? "headless" : "normal"
}

/** Resolves the host's workflow availability without reading unrelated routing settings. */
export const workflowAvailability = (
  options: Pick<ContextOptions, "env" | "host" | "workflowsAvailable">,
  root: string,
) =>
  Effect.gen(function* () {
    const { env, host } = options
    const workflowSetting = setting(env.HOLYAGENT_WORKFLOWS)
    if (workflowSetting !== undefined && workflowSetting !== "0" && workflowSetting !== "1")
      return yield* new InvalidDraft({
        message: `HOLYAGENT_WORKFLOWS must be 1 or 0, not ${JSON.stringify(workflowSetting)}`,
      })
    if (workflowSetting !== undefined) return workflowSetting === "1"
    if (options.workflowsAvailable !== undefined) return options.workflowsAvailable
    if (host === "pi" || env.CLAUDE_CODE_DISABLE_WORKFLOWS === "1") return false
    const claudeDir = firstNonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(homeDirectory(env), ".claude")
    return !(yield* Effect.forEach(
      [
        join(claudeDir, "settings.json"),
        join(root, ".claude", "settings.json"),
        join(root, ".claude", "settings.local.json"),
      ],
      disables,
    )).includes(true)
  })

/** Resolves warm reuse, workflow exposure and profile policy using trusted host inputs. */
export const executionConfig = (options: ContextOptions, root: string) =>
  Effect.gen(function* () {
    const { env, host } = options
    const ttl = setting(env.HOLYAGENT_REUSE_TTL_MINUTES)
    const ttlMinutes =
      ttl === undefined
        ? DEFAULT_CONFIG.ttlMinutes
        : yield* Schema.decodeUnknownEffect(
            Schema.NumberFromString.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
          )(ttl).pipe(
            Effect.mapError(
              () =>
                new InvalidDraft({
                  message: "HOLYAGENT_REUSE_TTL_MINUTES must be a nonnegative number",
                }),
            ),
          )
    const available = yield* workflowAvailability(options, root)
    const pi =
      host === "pi"
        ? yield* loadConfig({ projectDirectories: [stateDirectory(root)], env }).pipe(
            Effect.map((config) => config.pi),
            Effect.orElseSucceed(() => undefined),
          )
        : undefined
    const rawProfile = setting(env.HOLYAGENT_ROUTING_PROFILE)
    if (rawProfile !== undefined && rawProfile !== "normal" && rawProfile !== "fast")
      return yield* new InvalidDraft({
        message: "HOLYAGENT_ROUTING_PROFILE must be normal or fast",
      })
    const profileRouting =
      pi?.enable === false ? false : rawProfile !== undefined || pi?.profile !== undefined
    return {
      host,
      ttlMinutes,
      screenForm: screenForm(env),
      workflowsAvailable: available && !(host === "pi" && profileRouting),
      ...(profileRouting ? { profileRouting: true as const } : {}),
    } satisfies ExecutionConfig
  })

/** Constructs an operation context from trusted host inputs without writing state. */
export const makeContext = (options: ContextOptions) =>
  Effect.gen(function* () {
    const execution =
      options.deferRouting === true
        ? { ...DEFAULT_CONFIG, host: options.host, screenForm: screenForm(options.env) }
        : yield* resolveState(options.cwd, options.env, "peek", false).pipe(
            Effect.flatMap(({ root }) => executionConfig(options, root)),
          )
    return {
      cwd: options.cwd,
      env: options.env,
      host: options.host,
      authorize: options.authorize,
      execution,
      ...(options.firstPass === undefined ? {} : { firstPass: options.firstPass }),
    } satisfies Context
  })
