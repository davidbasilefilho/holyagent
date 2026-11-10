import { Schema } from "effect"

import { MANUAL_APPROVAL_PREFIX } from "./assessment.ts"

/** Codex's cap on the user and assistant entries together, in tokens. */
export const MAX_MESSAGE_TRANSCRIPT_TOKENS = 10_000
/** Codex's cap on the tool call and result entries together, in tokens. */
export const MAX_TOOL_TRANSCRIPT_TOKENS = 10_000
/** Codex's cap on one user or assistant entry, in tokens. */
export const MAX_MESSAGE_ENTRY_TOKENS = 2_000
/** Codex's cap on one tool entry, in tokens. */
export const MAX_TOOL_ENTRY_TOKENS = 1_000
/** Codex's cap on one string of the action, in tokens. */
export const MAX_ACTION_STRING_TOKENS = 16_000
/** How many of the most recent non-user entries Codex keeps at most. */
export const RECENT_ENTRY_LIMIT = 40

/** One retained entry of the history the reviewer reads. */
export interface TranscriptEntry {
  /** Who it comes from: `user`, `assistant`, `developer` or a tool (`tool <name> call`/`result`). */
  readonly role: string
  readonly kind: "user" | "assistant" | "developer" | "tool"
  readonly text: string
}

const ENCODER = new TextEncoder()

const byteLength = (text: string): number => ENCODER.encode(text).length

/** Codex's token estimate: four bytes to the token, rounded up. */
export const approxTokens = (text: string): number => Math.ceil(byteLength(text) / 4)

// The longest prefix of the text that fits in `bytes`, cut between characters.
const prefixWithin = (text: string, bytes: number): string => {
  let used = 0
  let end = 0
  for (const char of text) {
    used += byteLength(char)
    if (used > bytes) break
    end += char.length
  }
  return text.slice(0, end)
}

// The longest suffix of the text that fits in `bytes`, cut between characters.
const suffixWithin = (text: string, bytes: number): string => {
  let used = 0
  let start = text.length
  for (const char of Array.from(text).reverse()) {
    used += byteLength(char)
    if (used > bytes) break
    start -= char.length
  }
  return text.slice(start)
}

/**
 * Cuts a text to a token cap the way Codex does (`guardian_truncate_text`): the head and the tail
 * stay, half of the room each, and a `<truncated omitted_approx_tokens="N" />` marker sits between
 * them, so the reviewer can tell the text is not whole.
 */
export const truncateText = (text: string, tokenCap: number): string => {
  const maxBytes = tokenCap * 4
  const total = byteLength(text)
  if (total <= maxBytes) return text
  const marker = `<truncated omitted_approx_tokens="${Math.ceil((total - maxBytes) / 4)}" />`
  const room = maxBytes - byteLength(marker)
  if (room <= 0) return marker
  const head = Math.floor(room / 2)
  return `${prefixWithin(text, head)}${marker}${suffixWithin(text, room - head)}`
}

// Every kind of line break that a reader may take for one, as a `\n`.
const LINE_BREAKS = /\r\n|[\r\u0085\u2028\u2029\v\f]/g

// An entry's text goes in as an indented block: its lines start with two spaces, while the
// transcript's own lines (`[3] user: ...`, `>>> TRANSCRIPT END`) start at the margin, so no text
// can forge one.
const indented = (text: string): string =>
  text.replaceAll(LINE_BREAKS, "\n").replaceAll("\n", "\n  ")

const renderOne = (entry: TranscriptEntry, number: number) => {
  const cap = entry.kind === "tool" ? MAX_TOOL_ENTRY_TOKENS : MAX_MESSAGE_ENTRY_TOKENS
  const text = `[${number}] ${entry.role}: ${indented(truncateText(entry.text, cap))}`
  return { text, tokens: approxTokens(text) }
}

/** The rendered transcript: its lines, and a note when entries were left out. */
export interface RenderedTranscript {
  readonly lines: ReadonlyArray<string>
  readonly omission: string | undefined
}

/**
 * Renders the entries within Codex's budget (`render_guardian_transcript_entries`): each entry is
 * cut to its cap; user and assistant entries share 10k tokens and tool entries have 10k of their
 * own, so tool output cannot crowd out the conversation. The first user entry and the latest one
 * are anchors, the other user entries follow from the newest, then the most recent non-user entries
 * (at most 40) fill what is left. Entries keep their order and their numbers in the whole history.
 */
