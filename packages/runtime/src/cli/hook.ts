import { stat } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Schema } from "effect"

import { ROOT_CORE } from "../instructions/claude-5.5/root-core.ts"
import historyRules from "../instructions/claude-5.5/shared/history-rules.md" with { type: "text" }
import stateChanges from "../instructions/claude-5.5/specialist/state-changes.md" with { type: "text" }
import { setupNotice } from "../setup/check.ts"
import { claimRulesDelivery, isSessionId, markRulesDelivered } from "../state/delivery.ts"
import { hasCode, io } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { legacyFoldersWithState } from "../state/legacy.ts"
import { deadlineIn, HOOK_WAIT_MS } from "../state/lock.ts"
import { readOpenState, updateState } from "../state/store.ts"
import { resolveState } from "../state/tree.ts"
import { MessageRefused } from "../vcs/errors.ts"
import { gitMaybe } from "../vcs/git.ts"
import { inCloudSession } from "../vcs/identity.ts"
import { cleanMessage, forbiddenPhrases } from "../vcs/message.ts"
import { readSettings } from "../vcs/settings.ts"
import { recordLaunch } from "./assignment.ts"
import { AgentIdMissing, describeFailure, StateFolderMissing } from "./errors.ts"
import { pushTargets } from "./git-push.ts"
import { resolveIntent } from "./intent.ts"
import { resumeOf, statusOf } from "./overview.ts"
import { dispatchedAssignment } from "./report.ts"
import {
  bareContext,
  CLOUD_IDENTITY,
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
  agent_id: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  hook_event_name: Schema.optionalKey(Schema.String),
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

/**
 * The sentences on hooks, signing and history rewrites that the root prompt and the
 * {@link VCS_REMINDER} share, one source file, as one line.
 */
const HISTORY_RULES: string = historyRules
  .trim()
  .split("\n")
  .map((line) => line.replace(/^- /, ""))
  .join(" ")

/**
 * The one-line reminder a PreToolUse hook adds to a Bash command that mentions git commit or push,
 * or `holyagent vcs commit` or `vcs pr`. Its first sentence is the short form of the root's
 * identity rules and of the specialist state-change rule; the rest is the {@link HISTORY_RULES} the
 * root prompt holds in the same words.
 */
export const VCS_REMINDER = `Version control is the root's: it commits with \`holyagent vcs commit\`, never force-pushes and pushes to a protected branch only with the user's approval; a specialist makes no version-control writes. ${HISTORY_RULES}`

/**
 * The sentence the reminder gains when a commit, push or PR concerns a branch the platform assigned
 * (a cloud session starts on a local `claude/<name>` that the platform created). The rule is the
 * root's identity rule on branches; this only points at it at the moment it matters. A user's
 * choice of such a branch as the work branch is the rule's exception, so the sentence says so.
 */
export const PLATFORM_BRANCH_REMINDER =
  "This commit, push or PR concerns a `claude/*` branch, which the platform assigns unless the user named it as the work branch: its name carries no meaning, so commit and push only on your own conventional branch, and push the assigned one only after your own push is refused and the user says so."

/** A branch the platform assigns to a cloud session. */
const isPlatformBranch = (name: string | undefined): boolean => name?.startsWith("claude/") === true

/** The agent types of the plugin's specialists: namespaced by the plugin, the root excepted. */
const isSpecialist = (type: string | undefined): boolean =>
  type !== undefined && type.startsWith("holyagent:") && !ROOT_AGENTS.has(type)

/**
 * The text the host's `if` rules of the hook (`Bash(*git*commit*)`, `Bash(*git*push*)`,
 * `Bash(*vcs*commit*)`, `Bash(*vcs*pr*)`) can match: `git` followed somewhere by `commit` or
 * `push`, or `vcs commit` or `vcs pr`, the commands of `holyagent vcs`, which commit and open PRs
 * without the word `git` in the command line. A command without it gets no reminder.
 */
const MENTIONS_VCS_WRITE = /git[\s\S]*(?:commit|push)|\bvcs\s+(?:commit|pr)\b/i

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

/**
 * The core of the root rules and the line that makes the main thread the root, with the CLI form of
 * the plugin filled in, for a main thread that is not the root; nothing for the root. The host
 * fills in `${CLAUDE_PLUGIN_ROOT}` in agent text only, and this text is context.
 */
const rootCore = (payload: typeof Payload.Type, call: Call): string | undefined =>
  ROOT_AGENTS.has(payload.agent_type)
    ? undefined
    : [ROOT_CORE, ROOT_TAKEOVER]
        .join("\n\n")
        .replaceAll(
          "${CLAUDE_PLUGIN_ROOT}",
          () => call.env.CLAUDE_PLUGIN_ROOT ?? "${CLAUDE_PLUGIN_ROOT}",
        )

/**
 * True for the main thread: the payload of a subagent carries an `agent_id`, and its `agent_type`
 * is a specialist of the plugin.
 */
const isMainThread = (payload: typeof Payload.Type): boolean =>
  payload.agent_id === undefined && !isSpecialist(payload.agent_type)

// Both version-control hooks only add context, so neither can deny, allow or block: they carry no
// permission decision, and the plugin wires them without `onFailure: block`.

/** The `hook` commands the plugin's hooks call. */
export const HOOK_COMMANDS: ReadonlyArray<Command> = [
  hook(
    "session-start",
    "SessionStart: add the status of the open Intents as context, with the reconcile result and the requirements of the Intent in use after a resume or compaction (and the core root rules with a line that makes the main thread the root, when the holyagent agent is not the main thread, and in a claude.ai cloud session, `CLAUDE_CODE_REMOTE=true`, the steps that set the commit author to the user), always ending with a short block of the rules the core root rules leave out; one line that offers /holyagent:setup when ctx7 or a recommended settings key is missing from the user settings and from the project and local settings of the session's folder (nothing in a cloud session, nothing installed or written); for a project with no .holyagent and a .holyclaude or .holycodex folder that holds state to convert, a notice naming the folder and `holyagent migrate`, with the same rules; for a project with none of the three, the core root rules with that line and the reminder when the holyagent agent is not the main thread, otherwise nothing",
    (payload, call) => {
      const core = rootCore(payload, call)
      // How the commit author is set matters only where git's committer is the platform's.
      const cloud = inCloudSession(call.env) ? CLOUD_IDENTITY : undefined
      return Effect.gen(function* () {
        // Reads files and looks commands up; it installs and writes nothing (`holyagent setup` does).
        const notice = yield* setupNotice(call.env, call.cwd)
        if (!(yield* hasStateFolder(call.directory))) {
          const found = yield* legacyFoldersWithState(call.root)
          // Nothing to show or convert: a main thread that lacks the root rules gets them, and an
          // incomplete setup is the only other thing worth saying.
          if (found.length === 0) {
            if (core === undefined)
              return notice === undefined
                ? NOTHING
                : output({ hookEventName: "SessionStart", additionalContext: notice })
            return output({
              hookEventName: "SessionStart",
              additionalContext: bareContext(core, cloud, notice),
            })
          }
          return output({
            hookEventName: "SessionStart",
            additionalContext: legacyContext(found, core, cloud, notice),
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
            cloud,
            notice,
          ),
        })
      }).pipe(
        // A main thread that is not the root still gets the rules and is told what failed, since
        // exit 1 would leave it with nothing; the root has the rules in its prompt, so it keeps the
        // visible failure.
        core === undefined
          ? (effect) => effect
          : Effect.catch((error) =>
              Effect.succeed(
                output({
                  hookEventName: "SessionStart",
                  additionalContext: [
                    bareContext(core, cloud),
                    `holyagent: the project state could not be read (${describeFailure(error).tag}), so no status is shown. Run \`holyagent status\` to see the error.`,
                  ].join("\n\n"),
                }),
              ),
            ),
        // Later events of the session skip the rules once this event has carried them; a marker
        // that cannot be written costs one more delivery, never the hook.
        Effect.tap(() =>
          core !== undefined && isSessionId(payload.session_id)
            ? markRulesDelivered(payload.session_id).pipe(Effect.ignore)
            : Effect.void,
        ),
      )
    },
  ),
  hook(
    "root-rules",
    "UserPromptSubmit and PreToolUse: on the first event of a main thread that is not the root and has not been given the rules (its SessionStart output never came, or came late), add the core root rules with the takeover line as context, once per session; nothing for later events, the root, a subagent or a payload with no usable session id",
    (payload, call) => {
      const core = rootCore(payload, call)
      const event = payload.hook_event_name
      if (
        core === undefined ||
        (event !== "UserPromptSubmit" && event !== "PreToolUse") ||
        !isMainThread(payload) ||
        !isSessionId(payload.session_id)
      )
        return Effect.succeed(NOTHING)
      const cloud = inCloudSession(call.env) ? CLOUD_IDENTITY : undefined
      return claimRulesDelivery(payload.session_id).pipe(
        Effect.map((first) =>
          first
            ? output({ hookEventName: event, additionalContext: bareContext(core, cloud) })
            : NOTHING,
        ),
        // This runs on every tool call, so a marker folder that cannot be used (another account's,
        // a link, read-only or full) must not fail each call: the late delivery is skipped quietly.
        Effect.catch(() => Effect.succeed(NOTHING)),
      )
    },
    true,
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
        // One deadline for every lock this hook takes, so the waits add up to less than the host's timeout.
        const patience = yield* deadlineIn(HOOK_WAIT_MS)
        const { directory } = yield* resolveState(call.cwd, call.env, "ifPresent", false, patience)
        // The state folder is not made here: a project without one has no Assignment to record.
        if (!(yield* hasStateFolder(directory))) return yield* new StateFolderMissing()
        const type = payload.tool_input?.subagent_type
        yield* recordLaunch(
          (transition) => updateState(directory, transition, call.env, patience),
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
    "PreToolUse for Bash: for a command that mentions git and then commit or push, or `vcs commit` or `vcs pr`, add a one-line reminder of the version-control rules as context, with a sentence about the platform's branches when the branch of the session folder (a `cd` or `git -C` in the command is not followed), or a target of a `git push` the command spells out, is `claude/*`; never a permission decision, and nothing for any other command",
    (payload, call) => {
      const command = payload.tool_name === "Bash" ? payload.tool_input?.command : undefined
      if (typeof command !== "string" || !MENTIONS_VCS_WRITE.test(command))
        return Effect.succeed(NOTHING)
      // A git that cannot answer (no repository, a broken config) leaves the plain reminder.
      return gitMaybe([
        "-C",
        payload.cwd ?? call.cwd,
        "symbolic-ref",
        "--short",
        "-q",
        "HEAD",
      ]).pipe(
        Effect.provide(call.vcs),
        Effect.catchCause(() => Effect.succeed(undefined)),
        Effect.map((branch) => {
          const platform = isPlatformBranch(branch) || pushTargets(command).some(isPlatformBranch)
          return output({
            hookEventName: "PreToolUse",
            additionalContext: platform
              ? `${VCS_REMINDER} ${PLATFORM_BRANCH_REMINDER}`
              : VCS_REMINDER,
          })
        }),
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
          (yield* readSettings([join(call.root, STATE_DIRECTORY)])).allowWords,
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
