import { describe, expect, test } from "bun:test"

import { Schema } from "effect"

import { Timestamp } from "../src/domain/primitives.ts"

describe("Timestamp", () => {
  const valid = (text: string) => Schema.is(Timestamp)(text)

  test.each(["2026-01-02T03:04:05Z", "2026-01-02T03:04:05.678Z", "2028-02-29T00:00:00.000Z"])(
    "accepts %s",
    (text) => expect(valid(text)).toBe(true),
  )

  test.each([
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2027-02-29T00:00:00Z",
    "2026-01-02 03:04:05Z",
    "2026-01-02T03:04:05+01:00",
    "yesterday",
  ])("rejects %s", (text) => expect(valid(text)).toBe(false))
})
