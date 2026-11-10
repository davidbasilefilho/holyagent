import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import {
  failedAssessment,
  MANUAL_APPROVAL_PREFIX,
  REJECTION_INSTRUCTIONS,
  TIMEOUT_AGAIN_MESSAGE,
  TIMEOUT_MESSAGE,
} from "../../src/pi/codex/auto-review/assessment.ts"
import { gate, type GateResult } from "../../src/pi/codex/auto-review/gate.ts"
import {
  type ReviewerClient,
  type ReviewerRequest,
  ReviewerUnavailable,
} from "../../src/pi/codex/auto-review/review.ts"
import {
  createReviewSession,
  MAX_CONSECUTIVE_DENIALS,
  MAX_TOTAL_DENIALS,
  type ReviewSession,
} from "../../src/pi/codex/auto-review/session.ts"

const ROOT = "/work/project"

const answer = (outcome: "allow" | "deny", rationale = "Because.") =>
  JSON.stringify({
    risk_level: outcome === "allow" ? "low" : "high",
    user_authorization: "unknown",
    outcome,
    rationale,
  })

/** A client that answers with the next text of its script, and records its requests. */
const scripted = (...answers: Array<string>) => {
  const requests: Array<ReviewerRequest> = []
  let next = 0
  const client: ReviewerClient = (request) => {
    requests.push(request)
    const text = answers[Math.min(next++, answers.length - 1)] ?? ""
    return Effect.succeed(text)
  }
  return { client, requests }
}

const RISKY = { toolName: "bash", input: { command: "rm -rf build" } }

const run = (
  client: ReviewerClient,
  session: ReviewSession,
  call = RISKY,
  timeoutMs?: number,
): Promise<GateResult> =>
  Effect.runPromise(
    gate({
      call,
      cwd: ROOT,
      entries: Effect.succeed([{ role: "user", kind: "user", text: "clean up" }]),
      client: Effect.succeed(client),
      policy: {},
      session,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    }),
  )

