import { homedir } from "node:os"
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

const firstNonEmpty = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value !== "")

/**
 * The folder of the user's Claude Code settings: `CLAUDE_CONFIG_DIR` when set, else `.claude` in
 * the home directory (`HOME`, else `USERPROFILE` as on Windows, else the operating system's).
 */
export const claudeConfigDirectory = (env: Host["env"], home: () => string = homedir): string => {
  const configured = env.CLAUDE_CONFIG_DIR
  if (configured !== undefined && configured !== "") return configured
  return join(firstNonEmpty(env.HOME, env.USERPROFILE) ?? home(), ".claude")
}

/**
 * Whether the host offers workflows: yes unless `CLAUDE_CODE_DISABLE_WORKFLOWS=1` or one of the
 * user's `settings.json` (see {@link claudeConfigDirectory}), `<root>/.claude/settings.json` and
 * `<root>/.claude/settings.local.json` sets `disableWorkflows` true or `enableWorkflows` false.
 */
export const workflowsAvailable = (env: Host["env"], root: string) => {
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

/** The warm-reuse settings: the TTL from the environment and whether workflows are available. */
export const loadConfig = (env: Host["env"], root: string) =>
  Effect.all({ ttlMinutes: reuseTtl(env), workflowsAvailable: workflowsAvailable(env, root) }).pipe(
    Effect.map((config): ExecutionConfig => config),
  )
