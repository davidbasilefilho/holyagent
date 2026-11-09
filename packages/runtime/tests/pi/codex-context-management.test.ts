import { describe, expect, test } from "bun:test"

import { Effect, Schema } from "effect"

import { Config } from "../../src/config/schema.ts"
import {
  COMPACT_THRESHOLD_SHARE,
  compactThreshold,
  contextManagementOn,
  FALLBACK_CONTEXT_WINDOW,
  MINIMUM_THRESHOLD,
  NO_COMPACTION,
  observeStreamEvent,
  prepareRequest,
} from "../../src/pi/codex/context-management.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

const decode = (value: unknown) =>
  Effect.runPromise(Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })(value))

const user = (text: string) => ({ type: "message", role: "user", content: text })
const reply = (text: string) => ({ type: "message", role: "assistant", content: text })
const ITEM = { type: "compaction", id: "cmp_1", encrypted_content: "opaque-bytes" }
const DONE = { type: "response.output_item.done", item: ITEM }

const request = (input: ReadonlyArray<unknown>) => ({
  model: "gpt-6.1-sol",
  store: false,
  stream: true,
  input,
})

describe("the context_management gate", () => {
  test("is on for the Codex provider only while Billion Context is off", async () => {
    const off = await decode({
      pi: { provider: "openai-codex", features: { contextCompression: false } },
    })
    const on = await decode({ pi: { provider: "openai-codex" } })
    expect(on.pi.features.contextCompression).toBe(true)
    expect(contextManagementOn(off)).toBe(true)
    expect(contextManagementOn(on)).toBe(false)
  })

  test("has its own switch, on by default, that turns it off with Billion Context off", async () => {
    const off = await decode({
      pi: {
        provider: "openai-codex",
        features: { contextCompression: false, contextManagement: false },
      },
    })
    const on = await decode({
      pi: { provider: "openai-codex", features: { contextCompression: false } },
    })
    expect(on.pi.features.contextManagement).toBe(true)
    expect(contextManagementOn(on)).toBe(true)
    expect(contextManagementOn(off)).toBe(false)
  })

  test("is never on for another provider, whatever Billion Context says", async () => {
    const kimiOff = await decode({ pi: { features: { contextCompression: false } } })
    expect(contextManagementOn(kimiOff)).toBe(false)
    expect(contextManagementOn(DEFAULT_CONFIG)).toBe(false)
  })
})

describe("the compaction threshold", () => {
  test("is 90% of the window, never under the API minimum, with a fallback window", () => {
    expect(COMPACT_THRESHOLD_SHARE).toBe(0.9)
    expect(compactThreshold(500_000)).toBe(450_000)
    expect(compactThreshold(272_000)).toBe(244_800)
    expect(compactThreshold(undefined)).toBe(Math.floor(FALLBACK_CONTEXT_WINDOW * 0.9))
    expect(compactThreshold(100)).toBe(MINIMUM_THRESHOLD)
  })
})

describe("prepareRequest", () => {
  test("adds the compaction parameter and leaves the rest of the request as it was", () => {
    const original = request([user("hi")])
    const { payload, state } = prepareRequest(original, NO_COMPACTION, 450_000)
    expect(payload).toEqual({
      ...original,
      context_management: [{ type: "compaction", compact_threshold: 450_000 }],
    })
    expect(original).not.toHaveProperty("context_management")
    expect(state).toEqual({ pending: { anchor: 1, tail: JSON.stringify(user("hi")) } })
  })

  test("returns a payload that is not a Responses request as it came", () => {
    for (const other of [
      undefined,
      "text",
      { model: "x" },
      { input: [] },
      { model: 1, input: [] },
    ]) {
      expect(prepareRequest(other, NO_COMPACTION, 1000).payload).toBe(other)
    }
  })

  test("replays the item the server emitted in place of the items it stands for", () => {
    const first = [user("a"), reply("b"), user("c")]
    const sent = prepareRequest(request(first), NO_COMPACTION, 1000)
    const compacted = observeStreamEvent(sent.state, DONE)
    expect(compacted.checkpoint).toEqual({
      item: ITEM,
      anchor: 3,
      tail: JSON.stringify(user("c")),
    })
    const next = [...first, reply("d"), user("e")]
    const resent = prepareRequest(request(next), compacted, 1000)
    expect(resent.payload).toMatchObject({ input: [ITEM, reply("d"), user("e")] })
    // Pi's own input is what the checkpoint is counted in, so the next compaction still lines up.
    expect(resent.state.checkpoint).toEqual(compacted.checkpoint)
    expect(resent.state.pending?.anchor).toBe(5)
  })

  test("a newer compaction replaces the checkpoint, counted in Pi's full input", () => {
    const first = [user("a"), user("b")]
    const afterFirst = observeStreamEvent(
      prepareRequest(request(first), NO_COMPACTION, 1000).state,
      DONE,
    )
    const second = [...first, reply("c"), user("d"), reply("e"), user("f")]
    const resent = prepareRequest(request(second), afterFirst, 1000)
    const newer = { type: "compaction", id: "cmp_2", encrypted_content: "newer" }
    const afterSecond = observeStreamEvent(resent.state, {
      type: "response.output_item.done",
      item: newer,
    })
    expect(afterSecond.checkpoint).toEqual({
      item: newer,
      anchor: 6,
      tail: JSON.stringify(user("f")),
    })
    const third = prepareRequest(request([...second, reply("g"), user("h")]), afterSecond, 1000)
    expect(third.payload).toMatchObject({ input: [newer, reply("g"), user("h")] })
  })

  test("drops a checkpoint when Pi's history no longer begins with the items it covered", () => {
    const checkpointed = observeStreamEvent(
      prepareRequest(request([user("a"), user("b")]), NO_COMPACTION, 1000).state,
      DONE,
    )
    // Pi compacted or branched: the second item is no longer the one the item stood for.
    const changed = prepareRequest(
      request([user("summary"), user("other"), user("x")]),
      checkpointed,
      1000,
    )
    expect(changed.payload).toMatchObject({ input: [user("summary"), user("other"), user("x")] })
    expect(changed.state.checkpoint).toBeUndefined()
    // Pi's history got shorter than the checkpoint.
    const shorter = prepareRequest(request([user("a")]), checkpointed, 1000)
    expect(shorter.payload).toMatchObject({ input: [user("a")] })
    expect(shorter.state.checkpoint).toBeUndefined()
  })
})

describe("observeStreamEvent", () => {
  const inFlight = prepareRequest(request([user("a")]), NO_COMPACTION, 1000).state

  test("keeps only a finished compaction item, and only while a request is in flight", () => {
    expect(observeStreamEvent(inFlight, DONE).checkpoint?.item).toBe(ITEM)
    expect(observeStreamEvent(NO_COMPACTION, DONE)).toBe(NO_COMPACTION)
    for (const other of [
      { type: "response.output_item.added", item: ITEM },
      { type: "response.output_item.done", item: { type: "message" } },
      { type: "response.output_item.done", item: { type: "compaction" } },
      { type: "response.completed" },
      "not an event",
      undefined,
    ]) {
      expect(observeStreamEvent(inFlight, other)).toBe(inFlight)
    }
  })
})
