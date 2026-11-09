import { cells, clip, pad, wrap, wrapItems } from "./text.ts"
import { glyphs, type Look, type Tone } from "./theme.ts"
import type { Applied, Choices, Offer, Review, ReviewLine } from "./types.ts"

/** One run of text in one tone; the screen draws it as a span. */
export interface Segment {
  readonly text: string
  readonly tone?: Tone
}

/** One screen line. */
export type Line = ReadonlyArray<Segment>

/** A row of the choose screen. */
export type RowId = "pi" | "deviceAccess" | "worktrees"

/** The screens, in the order a run goes through them. */
export type Screen = "choose" | "review" | "applying" | "done"

/** What the screens show and the keys change; every transition below is a pure function of it. */
export interface State {
  readonly screen: Screen
  /** The focused row of the choose screen, an index into the rows. */
  readonly focus: number
  /** The focused action of the review screen, an index into {@link reviewActions}. */
  readonly action: number
  /** The first line shown of a review or result longer than the screen; `view` clamps it. */
  readonly scroll: number
  readonly choices: Choices
  /** The review for the current choices; `undefined` while it is being read. */
  readonly review: Review | undefined
  /** Why the review could not be read. */
  readonly failure: string | undefined
  readonly applied: Applied | undefined
}

/** What a key asks the screen to do beside changing the state. */
export type Command = "review" | "apply" | "cancel" | "interrupt" | "close"

/** How far a long review or result scrolls: the lines one page moves and the last first line. */
export interface Scroll {
  readonly page: number
  readonly max: number
}

/** A key press, reduced to what the screens read. */
export interface Key {
  readonly name: string
  readonly ctrl: boolean
}

/** An action of the review screen. */
export type ReviewAction = "apply" | "back" | "cancel"

const LABELS: Readonly<Record<RowId, string>> = {
  pi: "Pi provider",
  deviceAccess: "Agent device access",
  worktrees: "New threads in worktrees",
}

/** The rows the machine allows: the Pi provider, the device row only with a host, worktrees. */
export const rowsOf = (offer: Offer): ReadonlyArray<RowId> => [
  "pi",
  ...(offer.device === undefined ? [] : (["deviceAccess"] as const)),
  ...(offer.worktrees ? (["worktrees"] as const) : []),
]

/** The state a run starts in. */
export const initialState = (choices: Choices): State => ({
  screen: "choose",
  focus: 0,
  action: 0,
  scroll: 0,
  choices,
  review: undefined,
  failure: undefined,
  applied: undefined,
})

/** The actions the review screen offers: Apply only once the review was read. */
export const reviewActions = (state: State): ReadonlyArray<ReviewAction> =>
  state.review === undefined ? ["back", "cancel"] : ["apply", "back", "cancel"]

const isCancel = (key: Key) => key.name === "escape" || (key.ctrl && key.name === "c")
const isQuit = (key: Key) => isCancel(key) || (!key.ctrl && key.name === "q")
const isEnter = (key: Key) => key.name === "return" || key.name === "enter"
const stepOf = (key: Key): -1 | 1 | 0 =>
  key.ctrl
    ? 0
    : key.name === "up" || key.name === "k"
      ? -1
      : key.name === "down" || key.name === "j"
        ? 1
        : 0

const wrapped = (index: number, step: number, length: number) =>
  (((index + step) % length) + length) % length

const toggled = (choices: Choices, row: RowId): Choices =>
  row === "deviceAccess"
    ? { ...choices, deviceAccess: !choices.deviceAccess }
    : row === "worktrees"
      ? { ...choices, worktrees: !choices.worktrees }
      : choices

const pagedBy = (state: State, key: Key, scroll: Scroll): State | undefined => {
  if (key.ctrl) return undefined
  const direction = key.name === "pagedown" ? 1 : key.name === "pageup" ? -1 : 0
  if (direction === 0) return undefined
  const from = Math.min(state.scroll, scroll.max)
  return { ...state, scroll: Math.min(scroll.max, Math.max(0, from + direction * scroll.page)) }
}

