import { afterEach, describe, expect, test } from "bun:test"

import { cells, clip, wrap, wrapItems } from "../src/setup/tui/text.ts"
import { colorEnabled, TERMINAL_THEME, unicodeEnabled } from "../src/setup/tui/theme.ts"
import { mount, type Mounted, PREVIEW, spanListing } from "./setup-tui-harness.ts"

let open: Mounted | undefined
const shown = async (options: Parameters<typeof mount>[0]) => {
  open = await mount(options)
  return open
}
afterEach(() => open?.destroy())

const ROW = (text: string) => (line: string) => line.includes(text)
const withoutRail = (line: string) => line.replace(/ +[█│]$/, "")
const clickText = async (screen: Mounted, text: string, exact = false) => {
  const lines = screen.lines()
  const row = lines.findIndex(exact ? (line) => line.replace(/^❯ /, "").trim() === text : ROW(text))
  expect(row).toBeGreaterThanOrEqual(0)
  const line = lines[row] ?? ""
  await screen.click(cells(line.slice(0, line.indexOf(text))), row)
}

describe("the setup interface, choose screen", () => {
  test("shows the title, Enter hint, settings and a separate review button", async () => {
    const screen = await shown({ width: 80, height: 24 })
    const text = screen.lines().join("\n")
    expect(text).toContain("HolyAgent  ·  setup")
    expect(text).toContain("Enter select")
    expect(text).not.toContain("Space")
    expect(text).not.toContain("fixed")
    expect(text).toContain("❯ Agent device access")
    expect(text).toContain("New threads in worktrees")
    expect(text).toContain("[Review choices]")
  })

  test.each([101, 38])(
    "the Pi worktree row and state columns stay aligned at %s columns",
    async (width) => {
      const screen = await shown({
        width,
        height: 30,
        combined: true,
        capabilities: [
          {
            feature: "browserUse",
            name: "browser-use",
            description: "Use a browser.",
            unavailable: undefined,
          },
        ],
      })
      const columns = () =>
        screen.lines().flatMap((line) => {
          const column = line.search(/\[[x ]\]/)
          return column < 0 ? [] : [cells(line.slice(0, column))]
        })
      const initial = columns()
      expect(initial).toHaveLength(6)
      expect(new Set(initial).size).toBe(1)
      await screen.keys("down", "down", "down", "down")
      const focus = screen.lines().find((line) => line.startsWith("❯"))
      expect(focus).toStartWith("❯ New threads in")
      expect(screen.lines().join("\n")).toMatch(/^  New T3 Code threads/m)
      expect(columns()).toEqual(initial)
      await clickText(screen, "New threads in")
      expect(screen.lines().find((line) => line.startsWith("❯"))).toContain("[ ] disabled")
      expect(columns()).toEqual(initial)
      expect(screen.lines().join("\n")).toContain("[Review choices]")
    },
  )

  test("space does nothing and Enter toggles without reviewing", async () => {
    const screen = await shown({ width: 80, height: 24 })
    const before = screen.lines()
    await screen.keys(" ")
    expect(screen.lines()).toEqual(before)
    await screen.keys("enter")
    expect(screen.lines().find(ROW("❯"))).toContain("[ ] disabled")
    expect(screen.reviews).toEqual([])
    await screen.keys("down", "down", "enter")
    expect(screen.reviews).toHaveLength(1)
    expect(screen.applies).toEqual([])
  })

  test("omits unavailable T3 choices and keeps the review button", async () => {
    const screen = await shown({ width: 80, height: 24, device: undefined, worktrees: false })
    const text = screen.lines().join("\n")
    expect(text).not.toContain("Agent device access")
    expect(text).not.toContain("worktrees")
    expect(text).toContain("❯ [Review choices]")
  })
})

