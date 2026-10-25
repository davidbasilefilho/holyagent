import { stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect, Schema } from "effect"

import { ROOT_CORE } from "../instructions/claude-5.5/root-core.ts"
import { hasCode, io } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { readOpenState } from "../state/store.ts"
import { MessageRefused } from "../vcs/errors.ts"
import { gitMaybe } from "../vcs/git.ts"
import { cleanMessage, forbiddenPhrases } from "../vcs/message.ts"
import { readSettings } from "../vcs/settings.ts"
import { recordLaunch } from "./assignment.ts"
import { stateRoot } from "./context.ts"
import { AgentIdMissing, describeFailure, StateFolderMissing } from "./errors.ts"
import { resolveIntent } from "./intent.ts"
import { resumeOf, statusOf } from "./overview.ts"
import { dispatchedAssignment } from "./report.ts"
import { type IntentRequirements, sessionContext } from "./sessioncontext.ts"
import { type GitWrite, gitWrites } from "./shell.ts"
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

const REDIRECTS: Readonly<Record<GitWrite, string>> = {
  commit:
    "Commit with `holyagent vcs commit -m <headline> -- <paths…>`, which adds the Intent's state and checks the message.",
  "force-push":
    "Force pushes are denied (--force, --force-with-lease, --mirror, --delete, --prune, a + or : refspec). Push without them; rewriting or deleting published history needs the user's approval, and the user does it.",
  unclear:
    "This command could force-push and cannot be read with certainty (a variable, substitution, brace, glob or escape in a push argument, or nesting too deep). Write the push out with literal branch names and flags, in a shallower command.",
}

/**
 * The text that starts a comment line in a commit message file: `core.commentString` or
 * `core.commentChar` of the repository, else `#` (`auto` too, which only picks another character
 * when the message already uses `#`).
 */
const commentPrefix = Effect.gen(function* () {
  const configured =
    (yield* gitMaybe(["config", "--get", "core.commentString"])) ??
    (yield* gitMaybe(["config", "--get", "core.commentChar"]))
  return configured === undefined || configured === "" || configured === "auto" ? "#" : configured
})

/** The Workflow inputs an inline run may carry; a script path, name or resume would run other code. */
const INLINE_INPUTS: ReadonlySet<string> = new Set(["script", "args"])

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
    "PreToolUse for Bash: deny a command that runs git commit (and point to holyagent vcs commit) or a force git push; say nothing otherwise, a plain git push included",
    (payload) => {
      const command = payload.tool_name === "Bash" ? payload.tool_input?.command : undefined
      // Whatever the command looks like, this hook decides and never fails, since its onFailure
      // block would then stop a call that has no git write in it. A command it cannot read at all
      // (the scan ran out of stack) is denied as unclear: the `if` rules only start the hook for
      // text that has git and commit or push in it.
      return Effect.try({
        try: () => (typeof command === "string" ? gitWrites(command) : []),
        catch: (cause) => cause,
      }).pipe(
        Effect.orElseSucceed((): ReadonlyArray<GitWrite> => ["unclear"]),
        Effect.map((writes) =>
          writes.length === 0
            ? NOTHING
            : decision("deny", writes.map((write) => REDIRECTS[write]).join(" ")),
        ),
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
        const message = cleaned
          .split("\n")
          .filter((line) => !line.startsWith(comment))
          .join("\n")
        const phrases = forbiddenPhrases(
          message,
          (yield* readSettings(dirname(call.directory))).allowWords,
        )
        if (phrases.length > 0) return yield* new MessageRefused({ phrases })
        if (cleaned !== above.trim())
          yield* io(file, () =>
            Bun.write(file, below === "" ? `${cleaned}\n` : `${cleaned}\n\n${below}`),
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