/**
 * The state after a key, and the command the key asks for, if any. `scroll` (from {@link scrollOf})
 * bounds Page Up and Page Down on a review or result longer than the screen.
 */
export const press = (
  state: State,
  rows: ReadonlyArray<RowId>,
  key: Key,
  scroll: Scroll = { page: 1, max: 0 },
): { readonly state: State; readonly command?: Command } => {
  if (state.screen === "choose") {
    if (isQuit(key)) return { state, command: "cancel" }
    const step = stepOf(key)
    if (step !== 0) return { state: { ...state, focus: wrapped(state.focus, step, rows.length) } }
    if (!key.ctrl && key.name === "space") {
      const row = rows[state.focus]
      return row === undefined
        ? { state }
        : { state: { ...state, choices: toggled(state.choices, row) } }
    }
    if (isEnter(key))
      return {
        state: {
          ...state,
          screen: "review",
          action: 0,
          scroll: 0,
          review: undefined,
          failure: undefined,
        },
        command: "review",
      }
    return { state }
  }
  if (state.screen === "review") {
    if (isQuit(key)) return { state, command: "cancel" }
    const paged = pagedBy(state, key, scroll)
    if (paged !== undefined) return { state: paged }
    const actions = reviewActions(state)
    const step = stepOf(key)
    if (step !== 0)
      return { state: { ...state, action: wrapped(state.action, step, actions.length) } }
    if (isEnter(key)) {
      const action = actions[state.action]
      if (action === "apply") return { state: { ...state, screen: "applying" }, command: "apply" }
      if (action === "back")
        return {
          state: { ...state, screen: "choose", scroll: 0, review: undefined, failure: undefined },
        }
      return { state, command: "cancel" }
    }
    return { state }
  }
  if (state.screen === "applying")
    return key.ctrl && key.name === "c" ? { state, command: "interrupt" } : { state }
  const paged = pagedBy(state, key, scroll)
  if (paged !== undefined) return { state: paged }
  return isQuit(key) || isEnter(key) || key.name === "space"
    ? { state, command: "close" }
    : { state }
}

/** The state once the review of the current choices was read. */
export const reviewed = (state: State, review: Review): State =>
  state.screen === "review" ? { ...state, review, failure: undefined, action: 0, scroll: 0 } : state

/** The state once the review could not be read: the screen offers Back and Cancel only. */
export const reviewFailed = (state: State, failure: string): State =>
  state.screen === "review" ? { ...state, review: undefined, failure, action: 0, scroll: 0 } : state

/** The state once the apply finished. */
export const finished = (state: State, applied: Applied): State => ({
  ...state,
  screen: "done",
  scroll: 0,
  applied,
})

/** What the screen draws in: the rows, the facts the text names, and the room there is. */
export interface Context {
  readonly rows: ReadonlyArray<RowId>
  readonly offer: Offer
  readonly dryRun: boolean
  readonly width: number
  readonly height: number
  readonly look: Look
}

const KEY_GAP = "   "

const segment = (text: string, tone?: Tone): Segment =>
  tone === undefined ? { text } : { text, tone }

const title = (look: Look): Line => [segment(`HolyAgent  ${glyphs(look).dot}  setup`, "heading")]

const keyLines = (items: ReadonlyArray<string>, width: number): ReadonlyArray<Line> =>
  wrapItems(items, width, KEY_GAP).map((text) => [segment(text, "option")])

const heading = (text: string, width: number): ReadonlyArray<Line> =>
  wrap(text.toUpperCase(), width).map((part) => [segment(part, "heading")])

const blank: Line = []

const hintLines = (text: string, width: number): ReadonlyArray<Line> =>
  wrap(text, width).map((part) => [segment(part, "hint")])

