import { afterEach, describe, expect, test } from "bun:test"

import { CAPABILITIES } from "../src/config/capabilities.ts"
import { chooseForm } from "../src/setup/form.ts"
import {
  capabilityOffers,
  capabilityReview,
  changedSwitches,
  featureSwitches,
  reviewOf,
} from "../src/setup/tui/session.ts"
import { mount, type Mounted, PREVIEW } from "./setup-tui-harness.ts"

let open: Mounted | undefined
const shown = async (options: Parameters<typeof mount>[0]) => {
  open = await mount(options)
  return open
}
afterEach(() => open?.destroy())

const NORMAL = chooseForm({ DISPLAY: ":0" }, undefined, "linux")
const HEADLESS = chooseForm({}, undefined, "linux")
const OFFERS = capabilityOffers(NORMAL)

describe("the setup interface, capability rows", () => {
  test("a row for each capability follows the T3 rows under its own heading, all on", async () => {
    const screen = await shown({ width: 100, height: 40, capabilities: OFFERS })
    const lines = screen.lines()
    expect(lines.indexOf("T3 CODE")).toBeGreaterThan(-1)
    const heading = lines.indexOf(
      "CAPABILITIES, NORMAL (DETECTED: A GRAPHICAL SESSION IS AVAILABLE) FORM",
    )
    expect(heading).toBeGreaterThan(lines.indexOf("T3 CODE"))
    const rows = lines.slice(heading + 1, heading + 1 + CAPABILITIES.length)
    expect(rows.map((row) => row.replace(/^[❯ ] /, "").split(/\s{2,}/)[0])).toEqual(
      CAPABILITIES.map((capability) => capability.name),
    )
    expect(rows.every((row) => row.endsWith("[x] enabled"))).toBe(true)
  })

  test("Space toggles the focused capability, and the review and apply get the switches", async () => {
    const screen = await shown({ width: 100, height: 50, capabilities: OFFERS })
    // The three T3 rows come first.
    await screen.keys("down", "down", "down", " ")
    expect(screen.lines().find((line) => line.startsWith("❯"))).toContain("subagents")
    expect(screen.lines().find((line) => line.startsWith("❯"))).toContain("[ ] disabled")
    await screen.keys("enter")
    const [choices] = screen.reviews
    expect(choices?.capabilities["subagents"]).toBe(false)
    expect(choices?.capabilities["todo"]).toBe(true)
    const text = screen.lines().join("\n")
    expect(text).toContain("CAPABILITIES")
    expect(text).toContain("- subagents")
    expect(text).toContain("turned off (@tintinweb/pi-subagents removed)")
    expect(text).toContain("= todo")
  })

  test("without T3 work only the capability rows show, and the review has no T3 file", async () => {
    const screen = await shown({ width: 100, height: 50, t3: false, capabilities: OFFERS })
    const text = screen.lines().join("\n")
    expect(text).not.toContain("T3 CODE")
    expect(text).not.toContain("Pi provider")
    expect(screen.lines().find((line) => line.startsWith("❯"))).toContain("subagents")
    await screen.keys("enter")
    const review = screen.lines().join("\n")
    expect(review).toContain("CAPABILITIES")
    expect(review).not.toContain("YOUR CHOICES")
    expect(review).not.toContain("ALWAYS APPLIED")
    expect(review).not.toContain("settings.json")
  })

  test("a capability the form does not offer says so when focused, and can still be switched", async () => {
    const screen = await shown({
      width: 100,
      height: 50,
      t3: false,
      capabilities: capabilityOffers(HEADLESS),
    })
    // The focus wraps up from the first row to the last (fff), then back through just-bash,
    // auto-review, context-management, luna-reserve and browser-use to computer-use. Browser use
    // is offered headless (the Playwright server), so only computer use says it is not.
    await screen.keys("k")
    await screen.keys("k")
    await screen.keys("k")
    await screen.keys("k")
    await screen.keys("k")
    await screen.keys("k")
    expect(screen.lines().find((line) => line.startsWith("❯"))).toContain("browser-use")
    expect(screen.lines().join(" ").replace(/\s+/g, " ")).not.toContain("Not offered in this form")
    await screen.keys("k")
    expect(screen.lines().find((line) => line.startsWith("❯"))).toContain("computer-use")
    expect(screen.lines().join(" ").replace(/\s+/g, " ")).toContain("Not offered in this form")
    await screen.keys(" ")
    expect(screen.lines().find((line) => line.startsWith("❯"))).toContain("[ ] disabled")
  })
})

describe("the capability helpers of the setup session", () => {
  test("one offer per registry entry, with why the form leaves it out", () => {
    expect(OFFERS.map((offer) => offer.name)).toEqual(
      CAPABILITIES.map((capability) => capability.name),
    )
    expect(OFFERS.every((offer) => offer.unavailable === undefined)).toBe(true)
    expect(
      capabilityOffers(HEADLESS)
        .filter((offer) => offer.unavailable !== undefined)
        .map((offer) => offer.name),
    ).toEqual(["computer-use"])
  })

  test("the switches of a config are read by key, and only the differing ones are written", () => {
    const initial = featureSwitches({
      web: "provider",
      processes: true,
      todo: true,
      ask: true,
      mcp: true,
      computerUse: false,
      contextCompression: true,
      subagents: true,
      lunaReserve: true,
      contextManagement: true,
      autoReview: true,
      justBash: true,
      fff: true,
      browserUse: true,
    })
    expect(initial["computerUse"]).toBe(false)
    expect(changedSwitches(initial, initial)).toEqual({})
    expect(changedSwitches(initial, { ...initial, todo: false, computerUse: true })).toEqual({
      todo: false,
      computerUse: true,
    })
  })

  test("the review marks a switch turned on, turned off, unchanged, or not offered", () => {
    const initial = { todo: true, ask: false, computerUse: true }
    const chosen = { todo: false, ask: true, computerUse: true, subagents: true }
    const lines = capabilityReview(initial, chosen, HEADLESS)
    const byName = Object.fromEntries(lines.map((line) => [line.name, line]))
    expect(byName["todo"]).toEqual({
      mark: "-",
      name: "todo",
      detail: "turned off (@juicesharp/rpiv-todo removed)",
    })
    expect(byName["ask"]).toMatchObject({ mark: "+" })
    expect(byName["ask"]?.detail).toBe("turned on (@juicesharp/rpiv-ask-user-question)")
    expect(byName["subagents"]).toMatchObject({ mark: "+" })
    expect(byName["computer-use"]).toEqual({
      mark: "~",
      name: "computer-use",
      detail:
        "on in the config; not offered in the headless form (it drives a graphical session and this machine has none)",
    })
    expect(byName["processes"]).toEqual({ mark: "=", name: "processes", detail: "stays off" })
  })

  test("a review without a T3 preview holds the capability lines alone", () => {
    const lines = capabilityReview({}, {}, NORMAL)
    expect(
      reviewOf(undefined, { worktrees: true, deviceAccess: true, capabilities: {} }, lines),
    ).toEqual({
      file: undefined,
      capabilities: lines,
      choices: [],
      always: [],
    })
    expect(
      reviewOf(PREVIEW, { worktrees: true, deviceAccess: true, capabilities: {} }, lines).file,
    ).toBe(PREVIEW.file)
  })
})
