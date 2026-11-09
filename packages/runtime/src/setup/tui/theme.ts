/**
 * The Tokyo Night tokens of holycodex's `TERMINAL_THEME` (v0.16.12, `packages/cli/src/help.ts`),
 * which the setup interface shares so the two tools look alike.
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
  hint: "#737aa2",
} as const

/** A name in {@link TERMINAL_THEME}. */
export type Tone = keyof typeof TERMINAL_THEME

/** The tones holycodex draws in bold; every other tone is plain. */
export const BOLD_TONES: ReadonlySet<Tone> = new Set<Tone>(["heading", "focus"])

/** How the interface draws: with colour or without, and with Unicode glyphs or ASCII only. */
export interface Look {
  readonly color: boolean
  readonly unicode: boolean
}

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

/** The look for an environment, on a terminal. */
export const lookFor = (env: Env): Look => ({
  color: colorEnabled(env, true),
  unicode: unicodeEnabled(env),
})

/** The glyphs of holycodex's screens and their ASCII stand-ins for a locale that is not UTF-8. */
export const glyphs = (look: Look) =>
  look.unicode
    ? { focus: "❯", dot: "·", ellipsis: "…", arrows: "↑/↓" }
    : { focus: ">", dot: "-", ellipsis: "...", arrows: "up/down" }
