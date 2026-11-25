import { afterEach, describe, expect, test } from "bun:test"

import { RGBA, TextAttributes } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"

import {
  BACKGROUND_TIMEOUT_MS,
  type BackgroundQuery,
  detectBackground,
} from "../src/setup/tui/background.ts"
import {
  backgroundFromColorfgbg,
  LIGHT_THEME,
  lookFor,
  paletteOf,
  TERMINAL_THEME,
  type Tone,
} from "../src/setup/tui/theme.ts"
import { mount, type Mounted, spanListing } from "./setup-tui-harness.ts"

// The backgrounds the palettes are made for: Tokyo Night's, and Tokyo Night Day's, which white
// only lightens.
const DARK_BACKGROUND = "#1a1b26"
const LIGHT_BACKGROUND = "#e1e2e7"

const channel = (value: number) => {
  const c = value / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16)
  return 0.2126 * channel(n >> 16) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
}
/** The WCAG contrast ratio of two `#rrggbb` colours. */
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const tones = Object.keys(TERMINAL_THEME) as ReadonlyArray<Tone>

describe("the palettes", () => {
  test.each(tones)("the dark %s tone has 4.5:1 on the dark background and on black", (tone) => {
    expect(contrast(TERMINAL_THEME[tone], DARK_BACKGROUND)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(TERMINAL_THEME[tone], "#000000")).toBeGreaterThanOrEqual(4.5)
  })

  test.each(tones)("the light %s tone has 4.5:1 on the light background and on white", (tone) => {
    expect(contrast(LIGHT_THEME[tone], LIGHT_BACKGROUND)).toBeGreaterThanOrEqual(4.5)
    expect(contrast(LIGHT_THEME[tone], "#ffffff")).toBeGreaterThanOrEqual(4.5)
  })

  test("name the same tones", () => {
    expect(Object.keys(LIGHT_THEME).sort()).toEqual([...tones].sort())
  })

  test("keep the hint tone apart from the argument tone", () => {
    for (const theme of [TERMINAL_THEME, LIGHT_THEME]) expect(theme.hint).not.toBe(theme.argument)
  })

  test("are picked by the look's background, dark by default", () => {
    expect(paletteOf(lookFor({}))).toBe(TERMINAL_THEME)
    expect(paletteOf(lookFor({}, "light"))).toBe(LIGHT_THEME)
  })
})

describe("backgroundFromColorfgbg", () => {
  test.each([
    ["0;15", "light"],
    ["0;default;15", "light"],
    ["0;7", "light"],
    ["15;0", "dark"],
    ["15;default;0", "dark"],
    ["12;8", "dark"],
  ] as const)("reads %s as %s", (value, expected) => {
    expect(backgroundFromColorfgbg({ COLORFGBG: value })).toBe(expected)
  })

  test.each([undefined, "", "15", "15;", "15;default", "a;b"])(
    "leaves %p to the terminal",
    (value) => {
      expect(backgroundFromColorfgbg({ COLORFGBG: value })).toBeUndefined()
    },
  )
})