describe("the setup interface, review and apply", () => {
  test("retains multiple harnesses and Pi providers by keyboard without applying", async () => {
    const screen = await shown({ width: 80, height: 30, combined: true })
    const initial = screen.lines().join("\n")
    expect(initial).toMatch(/Kimi for Coding[^\n]*\[x\][^\n]*enabled/)
    expect(initial).toMatch(/OpenAI Codex[^\n]*\[ \][^\n]*disabled/)
    expect(initial).not.toMatch(/\[x\][^\n]*default/)
    await screen.keys("down", "down", "enter")
    const selected = screen.lines().join("\n")
    expect(selected).toMatch(/Kimi for Coding[^\n]*\[x\][^\n]*enabled/)
    expect(selected).toMatch(/OpenAI Codex[^\n]*\[x\][^\n]*enabled/)
    await screen.keys("right", "enter", "right")
    expect(screen.lines().join("\n")).toContain("Codex setup is not available")
    await screen.keys("right", "end", "enter")
    expect(screen.reviews).toEqual([
      {
        worktrees: true,
        deviceAccess: true,
        capabilities: {},
        harnesses: { pi: true, claude: true },
        piProviders: {
          providers: ["kimi-coding-global", "openai-codex"],
        },
      },
    ])
    expect(screen.applies).toEqual([])
  })

  test("goes through choices, back, apply and close using only the mouse", async () => {
    const screen = await shown({ width: 80, height: 36 })
    await clickText(screen, "New threads in worktrees")
    await clickText(screen, "Review choices")
    expect(screen.reviews).toEqual([{ worktrees: false, deviceAccess: true, capabilities: {} }])
    expect(screen.applies).toEqual([])
    await clickText(screen, "Back", true)
    await clickText(screen, "Agent device access")
    await clickText(screen, "Review choices")
    await clickText(screen, "Apply", true)
    expect(screen.applies).toEqual([{ worktrees: false, deviceAccess: false, capabilities: {} }])
    await clickText(screen, "Close (Enter or q)")
    expect(screen.outcomes.map(({ _tag }) => _tag)).toEqual(["Applied"])
  })

  test("cancels a reviewed setup by mouse without applying changes", async () => {
    const screen = await shown({ width: 48, height: 20 })
    await clickText(screen, "Review choices")
    await clickText(screen, "Cancel", true)
    expect(screen.applies).toEqual([])
    expect(screen.outcomes).toEqual([{ _tag: "Cancelled" }])
  })

  test("Enter reviews the current choices: what each switch changes and what is always applied", async () => {
    const screen = await shown({ width: 80, height: 40 })
    await screen.keys("enter", "end", "enter")
    expect(screen.reviews).toEqual([{ worktrees: true, deviceAccess: false, capabilities: {} }])
    const text = screen.lines().join("\n")
    expect(text).toContain("REVIEW")
    expect(text).toContain("/home/user/.t3/userdata/settings.json")
    expect(text).toContain("YOUR CHOICES")
    expect(text).toContain("+ Pi provider")
    expect(text).toContain("- Agent device access       off; nothing written")
    expect(text).toContain("ALWAYS APPLIED")
    await screen.keys("pagedown")
    expect(screen.lines().join("\n")).toContain("= Branch naming             already set")
    expect(screen.lines().find(ROW("❯"))).toBe("❯ Apply")
    expect(screen.applies).toEqual([])
  })

  test("confirming applies the choices once and shows the result; closing reports it", async () => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("down", "enter", "end", "enter", "enter")
    expect(screen.applies).toEqual([{ worktrees: false, deviceAccess: true, capabilities: {} }])
    const text = screen.lines().join("\n")
    expect(text).toContain("RESULT")
    expect(text).toContain("Setup finished.")
    expect(text).toContain("CHANGES\nt3 settings")
    expect(text).not.toContain("defaultThreadEnvMode")
    expect(screen.outcomes).toEqual([])
    await screen.click(3, 2)
    expect(screen.lines().join("\n")).toContain("+ t3 settings: added defaultThreadEnvMode")
    await screen.click(3, 1)
    expect(screen.outcomes).toEqual([
      {
        _tag: "Applied",
        applied: { ok: true, lines: ["+ t3 settings: added defaultThreadEnvMode"] },
      },
    ])
  })

  test("a completed setup keeps browser advice as a warning, not a failure", async () => {
    const lines = ["~ setup harness: pi", "~ browser-use: install the optional runner"]
    const screen = await shown({
      width: 80,
      height: 24,
      apply: () => Promise.resolve({ ok: true, lines }),
    })
    await screen.keys("end", "enter", "enter")
    const summary = screen.lines().join("\n")
    expect(summary).toContain("Setup finished.")
    expect(summary).toContain("WARNINGS\nbrowser-use")
    expect(summary).not.toContain("setup harness")
    await screen.keys("d")
    expect(screen.lines().join("\n")).toContain(lines.join("\n"))
  })

  test("a failed apply is shown as a failure with its lines", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      apply: () =>
        Promise.resolve({
          ok: false,
          lines: ["! t3 settings: /t3/settings.json changed while setup worked"],
        }),
    })
    await screen.keys("end", "enter", "enter")
    const text = screen.lines().join("\n")
    expect(text).toContain("Setup finished with failures.")
    expect(text).toContain("WARNINGS\nt3 settings")
    expect(text).not.toContain("/t3/settings.json")
    await screen.keys("d")
    expect(screen.lines().join("\n")).toContain("! t3 settings: /t3/settings.json changed")
    await screen.keys("q")
    expect(screen.outcomes).toEqual([
      {
        _tag: "Applied",
        applied: {
          ok: false,
          lines: ["! t3 settings: /t3/settings.json changed while setup worked"],
        },
      },
    ])
  })

  test("an apply that rejects is shown as a failed setup line", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      apply: () => Promise.reject(new Error("the process was killed")),
    })
    await screen.keys("end", "enter", "enter", "d")
    expect(screen.lines().join("\n")).toContain("! setup: the process was killed")
  })

  test("a review that cannot be read offers Back and Cancel only", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      review: () => Promise.reject(new Error("settings.json is not a JSON object")),
    })
    await screen.keys("end", "enter")
    const text = screen.lines().join("\n")
    expect(text).toContain("settings.json is not a JSON object")
    expect(text).not.toContain("Apply")
    await screen.keys("enter")
    expect(screen.lines()[3]).toBe("T3 CODE")
    expect(screen.applies).toEqual([])
  })

  test("Back returns to the choices with them kept, and a late review reply is dropped", async () => {
    let release: () => void = () => {}
    const screen = await shown({
      width: 80,
      height: 24,
      review: () =>
        new Promise((resolve) => {
          release = () => resolve(undefined as never)
        }),
    })
    await screen.keys("enter", "end", "enter")
    expect(screen.lines().join("\n")).toContain("Reading what will change")
    await screen.keys("enter")
    expect(screen.lines()[3]).toBe("T3 CODE")
    expect(screen.lines().join("\n")).toMatch(/Agent device access +\[ \] disabled/)
    release()
    await screen.settle()
    expect(screen.lines()[3]).toBe("T3 CODE")
  })

  test("a dry run says so on the review and the apply action", async () => {
    const screen = await shown({ width: 80, height: 24, dryRun: true })
    await screen.keys("end", "enter")
    expect(screen.lines().join("\n")).toContain(
      "REVIEW (DRY RUN: WOULD CHANGE, NOTHING IS WRITTEN)",
    )
    expect(screen.lines().join("\n")).toContain("❯ Apply (dry run)")
  })

  test("the review moves between Apply, Back and Cancel and Cancel cancels", async () => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("end", "enter", "down", "down")
    expect(screen.lines().find(ROW("❯"))).toBe("❯ Cancel")
    await screen.keys("enter")
    expect(screen.outcomes).toEqual([{ _tag: "Cancelled" }])
    expect(screen.applies).toEqual([])
  })
})

