import { Data, Effect, Schema } from "effect"

/**
 * The model id the Codex backend serves the Luna Reserve allowance under: a separate fallback
 * allowance for Luna that opens once the regular quota runs out. Pi's catalog does not list it, so
 * the module sends it by rewriting the request's `model` while the reserve is in use.
 */
export const RESERVE_MODEL = "gpt-reserve"

/**
 * The `rate_limit_upsell.banner_type` with which the backend's usage status says the reserve is
 * offered.
 */
export const RESERVE_BANNER = "luna_reserve"

/**
 * The backend's usage status, the document Codex's own clients read their rate-limit state from.
 * The path is the ChatGPT backend's `wham/usage`; it is kept here, with {@link RESERVE_BANNER}, so
 * a change of either is one edit.
 */
export const USAGE_STATUS_URL = "https://chatgpt.com/backend-api/wham/usage"

/** How long to wait for the usage status before the reserve counts as unavailable. */
export const STATUS_TIMEOUT_MS = 10_000

/** What a failed turn looks like when the regular quota or the rate limit is used up. */
const USAGE_LIMIT = /usage[ _]limit|usage_not_included|rate_limit_exceeded|hit your .* limit/i

/** The part of an assistant message that tells whether it ended on a usage limit. */
export interface TurnOutcome {
  readonly role: string
  readonly stopReason?: string
  readonly errorMessage?: string
}

/**
 * Whether a message is a turn that ended on a terminal usage or rate limit, the only event that can
 * open the reserve. A turn that stopped for any other reason, or an error with another text, never
 * does.
 */
export const endedOnUsageLimit = (message: TurnOutcome): boolean =>
  message.role === "assistant" &&
  message.stopReason === "error" &&
  USAGE_LIMIT.test(message.errorMessage ?? "")

/** The slice of the usage status the reserve decision reads. */
const UsageStatus = Schema.Struct({
  rate_limit_upsell: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ banner_type: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
})

const readStatus = Schema.decodeUnknownOption(UsageStatus)

/**
 * Whether a usage status offers the reserve: its `rate_limit_upsell.banner_type` is
 * {@link RESERVE_BANNER}. A status that is not an object, or names no such banner, offers nothing,
 * and the same answer says that ordinary usage has recovered while the reserve is in use.
 */
export const reserveOffered = (status: unknown): boolean => {
  const decoded = readStatus(status)
  return decoded._tag === "Some" && decoded.value.rate_limit_upsell?.banner_type === RESERVE_BANNER
}

/** The usage status could not be fetched or read; the reserve is then treated as not offered. */
export class UsageStatusUnavailable extends Data.TaggedError("UsageStatusUnavailable")<{
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `the usage status could not be read: ${this.reason}`
  }
}

/** The request helper, as the global `fetch`; a test passes its own. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const JwtClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.optionalKey(
    Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.String) }),
  ),
})

const readClaims = Schema.decodeUnknownOption(Schema.fromJsonString(JwtClaims))

/**
 * The ChatGPT account id inside an access token, which the backend wants beside the token. The
 * token is a JWT; only its payload is read, and nothing is verified here, the backend does that.
 * `undefined` for a token of another shape.
 */
export const accountIdOf = (token: string): string | undefined => {
  const payload = token.split(".")[1]
  if (payload === undefined) return undefined
  const claims = readClaims(Buffer.from(payload, "base64url").toString("utf8"))
  return claims._tag === "Some"
    ? claims.value["https://api.openai.com/auth"]?.chatgpt_account_id
    : undefined
}

/** The headers of the usage status request: the bearer token and, when known, the account id. */
export const statusHeaders = (token: string): Readonly<Record<string, string>> => {
  const account = accountIdOf(token)
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    ...(account === undefined ? {} : { "chatgpt-account-id": account }),
  }
}

/**
 * Asks the backend whether the reserve is offered, with the session's access token. The token goes
 * in the request's headers only, so no failure or notice carries it. A request that fails, times
 * out, is refused or answers something that is not JSON fails with {@link UsageStatusUnavailable}.
 */
export const fetchReserveOffered = (
  token: string,
  fetcher: Fetch = (url, init) => fetch(url, init),
): Effect.Effect<boolean, UsageStatusUnavailable> => {
  const unavailable = (cause: unknown) =>
    new UsageStatusUnavailable({
      reason: cause instanceof Error ? cause.message : "the request failed",
    })
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetcher(USAGE_STATUS_URL, {
          headers: statusHeaders(token),
          signal: AbortSignal.any([signal, AbortSignal.timeout(STATUS_TIMEOUT_MS)]),
        }),
      catch: unavailable,
    })
    if (!response.ok) return yield* unavailable(new Error(`HTTP ${response.status}`))
    return reserveOffered(
      yield* Effect.tryPromise({ try: () => response.json(), catch: unavailable }),
    )
  })
}

/**
 * Sends a request to the reserve: the request with its `model` replaced by {@link RESERVE_MODEL}. A
 * payload without a string `model` is returned as it came.
 */
export const toReserve = (payload: unknown): unknown =>
  typeof payload === "object" && payload !== null && "model" in payload
    ? { ...payload, model: RESERVE_MODEL }
    : payload

/** What the user reads when the reserve opens: it waits for them, as the regular quota did. */
export const ENTER_NOTICE =
  "the usage limit is reached and Luna Reserve is offered. Requests now go to it; send `continue` to resume. HolyAgent never redeems reset credits, and returns to the regular model once ordinary usage is back."

/** What the user reads when ordinary usage has recovered and the regular model is back. */
export const EXIT_NOTICE = "ordinary usage is back, so requests use the regular model again."
