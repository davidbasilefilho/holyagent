import { executionConfig, workflowAvailability } from "@holyagent/core"
import { Effect, Schema } from "effect"

import { AGENT_HOSTS, type AgentHost } from "../domain/host.ts"
import { Usage } from "./errors.ts"
import type { Host } from "./types.ts"

/** Environment variable naming the trusted CLI host. */
export const HOST_VARIABLE = "HOLYAGENT_HOST"
/** Environment variable explicitly selecting workflow availability. */
export const WORKFLOWS_VARIABLE = "HOLYAGENT_WORKFLOWS"

/** Resolves the host named by the CLI environment. */
export const agentHostOf = (env: Host["env"]) => {
  const value = env[HOST_VARIABLE]?.trim()
  return value === undefined || value === ""
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

/** Reads workflow availability through the shared configuration logic. */
export const workflowsAvailable = (env: Host["env"], root: string) =>
  Effect.gen(function* () {
    const host = env[WORKFLOWS_VARIABLE]?.trim() ? "claude" : yield* agentHostOf(env)
    return yield* workflowAvailability({ env, host }, root).pipe(
      Effect.mapError(
        (error) =>
          new Usage({
            message: error.message,
            hint: `Unset ${WORKFLOWS_VARIABLE} to let the host decide.`,
          }),
      ),
    )
  })

/** Reads execution policy through the shared configuration logic. */
export const loadConfig = (env: Host["env"], root: string) =>
  Effect.gen(function* () {
    const host = yield* agentHostOf(env)
    return yield* executionConfig({ cwd: root, env, host, authorize: () => true }, root).pipe(
      Effect.mapError(
        (error) =>
          new Usage({ message: error.message, hint: "Check HolyAgent execution settings." }),
      ),
    )
  })