describe("the setup interface, cancel", () => {
  test.each([["escape"], ["ctrl-c"], ["q"]])(
    "%s on the choices cancels and runs nothing",
    async (key) => {
      const screen = await shown({ width: 80, height: 24 })
      await screen.keys("enter", key)
      expect(screen.outcomes).toEqual([{ _tag: "Cancelled" }])
      expect(screen.reviews).toEqual([])
      expect(screen.applies).toEqual([])
    },
  )

  test.each([["escape"], ["ctrl-c"]])("%s on the review cancels and runs no apply", async (key) => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("end", "enter", key)
    expect(screen.outcomes).toEqual([{ _tag: "Cancelled" }])
    expect(screen.applies).toEqual([])
  })

  test("a slow step shows real transitions, keeps time, and accepts Ctrl+C", async () => {
    const install = Promise.withResolvers<void>()
    const next = Promise.withResolvers<void>()
    const harness = { index: 1, total: 2, label: "Pi / T3 Code" }
    const screen = await shown({
      width: 42,
      height: 20,
      apply: async (_choices, signal, report) => {
        report?.({ harness, phase: { index: 1, total: 2, label: "Pi packages" } })
        report?.({
          harness,
          phase: { index: 1, total: 2, label: "Pi packages", activity: "Installing npm:tool@1.0" },
        })
        await install.promise
        report?.({ harness, phase: { index: 2, total: 2, label: "Pi tool settings" } })
        await next.promise
        signal.throwIfAborted()
        return { ok: true, lines: [] }
      },
    })
    const text = () => screen.lines().join("\n")
    await screen.keys("end", "enter", "enter")
    expect(text()).toContain("APPLYING")
    expect(text()).toContain("Harness 1 of 2: Pi / T3 Code")
    expect(text()).toContain("Step 1 of 2: Pi packages")
    expect(text()).toContain("Installing npm:tool@1.0")
    expect(text()).not.toContain("Step 2 of 2")
    await Bun.sleep(1250)
    await screen.keys("escape", "down")
    expect(text()).toMatch(/Elapsed [1-9]\d*s/)
    expect(text()).toContain("Step 1 of 2: Pi packages")
    expect(screen.outcomes).toEqual([])
    expect(screen.signals[0]?.aborted).toBe(false)
    install.resolve()
    await screen.settle()
    expect(text()).toContain("Step 2 of 2: Pi tool settings")
    expect(text()).not.toContain("Installing npm:tool@1.0")
    await screen.keys("ctrl-c")
    expect(screen.outcomes).toEqual([{ _tag: "Interrupted" }])
    expect(screen.signals[0]?.aborted).toBe(true)
    next.resolve()
    await screen.settle()
    expect(screen.outcomes).toEqual([{ _tag: "Interrupted" }])
    expect(text()).not.toContain("Setup finished")
  })
})

