import { stat } from "node:fs/promises"

import { encode } from "@toon-format/toon"
import { Effect, Schema } from "effect"

import { WORKFLOW_NAMES } from "../domain/plan.ts"
import root from "../instructions/claude-5.5/root.md" with { type: "text" }
import { hasCode, io } from "../state/files.ts"
import { PLUGIN_NAMESPACE } from "./assignment.ts"
import { describeFailure } from "./errors.ts"
import { statusOf } from "./overview.ts"
import { type GitWrite, gitWrites } from "./shell.ts"
import { type Command, Verbatim } from "./types.ts"

// The host reads a hook's stdout as JSON and treats exit 2 as a block, while any other failure
// lets the call through unless the hook asks to block on failure. So every failure here is exit 1
// with a line on stderr, and a hook that has nothing to say prints nothing and exits 0.

/** What a hook reads from the host's payload; the other fields are of no use here. */
const Payload = Schema.Struct({
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  agent_type: Schema.optionalKey(Schema.String),
})

const NOTHING = new Verbatim("", "", 0)

const output = (hookSpecificOutput: Readonly<Record<string, unknown>>) =>
  new Verbatim(`${JSON.stringify({ hookSpecificOutput })}\n`, "", 0)

const decision = (permissionDecision: "allow" | "deny", permissionDecisionReason: string) =>
  output({ hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason })

/** Runs a hook: a failure becomes one stderr line and exit 1, a notice that authorizes nothing. */
const hook = (
  name: string,
  summary: string,
  run: (payload: typeof Payload.Type, directory: string) => Effect.Effect<Verbatim, unknown>,
): Command => ({
  path: ["hook", name],
  usage: `hook ${name}`,
  summary,
  input: "the host's hook payload as JSON",
  output: "the JSON the host reads, or nothing; exit 1 with a stderr line on failure",
  flags: {},
  positionals: 0,
  run: ({ directory, text }) =>
    text.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))),
      Effect.flatMap((payload) => run(payload, directory)),
      Effect.catch((error) =>
        Effect.succeed(
          new Verbatim("", `holyagent hook ${name}: ${describeFailure(error).message}\n`, 1),
        ),
      ),
    ),
})

/** The agent types of the root: the plugin's `agent` setting applied, with or without namespace. */
const ROOT_AGENTS: ReadonlySet<string | undefined> = new Set(["holyagent", "holyagent:holyagent"])

const hasStateFolder = (directory: string) =>
  io(directory, () => stat(directory)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  )

const REDIRECTS: Readonly<Record<GitWrite, string>> = {
  commit:
    "Commit with `holyagent vcs commit -m <headline> -- <paths…>`, which commits as the account owner with the Intent's state.",
  push: "Push with `holyagent vcs push [branches…]`.",
}

const OUR_WORKFLOWS: ReadonlySet<unknown> = new Set(
  WORKFLOW_NAMES.map((name) => `${PLUGIN_NAMESPACE}:${name}`),
)
/** The Workflow inputs a named run may carry; a script, script path or resume would run other code. */
const NAMED_RUN_INPUTS: ReadonlySet<string> = new Set(["name", "args", "description", "title"])

/** The `hook` commands the plugin's hooks call. */
export const HOOK_COMMANDS: ReadonlyArray<Command> = [
  hook(
    "session-start",
    "SessionStart: add the status of the open Intents as context (and the root rules when the root agent is not the main thread); nothing without a .holyagent folder",
    (payload, directory) =>
      Effect.gen(function* () {
        if (!(yield* hasStateFolder(directory))) return NOTHING
        const status = `holyagent status:\n${encode(yield* statusOf(directory))}`
        return output({
          hookEventName: "SessionStart",
          additionalContext: ROOT_AGENTS.has(payload.agent_type)
            ? status
            : `${root.trim()}\n\n${status}`,
        })
      }),
  ),
  hook(
    "vcs-redirect",
    "PreToolUse for Bash: deny a command that runs git commit or git push and point to holyagent vcs; say nothing otherwise",
    (payload) => {
      const command = payload.tool_name === "Bash" ? payload.tool_input?.command : undefined
      const writes = typeof command === "string" ? gitWrites(command) : []
      return Effect.succeed(
        writes.length === 0
          ? NOTHING
          : decision("deny", writes.map((write) => REDIRECTS[write]).join(" ")),
      )
    },
  ),
  hook(
    "workflow",
    "PreToolUse for Workflow: allow a run of one of this plugin's prebuilt workflows by name; say nothing otherwise",
    (payload) => {
      const input = payload.tool_input ?? {}
      return Effect.succeed(
        payload.tool_name === "Workflow" &&
          OUR_WORKFLOWS.has(input.name) &&
          Object.keys(input).every((key) => NAMED_RUN_INPUTS.has(key))
          ? decision("allow", `Prebuilt workflow ${String(input.name)} of the holyagent plugin.`)
          : NOTHING,
      )
    },
  ),
]
