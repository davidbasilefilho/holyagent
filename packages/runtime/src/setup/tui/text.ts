const segmenter = new Intl.Segmenter()

/** How many terminal cells a text takes, counting graphemes, wide characters and emoji. */
export const cells = (text: string): number => Bun.stringWidth(text)

const graphemes = (text: string): ReadonlyArray<string> =>
  Array.from(segmenter.segment(text), (part) => part.segment)

/** The longest prefix of `text`, by grapheme, that takes at most `width` cells. */
const prefix = (text: string, width: number): string => {
  let taken = ""
  for (const grapheme of graphemes(text)) {
    if (cells(taken + grapheme) > width) break
    taken += grapheme
  }
  return taken
}

/**
 * Cuts a text to `width` cells, ending in `ellipsis` when something was cut. Measures by grapheme
 * cells, never bytes or code points, so a wide or combined character is never split.
 */
export const clip = (text: string, width: number, ellipsis: string): string => {
  if (width <= 0) return ""
  if (cells(text) <= width) return text
  const room = width - cells(ellipsis)
  return room <= 0 ? prefix(ellipsis, width) : prefix(text, room) + ellipsis
}

/** Pads a text with spaces on the right to `width` cells. */
export const pad = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - cells(text)))

// A word that is longer than a line is cut after one of these, so a path or a key breaks between
// its parts and not inside one: folder separators first, then the marks inside a name.
const FOLDERS = new Set(["/", "\\"])
const MARKS = new Set([".", "_", "-"])

/**
 * The head of a word longer than `room` cells: up to its last folder separator that fits, else its
 * last mark, else `room` cells.
 */
const head = (word: string, room: number): string => {
  const fits = prefix(word, room)
  let folder = -1
  let mark = -1
  let size = 0
  let before = "/"
  for (const grapheme of graphemes(fits)) {
    size += grapheme.length
    if (FOLDERS.has(grapheme)) folder = size
    // A dot that opens a name (".claude") belongs to it and is not a place to break.
    else if (MARKS.has(grapheme) && !(grapheme === "." && FOLDERS.has(before))) mark = size
    before = grapheme
  }
  // A cut in the first cell or two would leave a head that says nothing.
  const usable = (cut: number) => cut >= 3 || (cut > 0 && cut === fits.length)
  const cut = usable(folder) ? folder : usable(mark) ? mark : -1
  return cut > 0 ? fits.slice(0, cut) : fits
}

/**
 * Breaks a text into lines of at most `width` cells at its spaces. A word that is longer than a
 * line breaks after its last folder separator (`/`) or, without one, its last `.`, `_` or `-` that
 * fits, else at the width. Lines after the first start with `hang` spaces, so a wrapped entry reads
 * as one block.
 */
export const wrap = (text: string, width: number, hang = 0): ReadonlyArray<string> => {
  const lines: Array<string> = []
  let line = ""
  const room = () => Math.max(1, width - (lines.length === 0 ? 0 : hang))
  const flush = () => {
    lines.push(`${lines.length === 0 ? "" : " ".repeat(hang)}${line}`)
    line = ""
  }
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    let rest = word
    while (cells(rest) > room()) {
      if (line !== "") flush()
      const piece = head(rest, room())
      if (piece === "") break
      line = piece
      flush()
      rest = rest.slice(piece.length)
    }
    if (line === "") line = rest
    else if (cells(`${line} ${rest}`) <= room()) line = `${line} ${rest}`
    else {
      flush()
      line = rest
    }
  }
  if (line !== "") flush()
  return lines
}

/** Breaks items into lines of at most `width` cells, never inside an item, joined by `separator`. */
export const wrapItems = (
  items: ReadonlyArray<string>,
  width: number,
  separator: string,
): ReadonlyArray<string> => {
  const lines: Array<string> = []
  let line = ""
  for (const item of items) {
    if (line === "") line = item
    else if (cells(line + separator + item) <= width) line += separator + item
    else {
      lines.push(line)
      line = item
    }
  }
  return line === "" ? lines : [...lines, line]
}