describe("the setup interface, look", () => {
  test("uses the Tokyo Night tokens: heading bold, focus bold, enabled green, hints grey", async () => {
    const screen = await shown({ width: 80, height: 24 })
    const listing = spanListing(screen)
    expect(listing).toContain(`${TERMINAL_THEME.heading} bold "HolyAgent  ·  setup"`)
    expect(listing).toContain(`${TERMINAL_THEME.option} "↑/↓ or j/k focus`)
    expect(listing).toContain(`${TERMINAL_THEME.heading} bold "T3 CODE"`)
    expect(listing).toContain(`${TERMINAL_THEME.focus} bold "❯ Agent device access`)
    expect(listing).toContain(`${TERMINAL_THEME.enabled} "[x] enabled"`)
    expect(listing).toContain(`${TERMINAL_THEME.hint} "Lets agents use the iOS simulator`)
    await screen.keys("enter")
    expect(spanListing(screen)).toContain(
      `${TERMINAL_THEME.focus} bold "❯ Agent device access       [ ] disabled"`,
    )
    await screen.keys("down")
    expect(spanListing(screen)).toContain(
      `${TERMINAL_THEME.argument} "  Agent device access       [ ] disabled"`,
    )
  })

  test("NO_COLOR draws in the terminal's own colour and keeps bold", async () => {
    const screen = await shown({
      width: 80,
      height: 28,
      env: { TERM: "xterm-256color", NO_COLOR: "1" },
    })
    await screen.keys("enter")
    const listing = spanListing(screen)
    expect(listing).not.toMatch(/#[0-9a-f]{6}/)
    expect(listing).toContain('default bold "HolyAgent  ·  setup"')
    expect(listing).toContain('default bold "❯ Agent device access       [ ] disabled"')
    expect(screen.lines().join("\n")).toMatch(/Agent device access +\[ \] disabled/)
    await screen.keys("end", "enter", "pagedown")
    expect(spanListing(screen)).not.toMatch(/#[0-9a-f]{6}/)
    expect(screen.lines().join("\n")).toContain("+ Pi provider")
  })

  test("a locale that is not UTF-8 gets ASCII glyphs only", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      env: { TERM: "xterm-256color", LANG: "C" },
    })
    await screen.keys("end", "enter")
    for (const line of screen.lines()) expect(line).toMatch(/^[\x20-\x7e]*$/)
    expect(screen.lines()[0]).toBe("HolyAgent  -  setup")
    expect(screen.lines().join("\n")).toContain("> Apply")
  })

  test("at 40 columns no line is cut off, the key hint wraps whole and the focus row fits", async () => {
    const screen = await shown({ width: 40, height: 20 })
    const lines = screen.lines()
    expect(lines[1]).toBe("↑/↓ or j/k focus   Enter select")
    expect(lines[2]).toBe("Esc cancel")
    expect(lines.some((line) => line.includes("❯ Agent device access"))).toBe(true)
    expect(lines.some((line) => line.includes("New threads in worktrees"))).toBe(true)
    for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(40)
    await screen.keys("end", "enter")
    const review = screen.lines()
    expect(review.length).toBeLessThanOrEqual(20)
    expect(review.join("\n")).toContain("❯ Apply")
    expect(review.join("\n")).toContain("PgDn for more")
    for (const line of review) expect(cells(line)).toBeLessThanOrEqual(40)
  })

  test("a resize reflows the screen", async () => {
    const screen = await shown({ width: 80, height: 24 })
    expect(screen.lines()[1]).toBe("↑/↓ or j/k focus   Enter select   Esc cancel")
    await screen.resize(40, 20)
    expect(screen.lines()[2]).toBe("Esc cancel")
  })

  test("a mouse scrollbar reaches the end and back without selecting a review action", async () => {
    const width = 49
    const screen = await shown({ width, height: 20 })
    const track = () => screen.lines().flatMap((line, y) => (/[█│]$/.test(line) ? [y] : []))
    const position = () => screen.lines().find((line) => line.startsWith("Lines "))
    await screen.keys("end", "enter")
    const first = position()
    const end = track().at(-1)
    expect(end).toBeDefined()
    if (end === undefined) throw new Error("No visible scrollbar")
    await screen.click(width - 1, end)
    expect(position()).toContain("PgUp for earlier")
    const top = track()[0]
    if (top === undefined) throw new Error("No visible scrollbar after scrolling")
    await screen.click(width - 1, top)
    expect(position()).toBe(first)
    expect(screen.applies).toHaveLength(0)
  })

  test("the ASCII scrollbar in full results is clickable", async () => {
    const width = 48
    const screen = await shown({
      width,
      height: 20,
      env: { LANG: "C" },
      apply: () =>
        Promise.resolve({
          ok: true,
          lines: Array.from({ length: 40 }, (_, index) => `~ Result line ${index}`),
        }),
    })
    await screen.keys("end", "enter", "enter", "d")
    const last = screen.lines().findLastIndex((line) => line.endsWith("|"))
    expect(last).toBeGreaterThan(0)
    await screen.click(width - 1, last)
    expect(screen.lines().join("\n")).toContain("Result line 39")
    expect(screen.outcomes).toHaveLength(0)
  })

  test("a long result scrolls with Page Down and every line can be read", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `+ line ${index}`)
    const screen = await shown({
      width: 80,
      height: 12,
      apply: () => Promise.resolve({ ok: true, lines }),
    })
    await screen.keys("end", "enter", "enter", "d")
    expect(screen.lines()).toHaveLength(12)
    expect(screen.lines().at(-1)).toBe("Lines 1-5 of 30, PgDn for more")
    const seen = new Set<string>()
    for (let page = 0; page < 8; page += 1) {
      for (const line of screen.lines()) seen.add(withoutRail(line))
      await screen.wheel(3, 6, "down")
    }
    for (const line of lines) expect(seen.has(line)).toBe(true)
    expect(screen.lines().at(-1)).toBe("Lines 26-30 of 30, PgUp for earlier")
    await screen.keys("pageup")
    expect(screen.lines().at(-1)).toBe("Lines 22-26 of 30, PgUp/PgDn")
    expect(screen.outcomes).toEqual([])
  })
})

