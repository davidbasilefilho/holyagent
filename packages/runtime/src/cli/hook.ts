import { readdir, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect, Schema } from "effect"

import { WORKFLOW_NAMES } from "../domain/plan.ts"
import { ROUTES } from "../domain/route.ts"
import { ROOT_CORE } from "../instructions/claude-5.5/root-core.ts"
import { hasCode, io } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { readOpenState } from "../state/store.ts"
import { PLUGIN_NAMESPACE, recordLaunch } from "./assignment.ts"
import { stateRoot } from "./context.ts"
import { AgentIdMissing, describeFailure, StateFolderMissing } from "./errors.ts"
import { resolveIntent } from "./intent.ts"
import { resumeOf, statusOf } from "./overview.ts"
import { dispatchedAssignment } from "./report.ts"
import { type IntentRequirements, sessionContext } from "./sessioncontext.ts"
import { type GitWrite, gitWrites } from "./shell.ts"
import { type Call, type Command, Verbatim } from "./types.ts"

// The host reads a hook's stdout as JSON and treats exit 2 as a block, while any other failure
// lets the call through unless the hook asks to block on failure. So every failure here is exit 1
// with a line on stderr, and a hook that has nothing to say prints nothing and exits 0.

/** What a hook reads from the host's payload; the other fields are of no use here. */
const Payload = Schema.Struct({
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  agent_type: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  tool_response: Schema.optionalKey(Schema.Unknown),
})

const NOTHING = new Verbatim("", "", 0)

const output = (hookSpecificOutput: Readonly<Record<string, unknown>>) =>
  new Verbatim(`${JSON.stringify({ hookSpecificOutput })}\n`, "", 0)

const decision = (permissionDecision: "allow" | "deny", permissionDecisionReason: string) =>
  output({ hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason })

/**
 * Runs a hook: a failure becomes one stderr line and exit 1, a notice that authorizes nothing. A
 * `stateless` hook never looks for the state root, so a git failure cannot stop it; `agent-launch`
 * finds the root itself, inside its own failure handling, to report a git failure as context.
 */
const hook = (
  name: string,
  summary: string,
  run: (payload: typeof Payload.Type, call: Call) => Effect.Effect<Verbatim, unknown>,
  stateless?: true,
): Command => ({
  path: ["hook", name],
  usage: `hook ${name}`,
  summary,
  input: "the host's hook payload as JSON",
  output: "the JSON the host reads, or nothing; exit 1 with a stderr line on failure",
  flags: {},
  positionals: 0,
  ...(stateless === undefined ? {} : { stateless }),
  run: (call) =>
    call.text.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))),
      Effect.flatMap((payload) => run(payload, call)),
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

/** The SessionStart sources after which pending notices are lost and the Running rows need a check. */
const RESUMED: ReadonlySet<string | undefined> = new Set(["resume", "compact"])

/**
 * The requirements of the Intent in use, as `intent show` resolves it, for a session that lost
 * them; nothing when no Intent is in use.
 */
const requirementsOf = (
  directory: string,
): Effect.Effect<IntentRequirements | undefined, unknown> =>
  readOpenState(directory).pipe(
    Effect.flatMap(resolveIntent),
    Effect.map(({ id, revision, requirements }) => ({ id, revision, requirements })),
    Effect.catchTag("NoActiveIntent", () => Effect.succeed(undefined)),
  )

/** Ids the host makes are short words; anything else is not echoed into a command to run. */
const SAFE_ID = /^[\w.:-]{1,80}$/

/**
 * The agent id of an Agent launch: `agentId` of the tool response, which a background launch
 * (`status: "async_launched"`) and a finished one (`status: "completed"`) both carry.
 */
const launchedAgent = (response: unknown): string | undefined => {
  const agentId =
    typeof response === "object" && response !== null && "agentId" in response
      ? response.agentId
      : undefined
  return typeof agentId === "string" && SAFE_ID.test(agentId) ? agentId : undefined
}

/**
 * What the root does about a launch the hook could not record, for the failures where recording by
 * hand cannot succeed; any other failure may pass on a retry, so it gets the record command.
 */
