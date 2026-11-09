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

/**
 * Cuts the front of a text to `width` cells, keeping its end behind `ellipsis`: a path stays
 * readable by its last folders.
 */
export const clipStart = (text: string, width: number, ellipsis: string): string => {
  if (width <= 0) return ""
  if (cells(text) <= width) return text
  const room = width - cells(ellipsis)
  if (room <= 0) return prefix(ellipsis, width)
  let kept = ""
  for (const grapheme of graphemes(text).toReversed()) {
    if (cells(grapheme + kept) > room) break
    kept = grapheme + kept
  }
  return ellipsis + kept
}

/** Pads a text with spaces on the right to `width` cells. */
export const pad = (text: string, width: number): string =>
  text + " ".repeat(Math.max(0, width - cells(text)))

/** Breaks a text into lines of at most `width` cells at its spaces, cutting a word that is longer. */
export const wrap = (text: string, width: number): ReadonlyArray<string> => {
  const room = Math.max(1, width)
  const lines: Array<string> = []
  let line = ""
  for (const word of text.split(/\s+/).filter((part) => part !== "")) {
    let rest = word
    while (cells(rest) > room) {
      if (line !== "") {
        lines.push(line)
        line = ""
      }
      const head = prefix(rest, room)
      if (head === "") break
      lines.push(head)
      rest = rest.slice(head.length)
    }
    if (line === "") line = rest
    else if (cells(`${line} ${rest}`) <= room) line = `${line} ${rest}`
    else {
      lines.push(line)
      line = rest
    }
  }
  return line === "" ? lines : [...lines, line]
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
