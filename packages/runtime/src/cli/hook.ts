import { stat } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Schema } from "effect"

import { ROOT_CORE } from "../instructions/claude-5.5/root-core.ts"
import stateChanges from "../instructions/claude-5.5/specialist/state-changes.md" with { type: "text" }
import { hasCode, io } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { legacyFoldersWithState } from "../state/legacy.ts"
import { readOpenState, updateState } from "../state/store.ts"
import { resolveState } from "../state/tree.ts"
import { MessageRefused } from "../vcs/errors.ts"
import { gitMaybe } from "../vcs/git.ts"
import { cleanMessage, forbiddenPhrases } from "../vcs/message.ts"
import { readSettings } from "../vcs/settings.ts"
import { recordLaunch } from "./assignment.ts"
import { AgentIdMissing, describeFailure, StateFolderMissing } from "./errors.ts"
import { resolveIntent } from "./intent.ts"
import { resumeOf, statusOf } from "./overview.ts"
import { dispatchedAssignment } from "./report.ts"
import {
  bareContext,
  type IntentRequirements,
  legacyContext,
  ROOT_TAKEOVER,
  sessionContext,
} from "./sessioncontext.ts"
import { type Call, type Command, Verbatim } from "./types.ts"
import { workflowRefusal } from "./workflow-check.ts"

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

/**
 * The version-control rules of the specialist text, which a SubagentStart hook adds to the context
 * of every holyagent specialist at its start; the text is the specialist section itself, so the
 * rule has one owner.
 */
export const SPECIALIST_RULES: string = stateChanges.trim()

/** The one-line reminder a PreToolUse hook adds to a Bash command that mentions git commit or push. */
export const VCS_REMINDER =
  "Version control is the root's: it commits with `holyagent vcs commit`, never force-pushes and pushes to a protected branch only with the user's approval; a specialist makes no version-control writes."

/** The agent types of the plugin's specialists: namespaced by the plugin, the root excepted. */
const isSpecialist = (type: string | undefined): boolean =>
  type !== undefined && type.startsWith("holyagent:") && !ROOT_AGENTS.has(type)

/**
 * The text the host's `if` rules of the hook (`Bash(*git*commit*)`, `Bash(*git*push*)`) match:
 * `git` followed somewhere by `commit` or `push`. A command without it gets no reminder.
 */
const MENTIONS_GIT_WRITE = /git[\s\S]*(?:commit|push)/i

/**
 * The value of a git setting from the repository's own files, not from a `-c` on the command line
 * (or `GIT_CONFIG_PARAMETERS`), which the caller of `git commit` could set to hide text.
 */
const fileSetting = (key: string) =>
  gitMaybe(["config", "--show-origin", "--get", key]).pipe(
    Effect.map((line) => {
      if (line === undefined) return undefined
      const [origin = "", ...value] = line.split("\t")
      return origin.startsWith("command line:") ? undefined : value.join("\t")
    }),
  )

/**
 * The text that starts a comment line in a commit message file: `core.commentString` or
 * `core.commentChar` of the repository's files, else `#` (`auto` too, which only picks another
 * character when the message already uses `#`).
 */
const commentPrefix = Effect.gen(function* () {
  const configured =
    (yield* fileSetting("core.commentString")) ?? (yield* fileSetting("core.commentChar"))
  return configured === undefined || configured === "" || configured === "auto" ? "#" : configured
})

/** The Workflow inputs an inline run may carry; a script path, name or resume would run other code. */
const INLINE_INPUTS: ReadonlySet<string> = new Set(["script", "args"])

// Both version-control hooks only add context, so neither can deny, allow or block: they carry no
// permission decision, and the plugin wires them without `onFailure: block`.