const hintOf = (row: RowId, offer: Offer): string =>
  row === "pi"
    ? "Pi runs in T3 Code as its own provider; it stays on while pi.enable is true, so there is nothing to choose."
    : row === "deviceAccess"
      ? `Lets agents use the iOS simulator or an Android emulator. Found: ${offer.device ?? "no device host"}.`
      : "New T3 Code threads start in their own git worktree instead of the local checkout."

const checkbox = (row: RowId, choices: Choices): { box: string; word: string } =>
  row === "pi"
    ? { box: "[x]", word: "fixed" }
    : (row === "deviceAccess" ? choices.deviceAccess : choices.worktrees)
      ? { box: "[x]", word: "enabled" }
      : { box: "[ ]", word: "disabled" }

/** The lines of a screen, and how far it scrolls. */
interface Layout {
  readonly lines: ReadonlyArray<Line>
  readonly scroll: Scroll
}

const FIXED: Scroll = { page: 1, max: 0 }

const chooseLines = (state: State, context: Context): ReadonlyArray<Line> => {
  const { rows, offer, width, look } = context
  const g = glyphs(look)
  const values = rows.map((row) => {
    const { box, word } = checkbox(row, state.choices)
    return `${box} ${word}`
  })
  const valueWidth = Math.max(...values.map(cells))
  const labelWidth = Math.min(
    Math.max(...rows.map((row) => cells(LABELS[row]))),
    Math.max(4, width - 2 - 2 - valueWidth),
  )
  const body = rows.map((row, index): Line => {
    const focused = index === state.focus
    const label = pad(clip(LABELS[row], labelWidth, g.ellipsis), labelWidth)
    const value = values[index] ?? ""
    if (focused) return [segment(`${g.focus} ${label}  ${value}`, "focus")]
    return [
      segment(`  ${label}  `, "argument"),
      segment(
        value,
        row === "pi" ||
          !(row === "deviceAccess" ? state.choices.deviceAccess : state.choices.worktrees)
          ? "disabled"
          : "enabled",
      ),
    ]
  })
  const focused = rows[state.focus]
  return [
    ...keyLines([`${g.arrows} or j/k focus`, "Space toggle", "Enter review", "Esc cancel"], width),
    blank,
    ...heading("T3 Code", width),
    ...body,
    blank,
    ...(focused === undefined ? [] : hintLines(hintOf(focused, offer), width)),
  ]
}

const MARK_TONES: Readonly<Record<ReviewLine["mark"], Tone>> = {
  "+": "success",
  "=": "hint",
  "~": "warning",
  "-": "hint",
}

/** The least room a detail needs beside its name; narrower, it goes on its own lines below. */
const MIN_DETAIL = 24

/** One review entry as lines: name and detail side by side, or the detail stacked under the name. */
const reviewEntry = (line: ReviewLine, nameWidth: number, width: number): ReadonlyArray<Line> => {
  const mark = segment(`  ${line.mark} `, MARK_TONES[line.mark])
  const side = cells(mark.text) + nameWidth + 2
  const room = width - side
  if (room < MIN_DETAIL)
    return [
      [mark, segment(line.name, "argument")],
      ...wrap(line.detail, width - 4).map((part): Line => [segment(`    ${part}`, "hint")]),
    ]
  const parts = wrap(line.detail, room)
  return (parts.length === 0 ? [""] : parts).map((part, index): Line =>
    index === 0
      ? [
          mark,
          segment(pad(line.name, nameWidth), "argument"),
          ...(part === "" ? [] : [segment(`  ${part}`, "hint")]),
        ]
      : [segment(`${" ".repeat(side)}${part}`, "hint")],
  )
}

interface Page {
  readonly shown: ReadonlyArray<Line>
  /** The line saying which lines are shown; `undefined` when everything fits. */
  readonly indicator: Line | undefined
  readonly scroll: Scroll
}

/**
 * The part of `body` that fits `room` lines from line `from` on. When it does not all fit, `room`
 * loses one line to an indicator saying which lines are shown and which keys scroll.
 */
