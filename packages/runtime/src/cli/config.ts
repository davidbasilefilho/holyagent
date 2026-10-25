import { join } from "node:path"

import { Effect, Schema } from "effect"

import { DEFAULT_CONFIG, type ExecutionConfig } from "../domain/directive.ts"
import { readText } from "../state/files.ts"
import { Usage } from "./errors.ts"
import type { Host } from "./types.ts"

const TTL_VARIABLE = "HOLYAGENT_REUSE_TTL_MINUTES"

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

/**
 * Whether the host offers workflows: yes unless `CLAUDE_CODE_DISABLE_WORKFLOWS=1` or one of
 * `~/.claude/settings.json`, `<root>/.claude/settings.json` and
 * `<root>/.claude/settings.local.json` sets `disableWorkflows` true or `enableWorkflows` false.
 */
export const workflowsAvailable = (env: Host["env"], root: string) => {
  if (env.CLAUDE_CODE_DISABLE_WORKFLOWS === "1") return Effect.succeed(false)
  const files = [
    ...(env.HOME === undefined ? [] : [join(env.HOME, ".claude", "settings.json")]),
    join(root, ".claude", "settings.json"),
    join(root, ".claude", "settings.local.json"),
  ]
  return Effect.forEach(files, disablesWorkflows).pipe(
    Effect.map((disabled) => !disabled.includes(true)),
  )
}

/** The warm-reuse settings: the TTL from the environment and whether workflows are available. */
export const loadConfig = (env: Host["env"], root: string) =>
  Effect.all({ ttlMinutes: reuseTtl(env), workflowsAvailable: workflowsAvailable(env, root) }).pipe(
    Effect.map((config): ExecutionConfig => config),
  )
