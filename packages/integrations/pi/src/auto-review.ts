import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import type { Config } from "../../../runtime/src/config/schema.ts"
import { canonicalPiToolName } from "../../../runtime/src/domain/host.ts"
import {
  isStateOnlyTool,
  type ToolTraits,
} from "../../../runtime/src/pi/codex/auto-review/classify.ts"
import { codexReviewer } from "../../../runtime/src/pi/codex/auto-review/client.ts"
import { gate } from "../../../runtime/src/pi/codex/auto-review/gate.ts"
import type { PolicyConfig } from "../../../runtime/src/pi/codex/auto-review/policy.ts"
import {
  type ReviewerClient,
  ReviewerUnavailable,
} from "../../../runtime/src/pi/codex/auto-review/review.ts"
import { createReviewSession } from "../../../runtime/src/pi/codex/auto-review/session.ts"
import { entriesFromMessages } from "../../../runtime/src/pi/codex/auto-review/transcript.ts"
import { isCodexProvider } from "../../../runtime/src/pi/codex/context-management.ts"
import type { Fetch } from "../../../runtime/src/pi/codex/luna-reserve.ts"
import { CODEX_PROVIDER_ID } from "../../../runtime/src/pi/codex/routes.ts"

/**
 * What the user's own config decides for auto-review: the policy text while it is on, `undefined`
 * while it is off.
 */
export interface AutoReviewChoice {
  readonly settings: PolicyConfig | undefined
}

/**
 * Auto-review as it stands with no config read: on, with the default policy. A session starts here
 * and a user config that cannot be read leaves it here, so a failure never turns the control off.
 */
export const AUTO_REVIEW_ON: AutoReviewChoice = { settings: {} }

/**
 * The choice of the user-level config, read alone. Auto-review is a security control, so the
 * project's `.holyagent/config.json` takes no part: a repository cannot switch it off or replace or
 * extend its policy, and a project file that is malformed changes nothing. Only the user's own file
 * turns it off (`pi.features.autoReview`, or `pi.enable` for the whole extension) or sets its
 * policy; with no readable user config it is on with the default policy. It is not tied to the
 * config's provider: the gate applies whenever the active model is served by Codex.
 */
export const autoReviewChoice = (user: Config | undefined): AutoReviewChoice =>
  user === undefined
    ? AUTO_REVIEW_ON
    : { settings: user.pi.enable && user.pi.features.autoReview ? user.pi.autoReview : undefined }

/** The auto-review settings of one Pi session: the default until a choice is fixed, then the choice. */
export interface AutoReviewSettings {
  /** The policy text while auto-review is on, `undefined` while it is off. */
  readonly settings: () => PolicyConfig | undefined
  /**
   * Fixes the choice for the rest of the session; only the first call counts, so a config written
   * mid-session, or read again by a compaction, changes nothing.
   */
  readonly fix: (choice: AutoReviewChoice) => void
}

/** A fresh {@link AutoReviewSettings}, on with the default policy until a choice is fixed. */
export const createAutoReviewSettings = (): AutoReviewSettings => {
  let current = AUTO_REVIEW_ON
  let fixed = false
  return {
    settings: () => current.settings,
    fix: (choice) => {
      if (fixed) return
      fixed = true
      current = choice
    },
  }
}

/** What the auto-review module needs from the extension that hosts it. */
export interface AutoReviewHost {
  /**
   * The policy text of the session's auto-review while it is on, and `undefined` while the user's
   * own config has it off. The module applies it only when the active model is served by Codex.
   */
  readonly settings: () => PolicyConfig | undefined
  /**
   * The reviewer client; by default the Codex backend's, with the session's own token. A test
   * passes its own.
   */
  readonly reviewer?: ReviewerClient
  /** The request function of the default client; the global `fetch` by default. */
  readonly fetcher?: Fetch
  /** The review timeout in milliseconds; 90 s by default. A test passes a short one. */
  readonly timeoutMs?: number
}

const unreachable =
  (reason: string): ReviewerClient =>
  () =>
    Effect.fail(new ReviewerUnavailable({ reason }))

// The session's own Codex token turns into the default client; with no token the client fails, so
// the review fails closed.
const defaultClient = (ctx: ExtensionContext, fetcher: Fetch | undefined) =>
  Effect.tryPromise({
    try: () => ctx.modelRegistry.getApiKeyForProvider(CODEX_PROVIDER_ID),
    catch: () => new ReviewerUnavailable({ reason: "the Codex credentials could not be read" }),
  }).pipe(
    Effect.map((token) =>
      token === undefined
        ? unreachable("no Codex credentials, log in with /login openai-codex")
        : codexReviewer(token, fetcher),
    ),
    Effect.orElseSucceed(() => unreachable("the Codex credentials could not be read")),
  )