const HAND_BACK: Readonly<Record<string, string>> = {
  AgentMismatch:
    "The wrong agent was launched: dispatch the Assignment again with the printed agent.",
  StateFolderMissing: "Run the command from the project that holds the Assignment.",
  InvalidTransition: "Check the Assignment with `holyagent assignment show`; it is not Running.",
  UnknownRecord: "Check the id with `holyagent assignment list --all`.",
}

const postToolUse = (additionalContext: string) =>
  output({ hookEventName: "PostToolUse", additionalContext })

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

const SPECIALISTS: ReadonlySet<string> = new Set(ROUTES.map((route) => route.agent))

/**
 * True for `holyagent:<agent>` or a bare `<agent>` of the route table; any other namespace is not
 * ours.
 */
const isOurAgent = (agent: unknown): boolean =>
  typeof agent === "string" &&
  SPECIALISTS.has(
    agent.startsWith(`${PLUGIN_NAMESPACE}:`) ? agent.slice(PLUGIN_NAMESPACE.length + 1) : agent,
  )

/** True when every `agent` anywhere in the arguments is one of ours; the arguments name who runs. */
const agentsAreOurs = (value: unknown, depth = 0): boolean => {
  if (depth > 8) return false
  if (Array.isArray(value)) return value.every((item: unknown) => agentsAreOurs(item, depth + 1))
  if (typeof value !== "object" || value === null) return true
  return Object.entries(value).every(([key, item]) =>
    key === "agent" ? isOurAgent(item) : agentsAreOurs(item, depth + 1),
  )
}

/**
 * The folders a project or user workflow could be loaded from under the same name:
 * `.claude/workflows` of the working directory and each parent, of the home directory and of
 * CLAUDE_CONFIG_DIR.
 */
const workflowFolders = (call: Call): ReadonlyArray<string> => {
  const parents: Array<string> = []
  for (let at = call.cwd; !parents.includes(at); at = dirname(at)) parents.push(at)
  return [
    ...parents.map((parent) => join(parent, ".claude", "workflows")),
    ...(call.env.HOME === undefined ? [] : [join(call.env.HOME, ".claude", "workflows")]),
    ...(call.env.CLAUDE_CONFIG_DIR === undefined
      ? []
      : [join(call.env.CLAUDE_CONFIG_DIR, "workflows")]),
  ]
}

/** True when the `export const meta` literal of a script mentions our name, in any case. */
const declaresOurName = (script: string): boolean => {
  const start = script.search(/export\s+const\s+meta\b/)
  if (start === -1) return false
  const end = script.indexOf("\n}", start)
  return script
    .slice(start, end === -1 ? start + 4000 : end)
    .toLowerCase()
    .includes(PLUGIN_NAMESPACE)
}

/**
 * True when a workflow file that could take over one of our names may exist: a file named
 * `holyagent…` in those folders, a script there whose meta mentions `holyagent` (the name comes
 * from the meta, not the file), or a folder or file that cannot be read, since then nobody can
 * say.
 */
const shadowed = (call: Call) =>
  Effect.forEach(workflowFolders(call), (folder) =>
    io(folder, () => readdir(folder)).pipe(
      Effect.flatMap((names) =>
        names.some((name) => name.toLowerCase().startsWith(PLUGIN_NAMESPACE))
          ? Effect.succeed(true)
          : Effect.forEach(
              names.filter((name) => name.endsWith(".js")),
              (name) =>
                io(join(folder, name), () => Bun.file(join(folder, name)).text()).pipe(
                  Effect.map(declaresOurName),
                ),
            ).pipe(Effect.map((found) => found.includes(true))),
      ),
      Effect.catchIf(
        (error) => hasCode(error.cause, "ENOENT") || hasCode(error.cause, "ENOTDIR"),
        () => Effect.succeed(false),
      ),
      Effect.orElseSucceed(() => true),
    ),
  ).pipe(Effect.map((found) => found.includes(true)))

