import { Effect } from "effect"

import {
  type GuardianAssessment,
  rejectionMessage,
  TIMEOUT_AGAIN_MESSAGE,
  TIMEOUT_MESSAGE,
} from "./assessment.ts"
import { actionJson, classify, type ToolCallInput, type ToolTraits } from "./classify.ts"
import type { PolicyConfig } from "./policy.ts"
import { review, type ReviewerClient } from "./review.ts"
import type { ReviewSession } from "./session.ts"
import { manualApprovalEntry, type TranscriptEntry } from "./transcript.ts"

/** The inputs of the gate for one tool call. */
export interface GateInput {
  /** The call the model made. */
  readonly call: ToolCallInput
  /** The project root, the working directory of the session. */
  readonly cwd: string
  /** What the tool registry knows of the tool. */
  readonly traits?: ToolTraits
  /**
   * The session history as review entries. Run only for a call that goes to review, since reading
   * the history costs a walk of it that a call run at once must not pay.
   */
  readonly entries: Effect.Effect<ReadonlyArray<TranscriptEntry>>
  /**
   * The client that asks the reviewer. Run only for a call that goes to review, since building it
   * may look up and refresh credentials.
   */
  readonly client: Effect.Effect<ReviewerClient>
  /** The policy text of the config. */
  readonly policy: PolicyConfig
  /** The auto-review state of the session. */
  readonly session: ReviewSession
  /** The review timeout in milliseconds; 90 s by default. */
  readonly timeoutMs?: number
}

/** What the gate decides for a tool call. */
export type GateResult =
  | {
      /** The call runs. `notice` is set when a review allowed it. */
      readonly block: false
      readonly notice?: string
    }
  | {
      /** The call does not run: `reason` is what the model reads. */
      readonly block: true
      readonly reason: string
      /** What the user reads. */
      readonly notice: string
      /** True when the breaker says to stop the turn. */
      readonly interrupt: boolean
    }

const SUMMARY_LIMIT = 120

const summarize = (call: ToolCallInput): string => {
  const command = call.input["command"]
  const text =
    typeof command === "string" ? command : `${call.toolName} ${JSON.stringify(call.input)}`
  const line = text.replaceAll(/\s+/g, " ").trim()
  return line.length > SUMMARY_LIMIT ? `${line.slice(0, SUMMARY_LIMIT)}...` : line
}

const verdict = (word: string, assessment: GuardianAssessment): string => {
  const rationale = assessment.rationale.trim()
  return `Automatic approval review ${word} (risk: ${assessment.risk_level}, authorization: ${assessment.user_authorization})${rationale === "" ? "" : `: ${rationale}`}`
}

/** What the user reads when a review times out. */
export const TIMEOUT_NOTICE =
  "Automatic approval review timed out while evaluating the requested approval."

/**
 * Runs the auto-review gate for one tool call, as Codex's guardian does for an approval request. A
 * call the classifier does not send to review runs at once. A reviewed call is judged by the
 * reviewer: an allow runs it; a deny blocks it with Codex's rejection text and counts toward the
 * breaker; a timeout blocks it without a denial and says one retry is allowed; a review that fails
 * blocks it as a denial the breaker does not count. A call the user approved with `/approve` is
 * reviewed once more with the approval in its transcript, and the approval is used up by the
 * decision, not by a review that failed or timed out. The history and the client are built only
 * once the classifier has sent the call to review.
 */
export const gate = (input: GateInput): Effect.Effect<GateResult> =>
  Effect.gen(function* () {
    const trigger = classify(input.call, input.cwd, input.traits)
    if (trigger === undefined) return { block: false }
    const { session } = input
    const json = actionJson(input.call, input.cwd, trigger)
    const approved = session.isApproved(json)
    const client = yield* input.client
    const entries = yield* input.entries
    const decision = yield* review({
      client,
      policy: input.policy,
      entries: approved ? [...entries, manualApprovalEntry(json)] : entries,
      actionJson: json,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    })
    if (decision._tag === "TimedOut") {
      session.recordNonDenial()
      const again = session.recordTimeout(json)
      return {
        block: true,
        reason: again ? TIMEOUT_AGAIN_MESSAGE : TIMEOUT_MESSAGE,
        notice: TIMEOUT_NOTICE,
        interrupt: false,
      }
    }
    session.forgetTimeout(json)
    // A review that failed decided nothing, so the user's approval stays for the next try.
    if (approved && !(decision._tag === "Deny" && decision.failed)) session.consumeApproval(json)
    if (decision._tag === "Allow") {
      session.recordNonDenial()
      return { block: false, notice: verdict("approved", decision.assessment) }
    }
    const denied = {
      key: json,
      summary: summarize(input.call),
      rationale: decision.assessment.rationale,
    }
    const notice = verdict("denied", decision.assessment)
    const reason = rejectionMessage(decision.assessment.rationale)
    if (decision.failed) {
      session.recordFailure(denied)
      return { block: true, reason, notice, interrupt: false }
    }
    const breaker = session.recordDenial(denied)
    return breaker.interrupt
      ? {
          block: true,
          reason: `${reason}\nAutomatic approval review rejected too many approval requests for this turn (${breaker.consecutive} consecutive, ${breaker.total} total); the turn is interrupted.`,
          notice: `${notice}\nAutomatic approval review rejected too many approval requests for this turn (${breaker.consecutive} consecutive, ${breaker.total} total); interrupting the turn.`,
          interrupt: true,
        }
      : { block: true, reason, notice, interrupt: false }
  })