describe("detectBackground", () => {
  const env = { TERM: "xterm-256color" }
  const asks: Array<number> = []
  const query = (answer: () => Promise<"dark" | "light" | null>): BackgroundQuery => ({
    waitForThemeMode: (timeoutMs) => {
      asks.push(timeoutMs)
      return answer()
    },
  })
  afterEach(() => {
    asks.length = 0
  })
  const detect = (
    environment: Readonly<Record<string, string | undefined>>,
    renderer: BackgroundQuery,
    timeoutMs?: number,
  ) => Effect.runPromise(detectBackground(environment, renderer, timeoutMs))

  test("asks the terminal once, for at most the timeout, and takes a light answer", async () => {
    expect(
      await detect(
        env,
        query(() => Promise.resolve("light")),
      ),
    ).toBe("light")
    expect(asks).toEqual([BACKGROUND_TIMEOUT_MS])
  })

  test("takes a dark answer", async () => {
    expect(
      await detect(
        env,
        query(() => Promise.resolve("dark")),
      ),
    ).toBe("dark")
  })

  test("is dark when the terminal does not answer in time", async () => {
    expect(
      await detect(
        env,
        query(() => Promise.resolve(null)),
      ),
    ).toBe("dark")
  })

  test("is dark, within the timeout, when the query never settles", async () => {
    const started = performance.now()
    const found = await detect(
      env,
      query(() => new Promise<never>(() => undefined)),
      40,
    )
    expect(found).toBe("dark")
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("is dark when the query fails", async () => {
    expect(
      await detect(
        env,
        query(() => Promise.reject(new Error("closed"))),
      ),
    ).toBe("dark")
  })

  test("takes COLORFGBG without asking the terminal", async () => {
    const never = query(() => Promise.reject(new Error("must not ask")))
    expect(await detect({ ...env, COLORFGBG: "0;15" }, never)).toBe("light")
    expect(await detect({ ...env, COLORFGBG: "15;0" }, never)).toBe("dark")
    expect(asks).toEqual([])
  })

  test("does not ask where colour is off", async () => {
    expect(
      await detect(
        { ...env, NO_COLOR: "1" },
        query(() => Promise.resolve("light")),
      ),
    ).toBe("dark")
    expect(asks).toEqual([])
  })
})

describe("the setup interface on a light terminal", () => {
  let open: Mounted | undefined
  const shown = async (options: Parameters<typeof mount>[0]) => {
    open = await mount(options)
    return open
  }
  afterEach(() => open?.destroy())

  test.each(["dark", "light"] as const)(
    "the %s tab highlight follows navigation independently of row focus",
    async (background) => {
      const screen = await shown({
        width: 64,
        height: 25,
        background,
        combined: true,
        env: { LANG: "C.UTF-8" },
      })
      const tabs = () => screen.spans().lines[1]?.spans ?? []
      const highlight = RGBA.fromHex(
        background === "light" ? LIGHT_THEME.focus : TERMINAL_THEME.focus,
      )
      const fg = RGBA.fromHex(background === "light" ? LIGHT_BACKGROUND : DARK_BACKGROUND)
      const active = () =>
        tabs().filter(
          (span) =>
            span.bg.r === highlight.r && span.bg.g === highlight.g && span.bg.b === highlight.b,
        )
      expect(screen.lines()[1]).toBe(" Pi   Claude Code   Codex")
      expect(screen.lines()[2]).toBe("←/→ change harness")
      expect(active().map(({ text }) => text.trim())).toEqual(["Pi"])
      expect(active()[0]?.fg.r).toBe(fg.r)
      expect(active()[0]?.fg.g).toBe(fg.g)
      expect(active()[0]?.fg.b).toBe(fg.b)
      await screen.keys("down", "right")
      expect(active().map(({ text }) => text.trim())).toEqual(["Claude Code"])
      expect(screen.lines().join("\n")).toMatch(/❯ Configure Claude Code +\[ \] disabled/)
      await screen.click(22, 1)
      expect(active().map(({ text }) => text.trim())).toEqual(["Codex"])
      expect(screen.lines().join("\n")).toContain(
        "Codex setup is not available in this environment",
      )
    },
  )
  test("no-color ASCII terminals show an underlined active tab and preserve checkbox labels", async () => {
    const screen = await shown({
      width: 64,
      height: 25,
      combined: true,
      env: { LANG: "C", NO_COLOR: "1" },
    })
    expect(screen.lines()[2]).toBe("</> change harness")
    const active = () =>
      screen
        .spans()
        .lines[1]?.spans.find(({ attributes }) => (attributes & TextAttributes.UNDERLINE) !== 0)
    expect(active()?.text.trim()).toBe("Pi")
    expect(screen.lines().join("\n")).toContain("[x] enabled")
    await screen.keys("left")
    expect(active()?.text.trim()).toBe("Codex")
  })

  test("draws in the light palette", async () => {
    const screen = await shown({ width: 80, height: 24, background: "light" })
    const listing = spanListing(screen)
    expect(listing).toContain(`${LIGHT_THEME.heading} bold "HolyAgent  ·  setup"`)
    expect(listing).toContain(`${LIGHT_THEME.option} "↑/↓ or j/k focus`)
    expect(listing).toContain(`${LIGHT_THEME.focus} bold "❯ Agent device access`)
    expect(listing).toContain(`${LIGHT_THEME.hint} "Lets agents use the iOS simulator`)
    for (const dark of Object.values(TERMINAL_THEME))
      if (!Object.values(LIGHT_THEME).includes(dark)) expect(listing).not.toContain(dark)
  })

  test("draws every review and result tone in the light palette", async () => {
    const screen = await shown({ width: 80, height: 24, background: "light" })
    await screen.keys("end", "enter")
    const listing = spanListing(screen)
    const used = new Set(listing.match(/#[0-9a-f]{6}/g))
    expect(used.size).toBeGreaterThan(1)
    for (const color of used) expect(Object.values(LIGHT_THEME)).toContain(color)
  })

  test("keeps the terminal's own foreground under NO_COLOR", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      background: "light",
      env: { TERM: "xterm-256color", NO_COLOR: "1" },
    })
    expect(spanListing(screen)).not.toMatch(/#[0-9a-f]{6}/)
  })

  test("keeps the ASCII glyphs under a C locale", async () => {
    const screen = await shown({
      width: 80,
      height: 24,
      background: "light",
      env: { TERM: "xterm-256color", LANG: "C" },
    })
    const lines = screen.lines()
    expect(lines[0]).toBe("HolyAgent  -  setup")
    expect(lines.join("\n")).not.toMatch(/[^\x20-\x7e\n]/)
    expect(spanListing(screen)).toContain(`${LIGHT_THEME.focus} bold "> Agent device access`)
  })
})

describe("showSetup on a terminal that is silent about its background", () => {
  test("shows the screen in the dark palette once the wait is over", async () => {
    const { showSetup } = await import("../src/setup/tui/entry.tsx")
    const { renderer, captureCharFrame, renderOnce } = await createTestRenderer({
      width: 80,
      height: 24,
      exitOnCtrlC: false,
    })
    const input = {
      env: { TERM: "xterm-256color" },
      offer: { t3: true, device: undefined, worktrees: true, capabilities: [], form: "normal" },
      initial: { worktrees: true, deviceAccess: false, capabilities: {} },
      dryRun: false,
      review: () => Promise.reject(new Error("unused")),
      apply: () => new Promise<never>(() => undefined),
    }
    const run = Effect.runPromise(showSetup(Effect.succeed(renderer), input))
    await Bun.sleep(BACKGROUND_TIMEOUT_MS + 250)
    await renderOnce()
    expect(captureCharFrame()).toContain("HolyAgent  ·  setup")
    renderer.destroy()
    expect(await run).toEqual({ _tag: "Interrupted" })
  })
})