const LONG_APPLIED = (dry: boolean): { ok: boolean; lines: Array<string> } => ({
  ok: false,
  lines: [
    "~ scope: user (default)",
    "! t3 settings: /home/user/.t3/userdata/settings.json changed while setup was working on it, so nothing was written. Close T3 Code and run setup again",
    `+ user settings /home/user/.claude/settings.json: ${dry ? "would add" : "added"} 10`,
  ],
})

describe("the setup interface, wrapping", () => {
  for (const [width, height] of [
    [80, 24],
    [40, 20],
  ] as const) {
    test(`the result at ${width}x${height} wraps the whole cause and every outcome line`, async () => {
      const screen = await shown({
        width,
        height,
        apply: () => Promise.resolve(LONG_APPLIED(false)),
      })
      await screen.keys("end", "enter", "enter", "d")
      const lines = screen.lines()
      expect(lines.join("").includes("…")).toBe(false)
      expect(lines.some((line) => line.startsWith("Lines "))).toBe(false)
      const words = (text: string) => text.split(/\s+/).filter((word) => word !== "")
      const shownText = lines.join(" ")
      for (const line of LONG_APPLIED(false).lines)
        for (const word of words(line)) expect(shownText).toContain(word.slice(0, 12))
      expect(shownText.replace(/\s+/g, " ")).toContain("Close T3 Code and run setup again")
      for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(width)
    })
  }

  test("a path wraps after a separator, never inside a folder name", async () => {
    const screen = await shown({ width: 40, height: 20 })
    const text = screen.lines().join("\n")
    expect(text).toContain("(/Applications/Xcode.app/Contents/")
    expect(text).toContain("Developer).")
  })

  test("a failed result and an apply error name what to do next", async () => {
    const failed = await shown({
      width: 80,
      height: 24,
      apply: () => Promise.reject(new Error("the process was killed")),
    })
    await failed.keys("end", "enter", "enter")
    expect(failed.lines().join(" ").replace(/\s+/g, " ")).toContain("before running setup again")
    failed.destroy()
    const unreadable = await shown({
      width: 80,
      height: 24,
      review: () => Promise.reject(new Error("settings.json is not a JSON object")),
    })
    await unreadable.keys("end", "enter")
    expect(unreadable.lines().join("\n")).toContain("choose Back and review again")
  })

  test("a dry run reads as what would change, not as writes", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      dryRun: true,
      apply: () =>
        Promise.resolve({ ok: true, lines: ["+ t3 settings: would add defaultThreadEnvMode"] }),
    })
    await screen.keys("end", "enter")
    expect(screen.lines().join("\n")).toContain("WOULD CHANGE, NOTHING IS WRITTEN")
    await screen.keys("enter")
    const text = screen.lines().join("\n")
    expect(text).toContain("Dry run finished; nothing was written.")
    expect(text).not.toContain("Setup finished")
  })
})

