import { pathToFileURL } from "node:url"

import { bold, fg, link, t, TextAttributes } from "@opentui/core"

import { plain } from "./text.ts"
import { backgroundFromColorfgbg, BOLD_TONES, lookFor, paletteOf } from "./theme.ts"
import type { TerminalOutput } from "./types.ts"

/**
 * Presents inline output with OpenTUI's styled text and the Solid setup screen's palette. Only text
 * styling and file links are written to the terminal; there is no renderer or input mode.
 */
export const renderTerminalOutput = ({ env, lines }: TerminalOutput): string => {
  const look = lookFor(env, backgroundFromColorfgbg(env))
  const palette = paletteOf(look)
  return lines
    .map(({ text, tone, reportFile }) => {
      const visible = plain(text)
      if (!look.color || visible === "") return visible
      const colored = fg(palette[tone])(visible)
      const chunk = BOLD_TONES.has(tone) ? bold(colored) : colored
      const styled = t`${reportFile === undefined ? chunk : link(pathToFileURL(reportFile).href)(chunk)}`
      return styled.chunks
        .map(({ text, fg, attributes, link }) => {
          if (text === "" || fg === undefined) return text
          const [r, g, b] = fg.toInts()
          const weight = ((attributes ?? 0) & TextAttributes.BOLD) !== 0 ? "1;" : ""
          const colored = `\x1b[${weight}38;2;${r};${g};${b}m${text}\x1b[0m`
          return link === undefined ? colored : `\x1b]8;;${link.url}\x1b\\${colored}\x1b]8;;\x1b\\`
        })
        .join("")
    })
    .join("\n")
}