const pageOf = (body: ReadonlyArray<Line>, room: number, from: number): Page => {
  if (body.length <= room) return { shown: body, indicator: undefined, scroll: FIXED }
  const size = Math.max(1, room - 1)
  const max = body.length - size
  const start = Math.min(Math.max(0, from), max)
  const end = start + size
  const more =
    start === 0 ? "PgDn for more" : end === body.length ? "PgUp for earlier" : "PgUp/PgDn"
  return {
    shown: body.slice(start, end),
    indicator: [segment(`Lines ${start + 1}-${end} of ${body.length}, ${more}`, "hint")],
    scroll: { page: Math.max(1, size - 1), max },
  }
}

const REVIEW_RECOVERY =
  "Fix the cause, then choose Back and review again, or choose Cancel and run holyagent setup later."

const reviewLayout = (state: State, context: Context): Layout => {
  const { width, look } = context
  const g = glyphs(look)
  const heading_ = heading(
    context.dryRun ? "Review (dry run: would change, nothing is written)" : "Review",
    width,
  )
  const actionLines = (): ReadonlyArray<Line> =>
    reviewActions(state).map((action, index): Line => {
      const text =
        action === "apply"
          ? context.dryRun
            ? "Apply (dry run)"
            : "Apply"
          : action === "back"
            ? "Back"
            : "Cancel"
      if (index === state.action) return [segment(`${g.focus} ${text}`, "focus")]
      const tone: Tone = action === "apply" ? "enabled" : action === "cancel" ? "error" : "argument"
      return [segment(`  ${text}`, tone)]
    })
  const keys = (scrolling: boolean) =>
    keyLines(
      [
        `${g.arrows} or j/k focus`,
        ...(scrolling ? ["PgUp/PgDn scroll"] : []),
        "Enter select",
        "Esc cancel",
      ],
      width,
    )
  if (state.failure !== undefined) {
    const cause = wrap(state.failure, width - 2).map((part): Line => [
      segment(`  ${part}`, "error"),
    ])
    const recovery = hintLines(REVIEW_RECOVERY, width)
    const actions = actionLines()
    // The recovery hint and the actions are what the person needs, so they always show; the cause
    // takes the lines left and scrolls when it is longer.
    const build = (spaced: boolean) => {
      const gap: ReadonlyArray<Line> = spaced ? [blank] : []
      const layout = (scrolling: boolean) => {
        const top = [...keys(scrolling), ...gap, ...heading_]
        const bottom = [...gap, ...recovery, ...gap, ...actions]
        const page = pageOf(cause, context.height - 1 - top.length - bottom.length, state.scroll)
        return {
          lines: [
            ...top,
            ...page.shown,
            ...(page.indicator === undefined ? [] : [page.indicator]),
            ...bottom,
          ],
          scroll: page.scroll,
          fits: page.indicator === undefined,
          shown: page.shown.length,
        }
      }
      const plain = layout(false)
      return plain.fits ? plain : layout(true)
    }
    // The blank separators go first when the screen is too short to leave the cause three lines.
    const spaced = build(true)
    const chosen = spaced.shown >= Math.min(3, cause.length) ? spaced : build(false)
    return { lines: chosen.lines, scroll: chosen.scroll }
  }
  if (state.review === undefined) {
    return {
      lines: [
        ...keys(false),
        blank,
        ...heading_,
        [segment("  Reading what will change", "hint")],
        blank,
        ...actionLines(),
      ],
      scroll: FIXED,
    }
  }
  const { review } = state
  const nameWidth = Math.max(
    ...[...review.choices, ...review.always].map((line) => cells(line.name)),
  )
  const entries = (lines: ReadonlyArray<ReviewLine>) =>
    lines.flatMap((line) => reviewEntry(line, nameWidth, width))
  const body: ReadonlyArray<Line> = [
    ...wrap(review.file, width - 2).map((part): Line => [segment(`  ${part}`, "hint")]),
    blank,
    ...heading("Your choices", width),
    ...entries(review.choices),
    blank,
    ...heading("Always applied", width),
    ...entries(review.always),
  ]
  const actions = actionLines()
  // The title takes one line, and the line above the actions holds the scroll indicator, if any.
  const build = (scrolling: boolean): Layout & { readonly fits: boolean } => {
    const top = [...keys(scrolling), blank, ...heading_]
    const room = context.height - 1 - top.length - 1 - actions.length
    const page = pageOf(body, room, state.scroll)
    return {
      lines: [...top, ...page.shown, page.indicator ?? blank, ...actions],
      scroll: page.scroll,
      fits: page.indicator === undefined,
    }
  }
  const plain = build(false)
  return plain.fits ? plain : build(true)
}

