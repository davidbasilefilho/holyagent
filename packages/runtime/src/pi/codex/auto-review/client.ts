import { Effect, Schema } from "effect"

import { accountIdOf, type Fetch } from "../luna-reserve.ts"
import { type ReviewerClient, type ReviewerRequest, ReviewerUnavailable } from "./review.ts"

/** The Codex backend's Responses endpoint, the one Pi's own Codex provider sends its requests to. */
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"

/** The Responses request of a review: one user message, the strict schema, no tools, nothing stored. */
export const reviewerBody = (request: ReviewerRequest): Readonly<Record<string, unknown>> => ({
  model: request.model,
  instructions: request.instructions,
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: request.prompt }] },
  ],
  text: {
    format: {
      type: "json_schema",
      name: "guardian_assessment",
      strict: true,
      schema: request.schema,
    },
  },
  reasoning: { effort: request.reasoningEffort },
  store: false,
  stream: true,
})

/** The headers of a review request: the bearer token and, when known, the ChatGPT account id. */
export const reviewerHeaders = (token: string): Readonly<Record<string, string>> => {
  const account = accountIdOf(token)
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "text/event-stream",
    "openai-beta": "responses=experimental",
    // Codex's backend wants an originator on every request; Pi sends its own name.
    originator: "pi",
    ...(account === undefined ? {} : { "chatgpt-account-id": account }),
  }
}

/** The fields of a stream event that the review reads. */
const StreamEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(
    Schema.Struct({
      error: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
      ),
      incomplete_details: Schema.optionalKey(
        Schema.NullOr(Schema.Struct({ reason: Schema.optionalKey(Schema.String) })),
      ),
    }),
  ),
})

const readEvent = Schema.decodeUnknownOption(Schema.fromJsonString(StreamEvent))

const DATA_LINE = /^data:\s?(.*)$/

/**
 * The reviewer's final message in a server-sent event stream: the `response.output_text.done` text
 * when there is one, else the deltas joined. A `response.failed`, `response.incomplete` or `error`
 * event, or a stream with no text, is {@link ReviewerUnavailable}; a line that is not an event is
 * skipped.
 */
export const readReviewerStream = (stream: string): Effect.Effect<string, ReviewerUnavailable> =>
  Effect.suspend(() => {
    let deltas = ""
    let done: string | undefined
    for (const line of stream.split("\n")) {
      const data = DATA_LINE.exec(line.trimEnd())?.[1]
      if (data === undefined) continue
      const event = readEvent(data)
      if (event._tag === "None") continue
      const { type, delta, text, message, response } = event.value
      if (type === "response.output_text.delta" && delta !== undefined) deltas += delta
      else if (type === "response.output_text.done" && text !== undefined) done = text
      else if (type === "response.failed")
        return Effect.fail(
          new ReviewerUnavailable({
            reason: `the review request failed: ${response?.error?.message ?? "no reason given"}`,
          }),
        )
      else if (type === "response.incomplete")
        return Effect.fail(
          new ReviewerUnavailable({
            reason: `the review was cut short: ${response?.incomplete_details?.reason ?? "no reason given"}`,
          }),
        )
      else if (type === "error")
        return Effect.fail(
          new ReviewerUnavailable({
            reason: `the review request failed: ${message ?? "no reason given"}`,
          }),
        )
    }
    const final = done ?? deltas
    return final.trim() === ""
      ? Effect.fail(new ReviewerUnavailable({ reason: "the reviewer returned no message" }))
      : Effect.succeed(final)
  })

/**
 * The real reviewer client: posts the review to the Codex backend with the session's access token,
 * which goes in the request's headers only, so no failure carries it. A refused redirect, a failed
 * request or a status other than 200 is {@link ReviewerUnavailable}; interrupting the effect (the
 * review's timeout) aborts the request.
 */
export const codexReviewer =
  (token: string, fetcher: Fetch = (url, init) => fetch(url, init)): ReviewerClient =>
  (request) => {
    const unavailable = (cause: unknown) =>
      new ReviewerUnavailable({
        reason: `the review request failed: ${cause instanceof Error ? cause.message : "unknown error"}`,
      })
    return Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetcher(CODEX_RESPONSES_URL, {
            method: "POST",
            headers: reviewerHeaders(token),
            body: JSON.stringify(reviewerBody(request)),
            // A redirect would carry the token to a host the module does not name.
            redirect: "error",
            signal,
          }),
        catch: unavailable,
      })
      if (!response.ok)
        return yield* new ReviewerUnavailable({
          reason: `the review request failed: HTTP ${response.status}`,
        })
      const stream = yield* Effect.tryPromise({ try: () => response.text(), catch: unavailable })
      return yield* readReviewerStream(stream)
    })
  }
