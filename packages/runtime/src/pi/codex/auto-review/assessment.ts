import { Data, Effect, Schema } from "effect"

/** The model the reviewer runs on, as Codex's own auto-review does (`GUARDIAN_PREFERRED_MODEL`). */
export const REVIEW_MODEL = "codex-auto-review"

/**
 * How long a review may take before it counts as timed out: 90 seconds, Codex's
 * `GUARDIAN_REVIEW_TIMEOUT`.
 */
export const REVIEW_TIMEOUT_MS = 90_000

/**
 * The reasoning effort of the reviewer. Codex asks for `low` whenever the review model supports it,
 * and `codex-auto-review` is the review model.
 */
export const REVIEW_REASONING_EFFORT = "low"

/** The reviewer's risk levels, as Codex's `GuardianRiskLevel`. */
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const

/** The reviewer's authorization levels, as Codex's `GuardianUserAuthorization`. */
export const AUTHORIZATION_LEVELS = ["unknown", "low", "medium", "high"] as const

/**
 * The reviewer's verdict, Codex's `GuardianAssessment`. Every field is required (the output schema
 * is strict), and a field of another name is an error.
 */
export const GuardianAssessment = Schema.Struct({
  risk_level: Schema.Literals(RISK_LEVELS),
  user_authorization: Schema.Literals(AUTHORIZATION_LEVELS),
  outcome: Schema.Literals(["allow", "deny"]),
  rationale: Schema.String.check(Schema.isNonEmpty()),
})
/** One reviewer verdict. */
export type GuardianAssessment = typeof GuardianAssessment.Type

/**
 * The JSON schema the reviewer must answer in (the Responses API's strict `json_schema` format),
 * the same four fields as {@link GuardianAssessment}.
 */
export const ASSESSMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    risk_level: { type: "string", enum: [...RISK_LEVELS] },
    user_authorization: { type: "string", enum: [...AUTHORIZATION_LEVELS] },
    outcome: { type: "string", enum: ["allow", "deny"] },
    rationale: { type: "string" },
  },
  required: ["risk_level", "user_authorization", "outcome", "rationale"],
} as const

/** The reviewer's answer is not a valid assessment: not JSON, a missing or unknown field or value. */
export class InvalidAssessment extends Data.TaggedError("InvalidAssessment")<{
  readonly reason: string
}> {
  /** The description that goes into the rationale of the synthetic denial. */
  override get message() {
    return `the assessment is invalid: ${this.reason}`
  }
}

const decodeAssessment = Schema.decodeUnknownEffect(Schema.fromJsonString(GuardianAssessment), {
  onExcessProperty: "error",
})

/**
 * Decodes the reviewer's final message as a {@link GuardianAssessment}, strictly: the whole text
 * must be the JSON object, with the four fields and nothing else.
 */
export const parseAssessment = (
  text: string,
): Effect.Effect<GuardianAssessment, InvalidAssessment> =>
  decodeAssessment(text).pipe(
    Effect.mapError((error) => new InvalidAssessment({ reason: error.message })),
  )

/**
 * Codex's instructions to the model after a denial (`GUARDIAN_REJECTION_INSTRUCTIONS`): no
 * workaround, only a materially safer path or the user's explicit approval.
 */
export const REJECTION_INSTRUCTIONS =
  "The agent must not attempt to achieve the same outcome via workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or if the user explicitly approves the action after being informed of the risk. Otherwise, stop and request user input."

/** What a denied tool call tells the model: Codex's rejection text, the reason and the instructions. */
export const rejectionMessage = (rationale: string): string =>
  `This action was rejected due to unacceptable risk.\nReason: ${rationale.trim()}\n${REJECTION_INSTRUCTIONS}`

/**
 * What a timed-out review tells the model (Codex's `GUARDIAN_TIMEOUT_INSTRUCTIONS`): the timeout
 * says nothing about the action, and one retry is allowed.
 */
export const TIMEOUT_MESSAGE =
  "The automatic permission approval review did not finish before its deadline. Do not assume the action is unsafe based on the timeout alone. You may retry once, or ask the user for guidance or explicit approval."

/** What the model reads when the retry of a timed-out review times out too: no second retry. */
export const TIMEOUT_AGAIN_MESSAGE =
  "The automatic permission approval review did not finish before its deadline again. Do not assume the action is unsafe based on the timeout alone, and do not retry it again: ask the user for guidance or explicit approval."

/**
 * The verdict of a review that could not complete (the request failed or the answer was invalid): a
 * denial at high risk and unknown authorization, so that the action is not run, as Codex does.
 */
export const failedAssessment = (message: string): GuardianAssessment => ({
  risk_level: "high",
  user_authorization: "unknown",
  outcome: "deny",
  rationale: `Automatic approval review failed: ${message}`,
})

/**
 * The marker Codex puts into the review transcript for an action the user approved by hand after a
 * denial (`AUTO_REVIEW_DENIED_ACTION_APPROVAL_DEVELOPER_PREFIX`).
 */
export const MANUAL_APPROVAL_PREFIX =
  "The user has manually approved a specific action that was previously `Rejected`."
