import { afterEach, describe, expect, test } from "bun:test"

import { cells, clip, clipStart, wrap, wrapItems } from "../src/setup/tui/text.ts"
import { colorEnabled, TERMINAL_THEME, unicodeEnabled } from "../src/setup/tui/theme.ts"
import { mount, type Mounted, PREVIEW, spanListing } from "./setup-tui-harness.ts"

let open: Mounted | undefined
const shown = async (options: Parameters<typeof mount>[0]) => {
  open = await mount(options)
  return open
}
afterEach(() => open?.destroy())

const ROW = (text: string) => (line: string) => line.includes(text)

describe("the setup interface, choose screen", () => {
  test("shows the title, key hint, heading and the three rows with their defaults", async () => {
    const screen = await shown({ width: 80, height: 24 })
    const lines = screen.lines()
    expect(lines[0]).toBe("HolyAgent  ·  setup")
    expect(lines[1]).toBe("↑/↓ focus   Space toggle   Enter review   Esc cancel")
    expect(lines[3]).toBe("T3 CODE")
    expect(lines[4]).toBe("❯ Pi provider               [x] fixed")
    expect(lines[5]).toBe("  Agent device access       [x] enabled")
    expect(lines[6]).toBe("  New threads in worktrees  [x] enabled")
  })

  test("offers no device row where no Xcode or Android SDK was found", async () => {
    const screen = await shown({ width: 80, height: 24, device: undefined })
    const text = screen.lines().join("\n")
    expect(text).toContain("Pi provider")
    expect(text).toContain("New threads in worktrees")
    expect(text).not.toContain("device")
    await screen.keys("down", "down")
    expect(screen.lines().find(ROW("❯"))).toContain("Pi provider")
  })

  test("leaves the worktree row out when the config does not allow the choice", async () => {
    const screen = await shown({ width: 80, height: 24, worktrees: false })
    expect(screen.lines().join("\n")).not.toContain("worktrees")
  })

  test("moves focus with up, down, j and k, wrapping at the ends, and hints at the focused row", async () => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("down")
    expect(screen.lines()[5]).toStartWith("❯ Agent device access")
    expect(screen.lines().join("\n")).toContain("Found: Xcode")
    await screen.keys("j", "j")
    expect(screen.lines()[4]).toStartWith("❯ Pi provider")
    await screen.keys("k")
    expect(screen.lines()[6]).toStartWith("❯ New threads in worktrees")
    await screen.keys("up")
    expect(screen.lines()[5]).toStartWith("❯ Agent device access")
  })

  test("toggles a row with space and leaves the Pi provider row fixed", async () => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys(" ")
    expect(screen.lines()[4]).toBe("❯ Pi provider               [x] fixed")
    await screen.keys("down", " ")
    expect(screen.lines()[5]).toBe("❯ Agent device access       [ ] disabled")
    await screen.keys(" ")
    expect(screen.lines()[5]).toBe("❯ Agent device access       [x] enabled")
    await screen.keys("down", " ")
    expect(screen.lines()[6]).toBe("❯ New threads in worktrees  [ ] disabled")
  })
})

