import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { CAPABILITIES, enabledCapabilities } from "../../src/config/capabilities.ts"
import {
  accountIdOf,
  endedOnUsageLimit,
  fetchReserveOffered,
  RESERVE_BANNER,
  RESERVE_MODEL,
  reserveOffered,
  statusHeaders,
  toReserve,
  USAGE_STATUS_URL,
  UsageStatusUnavailable,
} from "../../src/pi/codex/luna-reserve.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

/** A JWT-shaped token whose payload carries the ChatGPT account id, as the backend issues them. */
const token = (account?: string) =>
  [
    "header",
    Buffer.from(
      JSON.stringify(
        account === undefined
          ? {}
          : { "https://api.openai.com/auth": { chatgpt_account_id: account } },
      ),
    ).toString("base64url"),
    "signature",
  ].join(".")

const SECRET = token("acct_1")

const answer = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("the Luna Reserve capability entry", () => {
  const entry = CAPABILITIES.find((capability) => capability.name === "luna-reserve")

  test("is on by default, applies to the Codex provider only, and has no package, tool or setting", () => {
    expect(entry).toMatchObject({
      feature: "lunaReserve",
      defaultOn: true,
      provider: "openai-codex",
      applicability: "both",
      settings: [],
      skills: [],
    })
    expect(entry?.tools).toEqual({ rootExclude: [], visual: [] })
    expect(entry?.forms.headless).toEqual({ packages: [], mcpServers: [] })
    expect(DEFAULT_CONFIG.pi.features.lunaReserve).toBe(true)
  })

  test("is listed for the Codex provider and left out under any other", () => {
    const features = DEFAULT_CONFIG.pi.features
    const names = (provider?: "kimi-coding-global" | "openai-codex") =>
      enabledCapabilities(features, provider === undefined ? {} : { provider }).map(
        (capability) => capability.name,
      )
    expect(names("openai-codex")).toContain("luna-reserve")
    expect(names("kimi-coding-global")).not.toContain("luna-reserve")
    expect(names()).toContain("luna-reserve")
    expect(
      enabledCapabilities({ ...features, lunaReserve: false }, { provider: "openai-codex" }).map(
        (capability) => capability.name,
      ),
    ).not.toContain("luna-reserve")
  })
})

describe("what opens the reserve", () => {
  test("only a turn that ended on a usage or rate limit", () => {
    const failed = (errorMessage: string) => ({
      role: "assistant",
      stopReason: "error",
      errorMessage,
    })
    expect(endedOnUsageLimit(failed("You have hit your ChatGPT usage limit (plus plan)."))).toBe(
      true,
    )
    expect(endedOnUsageLimit(failed("Codex error: usage_limit_reached"))).toBe(true)
    expect(endedOnUsageLimit(failed("rate_limit_exceeded"))).toBe(true)
    expect(endedOnUsageLimit(failed("connection reset"))).toBe(false)
    expect(endedOnUsageLimit({ role: "assistant", stopReason: "stop" })).toBe(false)
    expect(
      endedOnUsageLimit({ role: "user", stopReason: "error", errorMessage: "usage limit" }),
    ).toBe(false)
    expect(
      endedOnUsageLimit({ role: "assistant", stopReason: "aborted", errorMessage: "usage limit" }),
    ).toBe(false)
  })

  test("the backend's status must offer the reserve through its banner", () => {
    expect(reserveOffered({ rate_limit_upsell: { banner_type: RESERVE_BANNER } })).toBe(true)
    expect(reserveOffered({ rate_limit_upsell: { banner_type: "upgrade" } })).toBe(false)
    expect(reserveOffered({ rate_limit_upsell: null })).toBe(false)
    expect(reserveOffered({})).toBe(false)
    expect(reserveOffered("luna_reserve")).toBe(false)
    expect(reserveOffered(undefined)).toBe(false)
  })
})

describe("sending to the reserve", () => {
  test("replaces the model id and leaves the rest, and passes a payload without a model through", () => {
    const payload = { model: "gpt-6-luna", input: [], reasoning: { effort: "low" } }
    expect(toReserve(payload)).toEqual({ ...payload, model: RESERVE_MODEL })
    expect(payload.model).toBe("gpt-6-luna")
    expect(RESERVE_MODEL).toBe("gpt-reserve")
    for (const other of [undefined, "text", { input: [] }]) expect(toReserve(other)).toBe(other)
  })
})

describe("the access token of the status request", () => {
  test("is read for its account id, which only the payload of the JWT holds", () => {
    expect(accountIdOf(SECRET)).toBe("acct_1")
    expect(accountIdOf(token())).toBeUndefined()
    expect(accountIdOf("not-a-jwt")).toBeUndefined()
    expect(accountIdOf("a.%%%.c")).toBeUndefined()
  })

  test("goes in the authorization header with the account id, and nowhere else", () => {
    expect(statusHeaders(SECRET)).toEqual({
      authorization: `Bearer ${SECRET}`,
      accept: "application/json",
      "chatgpt-account-id": "acct_1",
    })
    expect(statusHeaders(token())).not.toHaveProperty("chatgpt-account-id")
  })

  test("asks the usage status once with those headers and reads the banner", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const offered = await Effect.runPromise(
      fetchReserveOffered(SECRET, (url, init) => {
        seen.push({ url, headers: init.headers as Record<string, string> })
        return Promise.resolve(answer({ rate_limit_upsell: { banner_type: RESERVE_BANNER } }))
      }),
    )
    expect(offered).toBe(true)
    expect(seen).toEqual([{ url: USAGE_STATUS_URL, headers: statusHeaders(SECRET) }])
    expect(
      await Effect.runPromise(
        fetchReserveOffered(SECRET, () => Promise.resolve(answer({ plan_type: "plus" }))),
      ),
    ).toBe(false)
  })

  test("a refusal, a bad body or a failed request is unavailable, and no message carries the token", async () => {
    const failures = [
      () => Promise.resolve(answer({}, 401)),
      () => Promise.resolve(new Response("<html>", { status: 200 })),
      () => Promise.reject(new Error("socket closed")),
    ]
    for (const fetcher of failures) {
      const error = await Effect.runPromise(Effect.flip(fetchReserveOffered(SECRET, fetcher)))
      expect(error).toBeInstanceOf(UsageStatusUnavailable)
      expect(error.message).not.toContain(SECRET)
      expect(error.message).not.toContain("acct_1")
    }
    const refused = await Effect.runPromise(
      Effect.flip(fetchReserveOffered(SECRET, () => Promise.resolve(answer({}, 401)))),
    )
    expect(refused.message).toContain("HTTP 401")
  })
})