/**
 * What the classifier is told about a registered tool: the annotations Pi lists for it, with
 * `readOnlyHint` added for HolyAgent's own state-only tools (see `isStateOnlyTool`), which spawn no
 * process and no agent. A tool Pi does not list has no annotations.
 */
export const toolTraits = (info: ToolInfo | undefined): ToolTraits => {
  const mcp = info?.namespace !== undefined
  const annotations =
    info !== undefined && isStateOnlyTool(info.name, info.sourceInfo?.source, mcp)
      ? { ...info.annotations, readOnlyHint: true }
      : info?.annotations
  return { ...(annotations === undefined ? {} : { annotations }), mcp }
}

const APPROVE_USAGE =
  "Usage: /approve to approve the latest denied action, /approve <n> for the nth latest, /approve list to list them."

/**
 * Registers Codex auto-review on Pi: a `tool_call` gate that sends the calls the classifier picks
 * to the Codex reviewer before they run, and the `/approve` command that lifts one denied action
 * for a single retry. The gate is inert (it returns at once, and `/approve` says auto-review is
 * off) while `host.settings()` is `undefined`, which only the user's own config causes, or while
 * the active model is not served by the Codex provider: then no call is classified and none is
 * reviewed.
 *
 * - `tool_call`: classifies the call; a reviewed call runs on an allow and is blocked on a deny, a
 *   timeout or a failed review, and the breaker interrupts the turn after repeated denials.
 * - `agent_start`: a new turn starts the breaker's counts again.
 * - `session_start`: forgets the denied actions and approvals of the session before.
 */
export const registerAutoReview = (pi: ExtensionAPI, host: AutoReviewHost): void => {
  const session = createReviewSession()

  pi.on("session_start", () => {
    session.reset()
  })
  pi.on("agent_start", () => {
    session.newTurn()
  })

  pi.on("tool_call", async (event, ctx) => {
    const policy = host.settings()
    if (policy === undefined || !isCodexProvider(ctx.model?.provider)) return undefined
    const info = pi.getAllTools().find((tool) => tool.name === event.toolName)
    // The client and the history are built inside the gate, after the classifier has sent the call
    // to review: a call that runs at once looks up no credentials and walks no history.
    const result = await Effect.runPromise(
      gate({
        call: { toolName: canonicalPiToolName(event.toolName), input: event.input },
        cwd: ctx.cwd,
        traits: toolTraits(info),
        entries: Effect.sync(() =>
          entriesFromMessages(
            ctx.sessionManager
              .getBranch()
              .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
          ),
        ),
        client:
          host.reviewer === undefined
            ? defaultClient(ctx, host.fetcher)
            : Effect.succeed(host.reviewer),
        policy,
        session,
        ...(host.timeoutMs === undefined ? {} : { timeoutMs: host.timeoutMs }),
      }),
    )
    if (result.notice !== undefined) ctx.ui.notify(result.notice, result.block ? "warning" : "info")
    if (!result.block) return undefined
    if (result.interrupt) ctx.abort()
    return { block: true, reason: result.reason, ...(result.interrupt ? { terminate: true } : {}) }
  })

  const approve = (args: string, ctx: ExtensionContext): void => {
    if (host.settings() === undefined) {
      ctx.ui.notify("Auto-review is off, so there is nothing to approve.", "warning")
      return
    }
    const denied = session.denied()
    const choice = args.trim()
    if (choice === "list") {
      ctx.ui.notify(
        denied.length === 0
          ? "No denied action to approve."
          : denied.map((action, index) => `${index + 1}. ${action.summary}`).join("\n"),
        "info",
      )
      return
    }
    const number = choice === "" ? 1 : Number(choice)
    if (!Number.isInteger(number) || number < 1) {
      ctx.ui.notify(APPROVE_USAGE, "warning")
      return
    }
    const action = session.approve(number - 1)
    ctx.ui.notify(
      action === undefined
        ? "No such denied action to approve."
        : `Approved for one retry: ${action.summary}. Ask the agent to try it again; the retry is still reviewed, with your approval in its transcript.`,
      action === undefined ? "warning" : "info",
    )
  }

  pi.registerCommand("approve", {
    description: "Approve a denied auto-review action for one retry",
    handler: (args, ctx) => Promise.resolve(approve(args, ctx)),
  })
}
