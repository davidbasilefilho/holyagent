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

describe("the setup interface, choose screen", () => {
  test("shows the title, key hint, heading and the three rows with their defaults", async () => {
    const screen = await shown({ width: 80, height: 24 })
    const lines = screen.lines()
    expect(lines[0]).toBe("HolyAgent  ·  setup")
    expect(lines[1]).toBe("↑/↓ or j/k focus   Space toggle   Enter review   Esc cancel")
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
    const screen = await shown({ width: 80, height: 40 })
    await screen.keys("down", " ", "enter")
    expect(screen.reviews).toEqual([{ worktrees: true, deviceAccess: false, capabilities: {} }])
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
    expect(screen.applies).toEqual([{ worktrees: false, deviceAccess: true, capabilities: {} }])
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
    expect(screen.lines().join("\n")).toContain(
      "REVIEW (DRY RUN: WOULD CHANGE, NOTHING IS WRITTEN)",
    )
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
    expect(listing).toContain(`${TERMINAL_THEME.option} "↑/↓ or j/k focus`)
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
    // Two rows taller than a plain terminal: the review lists one line per capability, and the Pi
    // provider line has to stay inside the page after the eleventh.
    const screen = await shown({
      width: 80,
      height: 26,
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
    expect(lines[1]).toBe("↑/↓ or j/k focus   Space toggle")
    expect(lines[2]).toBe("Enter review   Esc cancel")
    expect(lines[5]).toBe("❯ Pi provider               [x] fixed")
    expect(lines[7]).toBe("  New threads in worktrees  [x] enabled")
    for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(40)
    await screen.keys("enter")
    const review = screen.lines()
    expect(review.length).toBeLessThanOrEqual(20)
    expect(review.join("\n")).toContain("❯ Apply")
    expect(review.join("\n")).toContain("PgDn for more")
    for (const line of review) expect(cells(line)).toBeLessThanOrEqual(40)
  })

  test("a resize reflows the screen", async () => {
    const screen = await shown({ width: 80, height: 24 })
    expect(screen.lines()[1]).toBe("↑/↓ or j/k focus   Space toggle   Enter review   Esc cancel")
    await screen.resize(40, 20)
    expect(screen.lines()[2]).toBe("Enter review   Esc cancel")
  })

  test("a long result scrolls with Page Down and every line can be read", async () => {
    const lines = Array.from({ length: 30 }, (_, index) => `+ line ${index}`)
    const screen = await shown({
      width: 80,
      height: 12,
      apply: () => Promise.resolve({ ok: true, lines }),
    })
    await screen.keys("enter", "enter")
    expect(screen.lines()).toHaveLength(12)
    expect(screen.lines().at(-1)).toBe("Lines 1-5 of 30, PgDn for more")
    const seen = new Set<string>()
    for (let page = 0; page < 8; page += 1) {
      for (const line of screen.lines()) seen.add(line)
      await screen.keys("pagedown")
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
      await screen.keys("enter", "enter")
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
    await screen.keys("down")
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
    await failed.keys("enter", "enter")
    expect(failed.lines().join(" ").replace(/\s+/g, " ")).toContain(
      "then run holyagent setup again",
    )
    failed.destroy()
    const unreadable = await shown({
      width: 80,
      height: 24,
      review: () => Promise.reject(new Error("settings.json is not a JSON object")),
    })
    await unreadable.keys("enter")
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
    await screen.keys("enter")
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
    await screen.keys("enter")
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
    await screen.keys("enter")
    expect(screen.lines()).toContain("T3 CODE")
  })

  test("a short cause shows whole, as before, with no scroll line", async () => {
    const screen = await shown({
      width: 40,
      height: 20,
      review: () => Promise.reject(new Error("settings.json is not a JSON object")),
    })
    await screen.keys("enter")
    const text = screen.lines().join("\n")
    expect(text).toContain("settings.json is not a JSON")
    expect(text).not.toContain("Lines 1-")
    expect(text).not.toContain("PgUp")
  })
})

describe("the setup interface, a review longer than the screen", () => {
  const reading = async (width: number, height: number) => {
    const screen = await shown({ width, height })
    await screen.keys("enter")
    const seen = new Set<string>()
    const pages: Array<string> = []
    for (let page = 0; page < 10; page += 1) {
      const text = screen.lines().join("\n")
      pages.push(text)
      for (const line of screen.lines()) seen.add(line)
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
      const flat = text.replace(/\s+/g, " ")
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
    await tall.keys("enter")
    expect(tall.lines().join("\n")).not.toContain("PgUp/PgDn")
    tall.destroy()
    const short = await shown({ width: 80, height: 24 })
    await short.keys("enter")
    expect(short.lines()[1]).toContain("PgUp/PgDn scroll")
    expect(short.lines().join("\n")).toMatch(/^Lines 1-\d+ of \d+, PgDn for more$/m)
  })

  test("Page Up stops at the top, Page Down at the end, and focus keys still move the action", async () => {
    const screen = await shown({ width: 40, height: 20 })
    await screen.keys("enter", "pageup")
    expect(screen.lines().join("\n")).toMatch(/^Lines 1-/m)
    await screen.keys("pagedown", "pagedown", "pagedown", "pagedown", "pagedown")
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
