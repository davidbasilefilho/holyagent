import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

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

/** What the auto-review module needs from the extension that hosts it. */
export interface AutoReviewHost {
  /**
   * The policy text of the session's config while auto-review is on under the Codex provider, and
   * `undefined` before the config is read, with the capability off or under another provider.
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

const APPROVE_USAGE =
  "Usage: /approve to approve the latest denied action, /approve <n> for the nth latest, /approve list to list them."

/**
 * Registers Codex auto-review on Pi: a `tool_call` gate that sends the calls the classifier picks
 * to the `codex-auto-review` reviewer before they run, and the `/approve` command that lifts one
 * denied action for a single retry. The module is inert (the gate returns at once, `/approve` says
 * auto-review is off) while `host.settings()` is `undefined`, so with the capability off, or under
 * another provider, no call is classified and none is reviewed.
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = host.reviewer ?? (yield* defaultClient(ctx, host.fetcher))
        return yield* gate({
          call: { toolName: event.toolName, input: event.input },
          cwd: ctx.cwd,
          traits: {
            ...(info?.annotations === undefined ? {} : { annotations: info.annotations }),
            mcp: info?.namespace !== undefined,
          },
          entries: entriesFromMessages(
            ctx.sessionManager
              .getBranch()
              .flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
          ),
          client,
          policy,
          session,
          ...(host.timeoutMs === undefined ? {} : { timeoutMs: host.timeoutMs }),
        })
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
