import { Effect } from "effect"

import { Usage } from "../api/usage.ts"
import { MessageRefused } from "./errors.ts"
import { looksLikeAgent } from "./identity.ts"

// A commit belongs to the credential owner and carries no attribution to the agent. Session
// trailers and the "Generated with … Claude Code" footer (alone on its line, after an optional
// emoji or bracket) always go; a Co-authored-by trailer goes only when it names the agent, so
// human co-authors stay.
//
// Pi adds no commit text of its own: the installed @earendil-works/pi-coding-agent 1.5.0 and the
// packages under it hold no Co-authored-by, "Generated with" or trailer string, and its system
// prompt says nothing about git. Its attribution is the name `pi` and the address https://pi.dev
// (`PI_ATTRIBUTION` in @earendil-works/pi-ai, dist/utils/identity.js), and its /share command links
// the session viewer https://pi.dev/session/#<gist> (`getShareViewerUrl` in pi-coding-agent,
// dist/config.js). A model running in pi copies those forms, so the cleaner also removes the footer
// "Generated with [pi](https://pi.dev)", a Co-authored-by trailer for an address at pi.dev or for
// "Pi Coding Agent" under any address, and pi.dev session links. A bare "Pi" is a name a person can
// have, so it goes only with a pi.dev address.
//
// Links stop at whitespace and at ')', so a link closing a Markdown "[text](url)" leaves its
// parenthesis, and the footer pattern cannot backtrack across a run of them.
const SESSION_TRAILER = /^\s*claude-session\s*:/i
const GENERATED_FOOTER = /^\s*(?:[^\p{L}\p{N}\s]\s*)*generated\s+with\b.*\bclaude\s+code\b/iu
const PI_GENERATED_FOOTER =
  /^\s*(?:[^\p{L}\p{N}\s]\s*)*generated\s+with\s+\[?pi(?:[\s-]coding[\s-]agent)?\]?(?:\([^\s)]*\))?[^\p{L}\p{N}]*$/iu
const CO_AUTHOR = /^\s*co-authored-by\s*:\s*(.*)$/i
const SESSION_LINK = /https?:\/\/claude\.ai\/[^\s)]*/gi
const PI_SESSION_LINK = /https?:\/\/(?:[\w-]+\.)*pi\.dev\/session\/[^\s)]*/gi
const PI_AGENT_NAME = /^pi[\s-]coding[\s-]agent$/i

const namesAgent = (coAuthor: string) =>
  looksLikeAgent({ name: coAuthor.replace(/<.*$/, ""), email: "" }) ||
  /@(?:[\w-]+\.)*(?:anthropic\.com|pi\.dev)\b/i.test(coAuthor) ||
  PI_AGENT_NAME.test(coAuthor.replace(/<.*$/, "").replace(/\s+/g, " ").trim())

const isAttribution = (line: string) => {
  if (SESSION_TRAILER.test(line) || GENERATED_FOOTER.test(line) || PI_GENERATED_FOOTER.test(line))
    return true
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
 * Code" footer and claude.ai session links, and pi's forms of them (see the notes above).
 */
export const cleanMessage = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !isAttribution(line))
    .flatMap((line) => {
      const stripped = line.replace(SESSION_LINK, "").replace(PI_SESSION_LINK, "")
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
