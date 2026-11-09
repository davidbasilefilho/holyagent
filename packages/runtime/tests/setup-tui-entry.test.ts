import { describe, expect, test } from "bun:test"

import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"

import { reviewOf } from "../src/setup/tui/session.ts"
import type { Review, TuiInput, TuiOutcome } from "../src/setup/tui/types.ts"
import { PREVIEW } from "./setup-tui-harness.ts"

// The harness registers the Solid transform, which the entry's JSX needs.
const { showSetup } = await import("../src/setup/tui/entry.tsx")

const input = (signals: Array<AbortSignal> = []): TuiInput => ({
  // COLORFGBG names the background, so the interface starts without waiting for the terminal.
  env: { TERM: "xterm-256color", COLORFGBG: "15;0" },
  offer: { device: undefined, worktrees: true },
  initial: { worktrees: true, deviceAccess: false },
  dryRun: false,
  review: (choices): Promise<Review> => Promise.resolve(reviewOf(PREVIEW, choices)),
  apply: (_choices, signal) => {
    signals.push(signal)
    return new Promise(() => undefined)
  },
})

const timeout = (ms: number): Promise<"timeout"> => Bun.sleep(ms).then(() => "timeout")

// What the setup command sees: the outcome of the interface, or "timeout" when it never ends.
const outcomeOf = (run: Promise<TuiOutcome>) => Promise.race([run, timeout(1000)])

describe("showSetup when the renderer is destroyed", () => {
  test("ends as interrupted when the terminal hangs up or the process is signalled", async () => {
    // OpenTUI destroys the renderer on SIGHUP and SIGTERM; a destroyed renderer is the same call.
    const { renderer } = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false })
    const run = Effect.runPromise(showSetup(Effect.succeed(renderer), input()))
    await Bun.sleep(20)
    renderer.destroy()
    expect(await outcomeOf(run)).toEqual({ _tag: "Interrupted" })
  })

  test("ends as interrupted when the renderer was destroyed before the interface started", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false })
    renderer.destroy()
    const run = Effect.runPromise(showSetup(Effect.succeed(renderer), input()))
    expect(await outcomeOf(run)).toEqual({ _tag: "Interrupted" })
  })

  test("stops a running apply", async () => {
    const signals: Array<AbortSignal> = []
    const { renderer, mockInput } = await createTestRenderer({
      width: 80,
      height: 24,
      exitOnCtrlC: false,
    })
    const run = Effect.runPromise(showSetup(Effect.succeed(renderer), input(signals)))
    await Bun.sleep(20)
    // Enter on the review, then on its Apply action.
    mockInput.pressEnter()
    await Bun.sleep(20)
    mockInput.pressEnter()
    await Bun.sleep(20)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    renderer.destroy()
    expect(await outcomeOf(run)).toEqual({ _tag: "Interrupted" })
    expect(signals[0]?.aborted).toBe(true)
  })
})