describe("the setup interface, review and apply", () => {
  test("Enter reviews the current choices: what each switch changes and what is always applied", async () => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("down", " ", "enter")
    expect(screen.reviews).toEqual([{ worktrees: true, deviceAccess: false }])
    const text = screen.lines().join("\n")
    expect(text).toContain("REVIEW")
    expect(text).toContain("/home/user/.t3/userdata/settings.json")
    expect(text).toContain("YOUR CHOICES")
    expect(text).toContain("+ Pi provider")
    expect(text).toContain("- Agent device access       off; nothing written")
    expect(text).toContain("ALWAYS APPLIED")
    expect(text).toContain("= Branch naming             already set")
    expect(screen.lines().find(ROW("❯"))).toBe("❯ Apply")
    expect(screen.applies).toEqual([])
  })

  test("confirming applies the choices once and shows the result; closing reports it", async () => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("down", "down", " ", "enter", "enter")
    expect(screen.applies).toEqual([{ worktrees: false, deviceAccess: true }])
    const text = screen.lines().join("\n")
    expect(text).toContain("RESULT")
    expect(text).toContain("Setup finished.")
    expect(text).toContain("+ t3 settings: added defaultThreadEnvMode")
    expect(screen.outcomes).toEqual([])
    await screen.keys("enter")
    expect(screen.outcomes).toEqual([
      {
        _tag: "Applied",
        applied: { ok: true, lines: ["+ t3 settings: added defaultThreadEnvMode"] },
      },
    ])
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
    await screen.keys("enter", "enter")
    const text = screen.lines().join("\n")
    expect(text).toContain("Setup finished with failures; the lines marked ! failed.")
    expect(text).toContain("! t3 settings: /t3/settings.json changed")
    await screen.keys("escape")
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
    await screen.keys("enter", "enter")
    expect(screen.lines().join("\n")).toContain("! setup: the process was killed")
  })

  test("a review that cannot be read offers Back and Cancel only", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      review: () => Promise.reject(new Error("settings.json is not a JSON object")),
    })
    await screen.keys("enter")
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
    await screen.keys("down", " ", "enter")
    expect(screen.lines().join("\n")).toContain("Reading what will change")
    await screen.keys("enter")
    expect(screen.lines()[3]).toBe("T3 CODE")
    expect(screen.lines()[5]).toBe("❯ Agent device access       [ ] disabled")
    release()
    await screen.settle()
    expect(screen.lines()[3]).toBe("T3 CODE")
  })

  test("a dry run says so on the review and the apply action", async () => {
    const screen = await shown({ width: 80, height: 24, dryRun: true })
    await screen.keys("enter")
    expect(screen.lines().join("\n")).toContain("REVIEW (DRY RUN, NOTHING IS WRITTEN)")
    expect(screen.lines().join("\n")).toContain("❯ Apply (dry run)")
  })

  test("the review moves between Apply, Back and Cancel and Cancel cancels", async () => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("enter", "down", "down")
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
      await screen.keys("down", " ", key)
      expect(screen.outcomes).toEqual([{ _tag: "Cancelled" }])
      expect(screen.reviews).toEqual([])
      expect(screen.applies).toEqual([])
    },
  )

  test.each([["escape"], ["ctrl-c"]])("%s on the review cancels and runs no apply", async (key) => {
    const screen = await shown({ width: 80, height: 24 })
    await screen.keys("enter", key)
    expect(screen.outcomes).toEqual([{ _tag: "Cancelled" }])
    expect(screen.applies).toEqual([])
  })

  test("Ctrl-C while applying stops the screen and aborts the apply", async () => {
    const screen = await shown({ width: 80, height: 24, apply: () => new Promise(() => {}) })
    await screen.keys("enter", "enter")
    expect(screen.lines().join("\n")).toContain("APPLYING")
    await screen.keys("escape", "down")
    expect(screen.outcomes).toEqual([])
    expect(screen.signals[0]?.aborted).toBe(false)
    await screen.keys("ctrl-c")
    expect(screen.outcomes).toEqual([{ _tag: "Interrupted" }])
    expect(screen.signals[0]?.aborted).toBe(true)
  })
})