/** The `hook` commands the plugin's hooks call. */
export const HOOK_COMMANDS: ReadonlyArray<Command> = [
  hook(
    "session-start",
    "SessionStart: add the status of the open Intents as context, with the reconcile result and the requirements of the Intent in use after a resume or compaction (and the core root rules with a line that makes the main thread the root, when the holyagent agent is not the main thread), always ending with a short block of the root rules most often missed; for a project with no .holyagent and a .holyclaude or .holycodex folder that holds state to convert, a notice naming the folder and `holyagent migrate`, with the same rules; for a project with none of the three, the core root rules with that line and the reminder when the holyagent agent is not the main thread, otherwise nothing",
    (payload, call) =>
      Effect.gen(function* () {
        const pluginRoot = call.env.CLAUDE_PLUGIN_ROOT
        // The host fills in ${CLAUDE_PLUGIN_ROOT} in agent text only, and this text is context.
        // A main thread that is not the root gets the core and the line that makes it the root.
        const core = ROOT_AGENTS.has(payload.agent_type)
          ? undefined
          : [ROOT_CORE, ROOT_TAKEOVER]
              .join("\n\n")
              .replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot ?? "${CLAUDE_PLUGIN_ROOT}")
        if (!(yield* hasStateFolder(call.directory))) {
          const found = yield* legacyFoldersWithState(call.root)
          // Nothing to show or convert: only a main thread that lacks the root rules gets them.
          if (found.length === 0)
            return core === undefined
              ? NOTHING
              : output({ hookEventName: "SessionStart", additionalContext: bareContext(core) })
          return output({
            hookEventName: "SessionStart",
            additionalContext: legacyContext(found, core),
          })
        }
        const { status, reconcile } = RESUMED.has(payload.source)
          ? yield* resumeOf(call.directory)
          : { status: yield* statusOf(call.directory), reconcile: undefined }
        return output({
          hookEventName: "SessionStart",
          additionalContext: sessionContext(
            status,
            core,
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
        const { directory } = yield* resolveState(call.cwd, call.env, "ifPresent")
        // The state folder is not made here: a project without one has no Assignment to record.
        if (!(yield* hasStateFolder(directory))) return yield* new StateFolderMissing()
        const type = payload.tool_input?.subagent_type
        yield* recordLaunch(
          (transition) => updateState(directory, transition, call.env),
          id,
          agentId,
          {
            type: typeof type === "string" ? type : undefined,
          },
        )
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
    "subagent-start",
    "SubagentStart: add the version-control rules of the specialist text to the context of a holyagent specialist at its start; nothing for the root or any other agent",
    (payload) =>
      Effect.succeed(
        isSpecialist(payload.agent_type)
          ? output({ hookEventName: "SubagentStart", additionalContext: SPECIALIST_RULES })
          : NOTHING,
      ),
    true,
  ),
  hook(
    "vcs-reminder",
    "PreToolUse for Bash: for a command that mentions git and then commit or push, add a one-line reminder of the version-control rules as context; never a permission decision, and nothing for any other command",
    (payload) => {
      const command = payload.tool_name === "Bash" ? payload.tool_input?.command : undefined
      return Effect.succeed(
        typeof command === "string" && MENTIONS_GIT_WRITE.test(command)
          ? output({ hookEventName: "PreToolUse", additionalContext: VCS_REMINDER })
          : NOTHING,
      )
    },
    true,
  ),
  {
    path: ["hook", "commit-msg"],
    usage: "hook commit-msg <message-file>",
    summary:
      "Git commit-msg hook: remove agent attribution from the message file and refuse a message that talks about the user or the agent; install it as .git/hooks/commit-msg or a commit-msg job of a hook manager",
    notes: [
      "git passes the path of the message file as the only argument, and a non-zero exit stops the commit",
      "the phrases are the ones `vcs commit` checks; a project lists words its domain uses in vcs.allowWords of .holyagent/config.json",
    ],
    flags: {},
    positionals: 1,
    state: "peek",
    run: (call) =>
      Effect.gen(function* () {
        const file = call.args.positionals[0] ?? ""
        const text = yield* io(file, () => Bun.file(file).text())
        const comment = yield* commentPrefix.pipe(Effect.provide(call.vcs))
        // `git commit -v` appends the staged diff after a scissors line; none of it is the message.
        const scissors = `${comment} ------------------------ >8 ------------------------`
        const lines = text.split("\n")
        const cut = lines.findIndex((line) => line.trimEnd() === scissors)
        const above = (cut === -1 ? lines : lines.slice(0, cut)).join("\n")
        const below = cut === -1 ? "" : lines.slice(cut).join("\n")
        const cleaned = cleanMessage(above)
        // Below the scissors line git itself keeps only a staged diff, but a message made by hand
        // keeps everything: agent attribution goes from there too, and the phrase check stays above.
        const cleanedBelow = below === "" ? "" : cleanMessage(below)
        const message = cleaned
          .split("\n")
          .filter((line) => !line.startsWith(comment))
          .join("\n")
        const phrases = forbiddenPhrases(
          message,
          (yield* readSettings([call.directory, join(call.root, STATE_DIRECTORY)])).allowWords,
        )
        if (phrases.length > 0) return yield* new MessageRefused({ phrases })
        if (cleaned !== above.trim() || cleanedBelow !== below.trim())
          yield* io(file, () =>
            Bun.write(file, below === "" ? `${cleaned}\n` : `${cleaned}\n\n${cleanedBelow}\n`),
          )
        return NOTHING
      }),
  },
  hook(
    "workflow",
    "PreToolUse for Workflow: allow an inline script whose every agent() call names one of this plugin's specialists by a string-literal agentType, with no script path, name or resume; say nothing otherwise",
    (payload) => {
      const input = payload.tool_input ?? {}
      const script = input.script
      if (
        payload.tool_name !== "Workflow" ||
        typeof script !== "string" ||
        !Object.keys(input).every((key) => INLINE_INPUTS.has(key))
      )
        return Effect.succeed(NOTHING)
      return workflowRefusal(script).pipe(
        Effect.map((refusal) =>
          refusal === undefined
            ? decision(
                "allow",
                "Inline workflow script whose every agent() call is a holyagent specialist.",
              )
            : NOTHING,
        ),
      )
    },
    true,
  ),
]