describe("the setup interface, a review that cannot be read on a small screen", () => {
  const CAUSE = `${"settings.json cannot be read because its text is not a JSON object, ".repeat(6)}ENDMARK`
  const failed = async (width: number, height: number, dryRun = false) => {
    const screen = await shown({
      width,
      height,
      dryRun,
      review: () => Promise.reject(new Error(CAUSE)),
    })
    await screen.keys("end", "enter")
    return screen
  }

  for (const [width, height, dryRun] of [
    [80, 24, false],
    [40, 20, false],
    [40, 20, true],
    [40, 14, false],
    [40, 12, false],
    [30, 16, false],
  ] as const) {
    test(`at ${width}x${height}${dryRun ? " (dry run)" : ""} the recovery hint and both actions stay in view, with a long cause`, async () => {
      const screen = await failed(width, height, dryRun)
      const lines = screen.lines()
      expect(lines.length).toBeLessThanOrEqual(height)
      expect(lines.join(" ").replace(/\s+/g, " ")).toContain(
        "Fix the cause, then choose Back and review again, or choose Cancel and run holyagent setup later.",
      )
      expect(lines.find(ROW("❯"))).toBe("❯ Back")
      expect(lines.filter((line) => line !== "").at(-1)).toBe("  Cancel")
      // Where the cause fits whole there is nothing to scroll.
      expect(lines.join("\n").includes("Lines 1-")).toBe(height < 24)
      for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(width)
    })
  }

  test("the cause scrolls with Page Down and ends in view while the actions stay", async () => {
    const screen = await failed(40, 14)
    expect(screen.lines().join(" ")).not.toContain("ENDMARK")
    for (let page = 0; page < 20; page += 1) await screen.keys("pagedown")
    const lines = screen.lines()
    expect(lines.join(" ")).toContain("ENDMARK")
    expect(lines.join("\n")).toMatch(/PgUp for earlier$/m)
    expect(lines.find(ROW("❯"))).toBe("❯ Back")
    expect(lines.filter((line) => line !== "").at(-1)).toBe("  Cancel")
    await screen.keys("end", "enter")
    expect(screen.lines()).toContain("T3 CODE")
  })

  test("a short cause shows whole, as before, with no scroll line", async () => {
    const screen = await shown({
      width: 40,
      height: 20,
      review: () => Promise.reject(new Error("settings.json is not a JSON object")),
    })
    await screen.keys("end", "enter")
    const text = screen.lines().join("\n")
    expect(text).toContain("settings.json is not a JSON")
    expect(text).not.toContain("Lines 1-")
    expect(text).not.toContain("PgUp")
  })
})

