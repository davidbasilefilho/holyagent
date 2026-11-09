/**
 * The Tokyo Night tokens of holycodex's `TERMINAL_THEME` (v0.16.12, `packages/cli/src/help.ts`),
 * which the setup interface shares so the two tools look alike. Every tone clears 4.5:1 on the
 * Tokyo Night background `#1a1b26` (and on black); `hint` is the one that departs from holycodex
 * (`#737aa2`, 4.10:1) so that the explanations, paths and recovery hints it carries stay readable.
 */
export const TERMINAL_THEME = {
  heading: "#7aa2f7",
  option: "#7dcfff",
  argument: "#a9b1d6",
  focus: "#7dcfff",
  enabled: "#9ece6a",
  disabled: "#a9b1d6",
  success: "#73daca",
  warning: "#e0af68",
  error: "#f7768e",
  hint: "#7e87b2",
} as const

/**
 * The same tones for a light terminal, on Tokyo Night Day's family of hues darkened until each
 * clears 4.5:1 on its background `#e1e2e7` (and so on white). The tone names are those of
 * {@link TERMINAL_THEME}.
 */
export const LIGHT_THEME: Readonly<Record<keyof typeof TERMINAL_THEME, string>> = {
  heading: "#2a5bbd",
  option: "#00647f",
  argument: "#33478a",
  focus: "#00647f",
  enabled: "#3d6228",
  disabled: "#33478a",
  success: "#2a6a5f",
  warning: "#7c5410",
  error: "#b5223f",
  hint: "#565f89",
}

/** A name in {@link TERMINAL_THEME}. */
export type Tone = keyof typeof TERMINAL_THEME

/** The tones holycodex draws in bold; every other tone is plain. */
export const BOLD_TONES: ReadonlySet<Tone> = new Set<Tone>(["heading", "focus"])

/**
 * The terminal's background: the palette to draw on it is {@link LIGHT_THEME} or
 * {@link TERMINAL_THEME}.
 */
export type Background = "dark" | "light"

/** How the interface draws: with colour or without, with Unicode glyphs or ASCII only, and on what. */
export interface Look {
  readonly color: boolean
  readonly unicode: boolean
  readonly background: Background
}

/** The palette for a look's background. */
export const paletteOf = (look: Look): Readonly<Record<Tone, string>> =>
  look.background === "light" ? LIGHT_THEME : TERMINAL_THEME

type Env = Readonly<Record<string, string | undefined>>

const set = (value: string | undefined): value is string => value !== undefined && value !== ""

/**
 * Whether to add colour, by holycodex's policy with the empty-means-unset rule: a non-empty
 * `NO_COLOR` and `TERM=dumb` turn it off; `FORCE_COLOR` (not `0`) turns it on; `CI` (not `false`)
 * turns it off; otherwise it follows whether the output is a terminal. Bold stays whatever this
 * says, as `NO_COLOR` asks only to drop added colour.
 */
export const colorEnabled = (env: Env, tty: boolean): boolean => {
  if (set(env["NO_COLOR"]) || env["TERM"] === "dumb") return false
  if (set(env["FORCE_COLOR"]) && env["FORCE_COLOR"] !== "0") return true
  if (set(env["CI"]) && env["CI"] !== "false") return false
  return tty
}

/**
 * Whether the locale is UTF-8, read from `LC_ALL`, then `LC_CTYPE`, then `LANG` (the first that is
 * set decides). With none set the terminal is assumed to handle UTF-8; a locale such as `C` or
 * `POSIX` is not.
 */
export const unicodeEnabled = (env: Env): boolean => {
  const locale = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]].find(set)
  return locale === undefined || /utf-?8/i.test(locale)
}

/**
 * The background `COLORFGBG` names (`fg;bg` or `fg;default;bg`, as rxvt, Konsole and others set
 * it): ANSI colours 7 and 15 are light, every other number is dark. `undefined` when it is unset or
 * does not end in a colour number, which leaves the question to the terminal.
 */
export const backgroundFromColorfgbg = (env: Env): Background | undefined => {
  const value = env["COLORFGBG"]
  if (!set(value)) return undefined
  const parts = value.split(";")
  const last = parts.at(-1) ?? ""
  if (parts.length < 2 || !/^\d{1,3}$/.test(last)) return undefined
  return last === "7" || last === "15" ? "light" : "dark"
}

/**
 * The look for an environment, on a terminal, on `background` (dark unless it is found to be
 * light).
 */
export const lookFor = (env: Env, background: Background = "dark"): Look => ({
  color: colorEnabled(env, true),
  unicode: unicodeEnabled(env),
  background,
})

/** The glyphs of holycodex's screens and their ASCII stand-ins for a locale that is not UTF-8. */
export const glyphs = (look: Look) =>
  look.unicode
    ? { focus: "❯", dot: "·", ellipsis: "…", arrows: "↑/↓" }
    : { focus: ">", dot: "-", ellipsis: "...", arrows: "up/down" }