export const renderTranscript = (entries: ReadonlyArray<TranscriptEntry>): RenderedTranscript => {
  if (entries.length === 0) return { lines: [" "], omission: undefined }
  const rendered = entries.map((entry, index) => renderOne(entry, index + 1))
  const included = entries.map(() => false)
  let messageTokens = 0
  let toolTokens = 0
  const users = entries.flatMap((entry, index) => (entry.kind === "user" ? [index] : []))
  const first = users[0]
  if (first !== undefined) {
    included[first] = true
    messageTokens += rendered[first]?.tokens ?? 0
  }
  const last = users[users.length - 1]
  if (
    last !== undefined &&
    included[last] !== true &&
    messageTokens + (rendered[last]?.tokens ?? 0) <= MAX_MESSAGE_TRANSCRIPT_TOKENS
  ) {
    included[last] = true
    messageTokens += rendered[last]?.tokens ?? 0
  }
  for (const index of [...users].reverse()) {
    const tokens = rendered[index]?.tokens ?? 0
    if (included[index] === true || messageTokens + tokens > MAX_MESSAGE_TRANSCRIPT_TOKENS) continue
    included[index] = true
    messageTokens += tokens
  }
  let retained = 0
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry === undefined || entry.kind === "user" || retained >= RECENT_ENTRY_LIMIT) continue
    const tokens = rendered[index]?.tokens ?? 0
    const fits =
      entry.kind === "tool"
        ? toolTokens + tokens <= MAX_TOOL_TRANSCRIPT_TOKENS
        : messageTokens + tokens <= MAX_MESSAGE_TRANSCRIPT_TOKENS
    if (!fits) continue
    included[index] = true
    retained++
    if (entry.kind === "tool") toolTokens += tokens
    else messageTokens += tokens
  }
  return {
    lines: rendered.flatMap((entry, index) => (included[index] === true ? [entry.text] : [])),
    omission: included.includes(false) ? "Some conversation entries were omitted." : undefined,
  }
}

/** The entry that records the user's manual approval of an action, as Codex does. */
export const manualApprovalEntry = (actionJson: string): TranscriptEntry => ({
  role: "developer",
  kind: "developer",
  text: `${MANUAL_APPROVAL_PREFIX}\nApproved action:\n${actionJson}`,
})

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ToolCallBlock = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Unknown,
})
const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Unknown)]),
})
const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(Schema.Unknown),
})
const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.optionalKey(Schema.String),
  content: Schema.Array(Schema.Unknown),
})

const isText = Schema.is(TextBlock)
const isToolCall = Schema.is(ToolCallBlock)
const isUser = Schema.is(UserMessage)
const isAssistant = Schema.is(AssistantMessage)
const isToolResult = Schema.is(ToolResultMessage)

const textOf = (content: string | ReadonlyArray<unknown>): string =>
  typeof content === "string"
    ? content
    : content
        .filter(isText)
        .map((block) => block.text)
        .join("\n")

// The marker of the user's approval, as a pattern that survives other case and spacing: only
// `manualApprovalEntry` may write it, so it comes out of everything the history holds.
const APPROVAL_MARKER = new RegExp(
  MANUAL_APPROVAL_PREFIX.split(/\s+/)
    .map((word) => word.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+"),
  "gi",
)

// A history entry as the reviewer reads it: the label on one line (a tool name comes from the
// model), and the approval marker out of the text.
const nonEmpty = (entry: TranscriptEntry): ReadonlyArray<TranscriptEntry> =>
  entry.text.trim() === ""
    ? []
    : [
        {
          ...entry,
          role: entry.role.replaceAll(/\s+/g, " ").trim(),
          text: entry.text.replaceAll(APPROVAL_MARKER, "[approval marker removed]"),
        },
      ]

/**
 * The entries of Pi's session history that the reviewer reads
 * (`collect_guardian_transcript_entries`): the user's messages, the assistant's text, and the tool
 * calls with their results, so the reviewer sees the exact arguments and what came back. Reasoning,
 * images and every other kind of message are left out. Messages are read as Pi stores them; one of
 * another shape is skipped.
 */
export const entriesFromMessages = (
  messages: ReadonlyArray<unknown>,
): ReadonlyArray<TranscriptEntry> => {
  const names = new Map<string, string>()
  return messages.flatMap((message): ReadonlyArray<TranscriptEntry> => {
    if (isUser(message))
      return nonEmpty({ role: "user", kind: "user", text: textOf(message.content) })
    if (isAssistant(message)) {
      const text = nonEmpty({
        role: "assistant",
        kind: "assistant",
        text: textOf(message.content),
      })
      const calls = message.content.filter(isToolCall).flatMap((call) => {
        names.set(call.id, call.name)
        return nonEmpty({
          role: `tool ${call.name} call`,
          kind: "tool",
          text: JSON.stringify(call.arguments) ?? "",
        })
      })
      return [...text, ...calls]
    }
    if (isToolResult(message)) {
      const name = message.toolName ?? names.get(message.toolCallId)
      return nonEmpty({
        role: name === undefined ? "tool result" : `tool ${name} result`,
        kind: "tool",
        text: textOf(message.content),
      })
    }
    return []
  })
}