describe("the setup interface, a review longer than the screen", () => {
  const reading = async (width: number, height: number) => {
    const screen = await shown({ width, height })
    await screen.keys("end", "enter")
    const seen = new Set<string>()
    const pages: Array<string> = []
    for (let page = 0; page < 10; page += 1) {
      const text = screen.lines().join("\n")
      pages.push(text)
      for (const line of screen.lines()) seen.add(withoutRail(line))
      await screen.keys("pagedown")
    }
    return { screen, text: [...seen].join("\n"), pages }
  }

  for (const [width, height] of [
    [40, 20],
    [80, 24],
    [120, 40],
  ] as const) {
    test(`at ${width}x${height} every always-applied key can be read, whole`, async () => {
      const { text, pages } = await reading(width, height)
      const flat = text.replace(/^Lines .*$/gm, "").replace(/\s+/g, " ")
      for (const key of [
        "backgroundActivity.schemaVersion",
        "sourceControlWritingStyle.mode",
        "autoResumeLimitedThreads true",
        "snoozeLimitedThreads true",
        "storageCleanup.worktreeOnMerge true",
        "storageCleanup.logsAfterDays 7",
      ])
        expect(flat.replaceAll(" ", "")).toContain(key.replaceAll(" ", ""))
      for (const name of ["Branch naming", "Storage cleanup", "Threads and git", "already set"])
        expect(text).toContain(name)
      for (const page of pages) {
        expect(page).not.toContain("…")
        for (const line of page.split("\n")) expect(cells(line)).toBeLessThanOrEqual(width)
        expect(page).toContain("❯ Apply")
        expect(page.split("\n").length).toBeLessThanOrEqual(height)
      }
    })
  }

  test("the hint line names the scroll keys only when the review scrolls", async () => {
    const tall = await shown({ width: 120, height: 40 })
    await tall.keys("end", "enter")
    expect(tall.lines().join("\n")).not.toContain("PgUp/PgDn")
    tall.destroy()
    const short = await shown({ width: 80, height: 24 })
    await short.keys("end", "enter")
    expect(short.lines()[1]).toContain("PgUp/PgDn scroll")
    expect(short.lines().join("\n")).toMatch(/^Lines 1-\d+ of \d+, PgDn for more$/m)
  })

  test("Page Up stops at the top, Page Down at the end, and focus keys still move the action", async () => {
    const screen = await shown({ width: 40, height: 20 })
    await screen.keys("end", "enter", "pageup")
    expect(screen.lines().join("\n")).toMatch(/^Lines 1-/m)
    await screen.keys("pagedown", "pagedown", "pagedown", "pagedown", "pagedown", "pagedown")
    const end = screen.lines().join("\n")
    expect(end).toMatch(/of (\d+), PgUp for earlier$/m)
    await screen.keys("pageup")
    expect(screen.lines().join("\n")).not.toMatch(/PgUp for earlier/)
    await screen.keys("down")
    expect(screen.lines().find(ROW("❯"))).toBe("❯ Back")
    expect(screen.outcomes).toEqual([])
  })
})