describe("what the gate lets run", () => {
  test("a call the classifier does not pick runs without asking the reviewer", async () => {
    const { client, requests } = scripted(answer("deny"))
    const result = await run(client, createReviewSession(), {
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(result).toEqual({ block: false })
    expect(requests).toHaveLength(0)
  })

  test("an allow runs the tool, and says why", async () => {
    const { client, requests } = scripted(answer("allow", "Removes a build folder."))
    const result = await run(client, createReviewSession())
    expect(result.block).toBe(false)
    expect(result.block === false ? result.notice : "").toBe(
      "Automatic approval review approved (risk: low, authorization: unknown): Removes a build folder.",
    )
    expect(requests).toHaveLength(1)
  })
})

describe("denials", () => {
  test("a deny blocks the tool with Codex's rejection text, the reason and the instructions", async () => {
    const { client } = scripted(answer("deny", "Deletes files the user did not name."))
    const result = await run(client, createReviewSession())
    expect(result).toMatchObject({
      block: true,
      interrupt: false,
      reason: `This action was rejected due to unacceptable risk.\nReason: Deletes files the user did not name.\n${REJECTION_INSTRUCTIONS}`,
    })
    expect(REJECTION_INSTRUCTIONS).toContain("must not attempt to achieve the same outcome")
  })

  test("the breaker stops the turn at the third denial in a row", async () => {
    const { client } = scripted(answer("deny"))
    const session = createReviewSession()
    const results = [await run(client, session), await run(client, session)]
    expect(results.map((result) => result.block && result.interrupt)).toEqual([false, false])
    const third = await run(client, session)
    expect(MAX_CONSECUTIVE_DENIALS).toBe(3)
    expect(third).toMatchObject({ block: true, interrupt: true })
    expect(third.block ? third.reason : "").toContain("3 consecutive, 3 total")
    // It fires once for the turn.
    expect(await run(client, session)).toMatchObject({ block: true, interrupt: false })
  })

  test("an allow in between ends the run of denials, and the tenth denial of the turn stops it", async () => {
    const session = createReviewSession()
    const deny = scripted(answer("deny")).client
    const allow = scripted(answer("allow")).client
    const interrupts: Array<boolean> = []
    // deny, deny, allow, ... : never three in a row, so only the total can stop the turn.
    for (let round = 0; round < 5; round++) {
      for (const client of [deny, deny, allow]) {
        const result = await run(client, session)
        if (result.block) interrupts.push(result.interrupt)
      }
    }
    expect(MAX_TOTAL_DENIALS).toBe(10)
    expect(interrupts).toHaveLength(10)
    expect(interrupts.slice(0, 9).every((interrupt) => !interrupt)).toBe(true)
    expect(interrupts[9]).toBe(true)
  })

  test("a new turn starts the counts again", async () => {
    const { client } = scripted(answer("deny"))
    const session = createReviewSession()
    await run(client, session)
    await run(client, session)
    session.newTurn()
    expect(await run(client, session)).toMatchObject({ block: true, interrupt: false })
  })
})

describe("timeouts and failures", () => {
  const never: ReviewerClient = () => Effect.never

  test("a timeout is not a denial: the call is blocked with the timeout text, and the breaker is untouched", async () => {
    const session = createReviewSession()
    const deny = scripted(answer("deny")).client
    await run(deny, session)
    await run(deny, session)
    const result = await run(never, session, RISKY, 20)
    expect(result).toMatchObject({ block: true, reason: TIMEOUT_MESSAGE, interrupt: false })
    expect(TIMEOUT_MESSAGE).toContain(
      "Do not assume the action is unsafe based on the timeout alone",
    )
    expect(TIMEOUT_MESSAGE).toContain("You may retry once")
    // The timeout ended the run of denials: the next denial is the first of a new run.
    expect(await run(deny, session)).toMatchObject({ block: true, interrupt: false })
  })

  test("the retry is reviewed again, and runs when the reviewer allows it", async () => {
    const session = createReviewSession()
    expect(await run(never, session, RISKY, 20)).toMatchObject({ reason: TIMEOUT_MESSAGE })
    const { client, requests } = scripted(answer("allow"))
    expect((await run(client, session)).block).toBe(false)
    expect(requests).toHaveLength(1)
  })

  test("a retry that times out too is told not to retry again, and is still no denial", async () => {
    const session = createReviewSession()
    await run(never, session, RISKY, 20)
    const second = await run(never, session, RISKY, 20)
    expect(second).toMatchObject({ block: true, reason: TIMEOUT_AGAIN_MESSAGE, interrupt: false })
    expect(session.denied()).toEqual([])
  })

  test("a failed request denies closed, with Codex's failure rationale, and is not counted", async () => {
    const failing: ReviewerClient = () =>
      Effect.fail(new ReviewerUnavailable({ reason: "the review request failed: HTTP 503" }))
    const session = createReviewSession()
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await run(failing, session)
      expect(result).toMatchObject({ block: true, interrupt: false })
      expect(result.block ? result.reason : "").toContain(
        "Reason: Automatic approval review failed: the review request failed: HTTP 503",
      )
    }
    expect(failedAssessment("x")).toEqual({
      risk_level: "high",
      user_authorization: "unknown",
      outcome: "deny",
      rationale: "Automatic approval review failed: x",
    })
  })

  test("an answer that is not a valid assessment denies closed", async () => {
    for (const text of ["I think it is fine", '{"outcome":"allow"}', ""]) {
      const { client } = scripted(text)
      const result = await run(client, createReviewSession())
      expect(result.block).toBe(true)
      expect(result.block ? result.reason : "").toContain("Automatic approval review failed")
    }
  })

  test("a client that throws denies closed", async () => {
    const throwing: ReviewerClient = () => {
      throw new Error("boom")
    }
    const result = await run(throwing, createReviewSession())
    expect(result.block ? result.reason : "").toContain("Automatic approval review failed: boom")
  })
})

describe("the /approve override", () => {
  test("lifts one denied action for one retry, which is reviewed with the approval in its transcript", async () => {
    const session = createReviewSession()
    await run(scripted(answer("deny", "Too risky.")).client, session)
    expect(session.denied().map((action) => action.summary)).toEqual(["rm -rf build"])
    expect(session.approve(0)?.summary).toBe("rm -rf build")
    expect(session.denied()).toEqual([])

    const retry = scripted(answer("allow", "The user approved it."))
    expect((await run(retry.client, session)).block).toBe(false)
    expect(retry.requests[0]?.prompt).toContain(MANUAL_APPROVAL_PREFIX)
    expect(retry.requests[0]?.prompt).toContain('"command": "rm -rf build"')

    // The approval covered one retry: the next call is reviewed without it.
    const next = scripted(answer("deny"))
    expect((await run(next.client, session)).block).toBe(true)
    expect(next.requests[0]?.prompt).not.toContain(MANUAL_APPROVAL_PREFIX)
  })

  test("is still reviewed: a retry the reviewer denies stays denied, and the approval is used up", async () => {
    const session = createReviewSession()
    await run(scripted(answer("deny")).client, session)
    session.approve(0)
    const retry = scripted(answer("deny", "Still unsafe."))
    expect(await run(retry.client, session)).toMatchObject({ block: true })
    const again = scripted(answer("deny"))
    await run(again.client, session)
    expect(again.requests[0]?.prompt).not.toContain(MANUAL_APPROVAL_PREFIX)
  })

  test("covers only the exact action it was given for", async () => {
    const session = createReviewSession()
    await run(scripted(answer("deny")).client, session)
    session.approve(0)
    const other = scripted(answer("deny"))
    await run(other.client, session, { toolName: "bash", input: { command: "rm -rf dist" } })
    expect(other.requests[0]?.prompt).not.toContain(MANUAL_APPROVAL_PREFIX)
  })

  test("keeps the ten latest denied actions, newest first, and an unknown index approves nothing", async () => {
    const session = createReviewSession()
    const client = scripted(answer("deny")).client
    for (let index = 0; index < 12; index++) {
      session.newTurn()
      await run(client, session, { toolName: "bash", input: { command: `rm -rf d${index}` } })
    }
    expect(session.denied()).toHaveLength(10)
    expect(session.denied()[0]?.summary).toBe("rm -rf d11")
    expect(session.denied()[9]?.summary).toBe("rm -rf d2")
    expect(session.approve(10)).toBeUndefined()
    expect(session.approve(-1)).toBeUndefined()
  })

  test("a timed-out review keeps the approval for the next retry", async () => {
    const session = createReviewSession()
    await run(scripted(answer("deny")).client, session)
    session.approve(0)
    await run(() => Effect.never, session, RISKY, 20)
    const retry = scripted(answer("allow"))
    await run(retry.client, session)
    expect(retry.requests[0]?.prompt).toContain(MANUAL_APPROVAL_PREFIX)
  })

  test("a failed review can be approved too, and leaves the breaker alone", async () => {
    const session = createReviewSession()
    await run(() => Effect.fail(new ReviewerUnavailable({ reason: "down" })), session)
    expect(session.denied()).toHaveLength(1)
  })

  test("a failed review does not use up the approval, so the next try still carries it", async () => {
    const session = createReviewSession()
    await run(scripted(answer("deny")).client, session)
    session.approve(0)
    await run(() => Effect.fail(new ReviewerUnavailable({ reason: "HTTP 503" })), session)
    // The failed try does not list the action as denied again, so it cannot be approved twice.
    expect(session.denied()).toEqual([])
    const retry = scripted(answer("allow"))
    expect((await run(retry.client, session)).block).toBe(false)
    expect(retry.requests[0]?.prompt).toContain(MANUAL_APPROVAL_PREFIX)
    // Now the decision used it up.
    const after = scripted(answer("deny"))
    await run(after.client, session)
    expect(after.requests[0]?.prompt).not.toContain(MANUAL_APPROVAL_PREFIX)
  })
})

describe("the work a call that runs at once does not do", () => {
  test("neither the client nor the history is built for a call the classifier lets run", async () => {
    let built = 0
    const counted = <A>(value: A) =>
      Effect.sync(() => {
        built++
        return value
      })
    const input = (call: { toolName: string; input: Record<string, unknown> }) => ({
      call,
      cwd: ROOT,
      entries: counted([]),
      client: counted<ReviewerClient>(() => Effect.succeed(answer("allow"))),
      policy: {},
      session: createReviewSession(),
    })
    for (const call of [
      { toolName: "read", input: { path: "a.ts" } },
      { toolName: "bash", input: { command: "ls" } },
      { toolName: "write", input: { path: "a.ts", content: "x" } },
    ])
      expect(await Effect.runPromise(gate(input(call)))).toEqual({ block: false })
    expect(built).toBe(0)
    await Effect.runPromise(gate(input(RISKY)))
    expect(built).toBe(2)
  })
})

describe("the retry that a timeout allows", () => {
  test("belongs to its turn: a new turn forgets that the review timed out", async () => {
    const session = createReviewSession()
    expect(await run(() => Effect.never, session, RISKY, 20)).toMatchObject({
      reason: TIMEOUT_MESSAGE,
    })
    session.newTurn()
    expect(await run(() => Effect.never, session, RISKY, 20)).toMatchObject({
      reason: TIMEOUT_MESSAGE,
    })
  })
})

describe("a rationale left empty", () => {
  test("is accepted on a low-risk allow, and denies closed on any other decision", async () => {
    const low = JSON.stringify({
      risk_level: "low",
      user_authorization: "high",
      outcome: "allow",
      rationale: "",
    })
    expect(await run(scripted(low).client, createReviewSession())).toEqual({
      block: false,
      notice: "Automatic approval review approved (risk: low, authorization: high)",
    })
    for (const [outcome, risk] of [
      ["allow", "medium"],
      ["deny", "low"],
    ]) {
      const empty = JSON.stringify({
        risk_level: risk,
        user_authorization: "high",
        outcome,
        rationale: " ",
      })
      const result = await run(scripted(empty).client, createReviewSession())
      expect(result.block ? result.reason : "").toContain("Automatic approval review failed")
    }
  })
})
