import { Schema } from "effect"

/** Text with at least one non-whitespace character. */
export const Text = Schema.String.check(Schema.isPattern(/\S/))

/** A live Intent revision: the first revision is 1. */
export const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/

/** True for a real UTC instant: the fields must be the ones the date reads back, so no 02-30. */
const isInstant = (text: string): boolean => {
  const match = INSTANT.exec(text)
  if (match === null || Number.isNaN(Date.parse(text))) return false
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const date = new Date(text)
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  )
}

/** A real UTC instant as ISO 8601 text, such as `2026-01-02T03:04:05.000Z`. */
export const Timestamp = Schema.String.check(
  Schema.makeFilter(
    (text: string) => isInstant(text) || "a real UTC instant such as 2026-01-02T03:04:05Z",
  ),
)

/** A list of non-blank texts. */
export const TextList = Schema.Array(Text)