const reportTone = (line: string): Tone =>
  line.startsWith("+ ")
    ? "success"
    : line.startsWith("! ")
      ? "error"
      : line.startsWith("~ ")
        ? "warning"
        : "hint"

const doneHeadline = (ok: boolean, dryRun: boolean): string =>
  ok
    ? dryRun
      ? "Dry run finished; nothing was written."
      : "Setup finished."
    : dryRun
      ? "Dry run finished with failures; the lines marked ! failed. Fix the cause, then run the dry run again."
      : "Setup finished with failures; the lines marked ! failed. Fix the cause, then run holyagent setup again."

const doneLayout = (state: State, context: Context): Layout => {
  const { width, height } = context
  const applied = state.applied
  const ok = applied?.ok !== false
  const body = (applied?.lines ?? []).flatMap((line) =>
    wrap(line, width, 2).map((part): Line => [segment(part, reportTone(line))]),
  )
  const build = (scrolling: boolean): Layout & { readonly fits: boolean } => {
    const top: ReadonlyArray<Line> = [
      ...keyLines(["Enter close", ...(scrolling ? ["PgUp/PgDn scroll"] : [])], width),
      blank,
      ...heading(context.dryRun ? "Result (dry run)" : "Result", width),
      ...wrap(doneHeadline(ok, context.dryRun), width).map((part): Line => [
        segment(part, ok ? "success" : "error"),
      ]),
      blank,
    ]
    const page = pageOf(body, height - 1 - top.length, state.scroll)
    return {
      lines: [...top, ...page.shown, ...(page.indicator === undefined ? [] : [page.indicator])],
      scroll: page.scroll,
      fits: page.indicator === undefined,
    }
  }
  const plain = build(false)
  return plain.fits ? plain : build(true)
}

/** Cuts a line to `width` cells, segment by segment, ending in `ellipsis` when it was cut. */
const fitLine = (line: Line, width: number, ellipsis: string): Line => {
  const total = line.reduce((sum, { text }) => sum + cells(text), 0)
  if (total <= width) return line
  const kept: Array<Segment> = []
  let used = 0
  for (const part of line) {
    const room = width - used
    if (room <= 0) break
    const size = cells(part.text)
    if (size <= room) {
      kept.push(part)
      used += size
      continue
    }
    kept.push({ ...part, text: clip(part.text, room, ellipsis) })
    break
  }
  return kept
}

const layoutOf = (state: State, context: Context): Layout =>
  state.screen === "choose"
    ? { lines: chooseLines(state, context), scroll: FIXED }
    : state.screen === "review"
      ? reviewLayout(state, context)
      : state.screen === "applying"
        ? {
            lines: [
              [segment("Press Ctrl-C to stop", "option")],
              blank,
              ...heading("Applying", context.width),
              [segment("Applying setup; this can take a moment.", "argument")],
            ],
            scroll: FIXED,
          }
        : doneLayout(state, context)

/** How far the screen the state is on scrolls, for {@link press}. */
export const scrollOf = (state: State, context: Context): Scroll => layoutOf(state, context).scroll

/** The lines of the screen the state is on, every one cut to the width. */
export const view = (state: State, context: Context): ReadonlyArray<Line> =>
  [title(context.look), ...layoutOf(state, context).lines].map((line) =>
    fitLine(line, context.width, glyphs(context.look).ellipsis),
  )