describe("the text helpers", () => {
  test("measure and cut by grapheme cells, never splitting a wide or combined character", () => {
    expect(cells("日本語")).toBe(6)
    expect(clip("日本語テキスト", 7, "…")).toBe("日本語…")
    expect(clip("ééé", 2, "…")).toBe("é…")
    expect(clip("👨‍👩‍👧 family", 4, "…")).toBe("👨‍👩‍👧 …")
    expect(clip("short", 10, "…")).toBe("short")
  })

  test("wrap words and items to the width", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
    expect(wrapItems(["aa", "bb", "cc"], 6, "   ")).toEqual(["aa", "bb", "cc"])
  })

  test("wrap breaks a long path after a separator, keeps a hidden folder whole and hangs later lines", () => {
    expect(wrap("/home/user/.claude/settings.json", 20)).toEqual([
      "/home/user/.claude/",
      "settings.json",
    ])
    expect(wrap("/home/user/.claude/settings.json", 15)).toEqual([
      "/home/user/",
      ".claude/",
      "settings.json",
    ])
    expect(wrap("a.very.long.dotted.key.name", 10)).toEqual([
      "a.very.",
      "long.",
      "dotted.",
      "key.name",
    ])
    expect(wrap("note /Applications/Xcode.app/Contents/Developer ok", 24, 2)).toEqual([
      "note",
      "  /Applications/",
      "  Xcode.app/Contents/",
      "  Developer ok",
    ])
    expect(wrapItems(["aa", "bb", "cc"], 9, " ")).toEqual(["aa bb cc"])
  })
})

describe("the colour policy and the glyph set", () => {
  test("follow holycodex: NO_COLOR and dumb off, FORCE_COLOR on, CI off, else the terminal", () => {
    expect(colorEnabled({}, true)).toBe(true)
    expect(colorEnabled({}, false)).toBe(false)
    expect(colorEnabled({ NO_COLOR: "1" }, true)).toBe(false)
    expect(colorEnabled({ NO_COLOR: "" }, true)).toBe(true)
    expect(colorEnabled({ TERM: "dumb" }, true)).toBe(false)
    expect(colorEnabled({ FORCE_COLOR: "1" }, false)).toBe(true)
    expect(colorEnabled({ FORCE_COLOR: "0" }, false)).toBe(false)
    expect(colorEnabled({ FORCE_COLOR: "1", NO_COLOR: "1" }, true)).toBe(false)
    expect(colorEnabled({ CI: "true" }, true)).toBe(false)
    expect(colorEnabled({ CI: "false" }, true)).toBe(true)
    // The same truthy rule as the CI fallback of the screen: a negative keeps the colour.
    for (const negative of ["", "0", "no", "OFF"])
      expect(colorEnabled({ CI: negative }, true)).toBe(true)
    expect(colorEnabled({ CI: "1" }, true)).toBe(false)
  })

  test("read the locale from LC_ALL, then LC_CTYPE, then LANG", () => {
    expect(unicodeEnabled({})).toBe(true)
    expect(unicodeEnabled({ LANG: "en_US.UTF-8" })).toBe(true)
    expect(unicodeEnabled({ LANG: "C" })).toBe(false)
    expect(unicodeEnabled({ LC_ALL: "C", LANG: "en_US.UTF-8" })).toBe(false)
    expect(unicodeEnabled({ LC_ALL: "en_US.utf8", LANG: "C" })).toBe(true)
    expect(unicodeEnabled({ LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" })).toBe(false)
  })
})

test("the fixture preview offers the device and worktree rows the tests rely on", () => {
  expect(PREVIEW.device).toBeDefined()
  expect(PREVIEW.worktreesAllowed).toBe(true)
})
