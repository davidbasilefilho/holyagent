import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { MessageRefused } from "./errors.ts"

// A commit belongs to the credential owner and carries no attribution to the agent. Session
// trailers and the "Generated with … Claude Code" footer (alone on its line, after an optional
// emoji or bracket) always go; a Co-authored-by trailer goes only when it names the agent, so
// human co-authors stay.
const SESSION_TRAILER = /^\s*claude-session\s*:/i
const GENERATED_FOOTER = /^\s*(?:[^\p{L}\p{N}\s]\s*)*generated\s+with\b.*\bclaude\s+code\b/iu
const CO_AUTHOR = /^\s*co-authored-by\s*:\s*(.*)$/i
const SESSION_LINK = /https?:\/\/claude\.ai\/\S*/gi

const namesAgent = (coAuthor: string) =>
  /^claude\b/i.test(coAuthor.trim()) || /@(?:[\w-]+\.)*anthropic\.com\b/i.test(coAuthor)

const isAttribution = (line: string) => {
  if (SESSION_TRAILER.test(line) || GENERATED_FOOTER.test(line)) return true
  const coAuthor = CO_AUTHOR.exec(line)
  return coAuthor !== null && namesAgent(coAuthor[1] ?? "")
}

/** Phrases that talk about the user in third person or about the agent process. */
export const DEFAULT_PHRASES: ReadonlyArray<string> = [
  "the user",
  "user asked",
  "as requested",
  "the assistant",
  "this session",
  "subagent",
  "Claude Code",
  "Claude Opus",
  "Claude Sonnet",
  "Claude Haiku",
  "Claude Fable",
]

/**
 * Removes the agent's session trailers, its Co-authored-by trailers, the "Generated with … Claude
 * Code" footer and claude.ai session links.
 */
export const cleanMessage = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !isAttribution(line))
    .flatMap((line) => {
      const stripped = line.replace(SESSION_LINK, "")
      return stripped === line ? [line] : stripped.trim() === "" ? [] : [stripped.trimEnd()]
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

const phraseExpression = (phrase: string) =>
  new RegExp(
    `\\b${phrase
      .trim()
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+")}\\b`,
    "i",
  )

/** The phrases of the check (minus the allowed ones) that the text contains as whole words. */
export const forbiddenPhrases = (text: string, allowed: ReadonlyArray<string> = []) => {
  const skipped = new Set(allowed.map((phrase) => phrase.trim().toLowerCase()))
  return DEFAULT_PHRASES.filter(
    (phrase) => !skipped.has(phrase.toLowerCase()) && phraseExpression(phrase).test(text),
  )
}

/** Cleans the text, then refuses it when it talks about the user or the agent. */
export const checkedText = (
  text: string,
  allowed: ReadonlyArray<string>,
): Effect.Effect<string, MessageRefused> => {
  const cleaned = cleanMessage(text)
  const phrases = forbiddenPhrases(cleaned, allowed)
  return phrases.length > 0 ? Effect.fail(new MessageRefused({ phrases })) : Effect.succeed(cleaned)
}

/** A commit message split into the headline and an optional body. */
export interface Message {
  readonly headline: string
  readonly body?: string
}

/**
 * Checks the parts as one text (see {@link checkedText}); its first line is the headline, the rest
 * the body.
 */
export const prepareMessage = (parts: ReadonlyArray<string>, allowed: ReadonlyArray<string>) =>
  checkedText(parts.join("\n\n"), allowed).pipe(
    Effect.flatMap((text) => {
      const [headline = "", ...rest] = text.split("\n")
      const body = rest.join("\n").trim()
      return headline.trim() === ""
        ? Effect.fail(
            new Usage({
              message: "The message is empty after removing attribution",
              hint: "Give a headline with -m <headline>.",
            }),
          )
        : Effect.succeed({ headline: headline.trim(), ...(body === "" ? {} : { body }) })
    }),
  )