// The vcs-redirect hook only sees what the `if` rules of hooks.json let through, and those match
// the command text: `git` followed by `commit` or `push` anywhere in it. A command that hides the
// words escapes it: a variable (`g=git; $g commit`), a git alias (`git ci`), or a script, make
// target or package script that runs git inside. Wrappers, `sh -c`, `xargs`, subshells and
// substitutions that show the words reach the scanner and are denied.

/** The `hook` commands the plugin's hooks call. */
export const HOOK_COMMANDS: ReadonlyArray<Command> = [
  hook(
    "session-start",
    "SessionStart: add the status of the open Intents as context, with the reconcile result and the requirements of the Intent in use after a resume or compaction (and the core root rules when the root agent is not the main thread), always ending with a short block of the root rules most often missed; nothing without a .holyagent folder",
    (payload, call) =>
      Effect.gen(function* () {
        if (!(yield* hasStateFolder(call.directory))) return NOTHING
        const pluginRoot = call.env.CLAUDE_PLUGIN_ROOT
        // The host fills in ${CLAUDE_PLUGIN_ROOT} in agent text only, and this text is context.
        const core = ROOT_CORE.replaceAll(
          "${CLAUDE_PLUGIN_ROOT}",
          pluginRoot ?? "${CLAUDE_PLUGIN_ROOT}",
        )
        const { status, reconcile } = RESUMED.has(payload.source)
          ? yield* resumeOf(call.directory)
          : { status: yield* statusOf(call.directory), reconcile: undefined }
        return output({
          hookEventName: "SessionStart",
          additionalContext: sessionContext(
            status,
            ROOT_AGENTS.has(payload.agent_type) ? undefined : core,
            reconcile,
            RESUMED.has(payload.source) ? yield* requirementsOf(call.directory) : undefined,
          ),
        })
      }),
  ),
  hook(
    "agent-launch",
    "PostToolUse for Agent: when the prompt came from assignment dispatch, record the launched agent (assignment record <id> --agent <agentId>) and say so; on failure ask the root to record it; nothing for any other launch",
    (payload, call) => {
      const prompt = payload.tool_name === "Agent" ? payload.tool_input?.prompt : undefined
      const id = typeof prompt === "string" ? dispatchedAssignment(prompt) : undefined
      if (id === undefined) return Effect.succeed(NOTHING)
      const agentId = launchedAgent(payload.tool_response)
      // Recording is bookkeeping and authorizes nothing, so any failure only hands the step back.
      return Effect.gen(function* () {
        if (agentId === undefined) return yield* new AgentIdMissing()
        const directory = join(yield* stateRoot(call.cwd), STATE_DIRECTORY)
        // The state folder is not made here: a project without one has no Assignment to record.
        if (!(yield* hasStateFolder(directory))) return yield* new StateFolderMissing()
        const type = payload.tool_input?.subagent_type
        yield* recordLaunch(directory, id, agentId, {
          type: typeof type === "string" ? type : undefined,
        })
        return postToolUse(`holyagent: recorded agent ${agentId} for ${id}.`)
      }).pipe(
        Effect.catch((error) => {
          const { tag } = describeFailure(error)
          const next =
            HAND_BACK[tag] ??
            `Run \`holyagent assignment record ${id} --agent ${agentId ?? "<agentId>"}\` yourself.`
          return Effect.succeed(
            postToolUse(`holyagent: could not record the launch of ${id} (${tag}). ${next}`),
          )
        }),
      )
    },
    true,
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
    true,
  ),
  hook(
    "workflow",
    "PreToolUse for Workflow: allow a run of one of this plugin's prebuilt workflows by name, with only our specialists in its arguments and no file that could shadow it; say nothing otherwise",
    (payload, call) =>
      Effect.gen(function* () {
        const input = payload.tool_input ?? {}
        const prebuilt =
          payload.tool_name === "Workflow" &&
          OUR_WORKFLOWS.has(input.name) &&
          Object.keys(input).every((key) => NAMED_RUN_INPUTS.has(key)) &&
          agentsAreOurs(input.args)
        return prebuilt && !(yield* shadowed(call))
          ? decision("allow", `Prebuilt workflow ${String(input.name)} of the holyagent plugin.`)
          : NOTHING
      }),
    true,
  ),
]
