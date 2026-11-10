import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { ASSESSMENT_JSON_SCHEMA } from "../../src/pi/codex/auto-review/assessment.ts"
import {
  CODEX_RESPONSES_URL,
  codexReviewer,
  readReviewerStream,
  reviewerBody,
} from "../../src/pi/codex/auto-review/client.ts"
import type { ReviewerRequest } from "../../src/pi/codex/auto-review/review.ts"
import type { Fetch } from "../../src/pi/codex/luna-reserve.ts"

const REQUEST: ReviewerRequest = {
  model: "codex-auto-review",
  instructions: "policy",
  prompt: "transcript and action",
  schema: ASSESSMENT_JSON_SCHEMA,
  reasoningEffort: "low",
}

const TOKEN = [
  "header",
  Buffer.from(
    JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_9" } }),
  ).toString("base64url"),
  "signature",
].join(".")

const sse = (...events: Array<unknown>) =>
  events.map((event) => `event: x\ndata: ${JSON.stringify(event)}\n\n`).join("")

const ASSESSMENT = '{"outcome":"allow"}'

const reply = (body: string, status = 200) => new Response(body, { status })

const run = (fetcher: Fetch) =>
  Effect.runPromise(Effect.result(codexReviewer(TOKEN, fetcher)(REQUEST)))

describe("the reviewer request", () => {
  test("posts the strict-schema Responses request to the Codex backend with the token in the headers", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = []
    const fetcher: Fetch = (url, init) => {
      seen.push({ url, init })
      return Promise.resolve(
        reply(
          sse(
            { type: "response.output_text.done", text: ASSESSMENT },
            { type: "response.completed" },
          ),
        ),
      )
    }
    const result = await run(fetcher)
    expect(result).toMatchObject({ _tag: "Success", success: ASSESSMENT })
    const [call] = seen
    expect(call?.url).toBe(CODEX_RESPONSES_URL)
    expect(call?.init.method).toBe("POST")
    expect(call?.init.redirect).toBe("error")
    const headers = call?.init.headers as Record<string, string>
    expect(headers["authorization"]).toBe(`Bearer ${TOKEN}`)
    expect(headers["chatgpt-account-id"]).toBe("acct_9")
    const sent = call?.init.body
    const body: unknown = JSON.parse(typeof sent === "string" ? sent : "")
    expect(body).toEqual(reviewerBody(REQUEST))
    expect(body).toMatchObject({
      model: "codex-auto-review",
      instructions: "policy",
      store: false,
      stream: true,
      reasoning: { effort: "low" },
      input: [{ role: "user", content: [{ type: "input_text", text: "transcript and action" }] }],
      text: { format: { type: "json_schema", strict: true, schema: ASSESSMENT_JSON_SCHEMA } },
    })
    expect(JSON.stringify(body)).not.toContain(TOKEN)
  })

  test("reads the message from the deltas when no done event comes", async () => {
    const stream = sse(
      { type: "response.output_text.delta", delta: '{"outcome":' },
      { type: "response.output_text.delta", delta: '"deny"}' },
    )
    expect(await Effect.runPromise(readReviewerStream(stream))).toBe('{"outcome":"deny"}')
  })

  test("a failure, an incomplete response, an error event or an empty stream is unavailable", async () => {
    const streams = [
      sse({ type: "response.failed", response: { error: { message: "overloaded" } } }),
      sse({
        type: "response.incomplete",
        response: { incomplete_details: { reason: "max_tokens" } },
      }),
      sse({ type: "error", message: "bad request" }),
      sse({ type: "response.completed" }),
      "",
      "data: not json\n\n",
    ]
    for (const stream of streams) {
      const result = await Effect.runPromise(Effect.result(readReviewerStream(stream)))
      expect([stream, result._tag]).toEqual([stream, "Failure"])
    }
  })

  test("a status other than 200 or a failed request is unavailable, and never carries the token", async () => {
    const refused = await run(() => Promise.resolve(reply("secret body", 401)))
    expect(refused).toMatchObject({ _tag: "Failure" })
    expect(String((refused as { failure: Error }).failure.message)).toBe(
      "the review request failed: HTTP 401",
    )
    const broken = await run(() => Promise.reject(new Error("socket closed")))
    expect(String((broken as { failure: Error }).failure.message)).toBe(
      "the review request failed: socket closed",
    )
    for (const result of [refused, broken]) expect(JSON.stringify(result)).not.toContain(TOKEN)
  })

  test("interrupting the effect aborts the request", async () => {
    let aborted = false
    const fetcher: Fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      })
    const outcome = await Effect.runPromise(
      codexReviewer(TOKEN, fetcher)(REQUEST).pipe(Effect.timeoutOption(20)),
    )
    expect(outcome._tag).toBe("None")
    expect(aborted).toBe(true)
  })
})