describe("the setup interface, look", () => {
  test("uses the Tokyo Night tokens: heading bold, focus bold, enabled green, hints grey", async () => {
    const screen = await shown({ width: 80, height: 24 })
    const listing = spanListing(screen)
    expect(listing).toContain(`${TERMINAL_THEME.heading} bold "HolyAgent  ·  setup"`)
    expect(listing).toContain(`${TERMINAL_THEME.option} "↑/↓ focus`)
    expect(listing).toContain(`${TERMINAL_THEME.heading} bold "T3 CODE"`)
    expect(listing).toContain(`${TERMINAL_THEME.focus} bold "❯ Pi provider`)
    expect(listing).toContain(`${TERMINAL_THEME.enabled} "[x] enabled"`)
    expect(listing).toContain(`${TERMINAL_THEME.hint} "Pi runs in T3 Code`)
    await screen.keys("down", " ")
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
      height: 24,
      env: { TERM: "xterm-256color", NO_COLOR: "1" },
    })
    await screen.keys("down", " ")
    const listing = spanListing(screen)
    expect(listing).not.toMatch(/#[0-9a-f]{6}/)
    expect(listing).toContain('default bold "HolyAgent  ·  setup"')
    expect(listing).toContain('default bold "❯ Agent device access       [ ] disabled"')
    expect(screen.lines()[5]).toBe("❯ Agent device access       [ ] disabled")
    await screen.keys("enter")
    expect(spanListing(screen)).not.toMatch(/#[0-9a-f]{6}/)
    expect(screen.lines().join("\n")).toContain("+ Pi provider")
  })

  test("a locale that is not UTF-8 gets ASCII glyphs only", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      env: { TERM: "xterm-256color", LANG: "C" },
    })
    await screen.keys("enter")
    for (const line of screen.lines()) expect(line).toMatch(/^[\x20-\x7e]*$/)
    expect(screen.lines()[0]).toBe("HolyAgent  -  setup")
    expect(screen.lines().join("\n")).toContain("> Apply")
  })

  test("at 40 columns no line is cut off, the key hint wraps whole and the focus row fits", async () => {
    const screen = await shown({ width: 40, height: 20 })
    const lines = screen.lines()
    expect(lines[1]).toBe("↑/↓ focus   Space toggle   Enter review")
    expect(lines[2]).toBe("Esc cancel")
    expect(lines[5]).toBe("❯ Pi provider               [x] fixed")
    expect(lines[7]).toBe("  New threads in worktrees  [x] enabled")
    for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(40)
    await screen.keys("enter")
    const review = screen.lines()
    expect(review.length).toBeLessThanOrEqual(20)
    expect(review.join("\n")).toContain("❯ Apply")
    expect(review.join("\n")).toContain("more")
    for (const line of review) expect(cells(line)).toBeLessThanOrEqual(40)
  })

  test("a resize reflows the screen", async () => {
    const screen = await shown({ width: 80, height: 24 })
    expect(screen.lines()[1]).toBe("↑/↓ focus   Space toggle   Enter review   Esc cancel")
    await screen.resize(40, 20)
    expect(screen.lines()[2]).toBe("Esc cancel")
  })

  test("a long result is cut to the height with a count", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `+ line ${index}`)
    const screen = await shown({
      width: 80,
      height: 12,
      apply: () => Promise.resolve({ ok: true, lines }),
    })
    await screen.keys("enter", "enter")
    const text = screen.lines()
    expect(text).toHaveLength(12)
    expect(text.at(-1)).toMatch(/^… \d+ more, printed after you close$/)
  })
})

describe("the text helpers", () => {
  test("measure and cut by grapheme cells, never splitting a wide or combined character", () => {
    expect(cells("日本語")).toBe(6)
    expect(clip("日本語テキスト", 7, "…")).toBe("日本語…")
    expect(clip("ééé", 2, "…")).toBe("é…")
    expect(clip("👨‍👩‍👧 family", 4, "…")).toBe("👨‍👩‍👧 …")
    expect(clip("short", 10, "…")).toBe("short")
    expect(clipStart("/home/user/.t3/userdata/settings.json", 20, "…")).toBe("…rdata/settings.json")
    expect(clipStart("/home/user/日本語/settings.json", 20, "…")).toBe("…本語/settings.json")
  })

  test("wrap words and items to the width", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"])
    expect(wrap("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"])
    expect(wrapItems(["aa", "bb", "cc"], 6, "   ")).toEqual(["aa", "bb", "cc"])
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
