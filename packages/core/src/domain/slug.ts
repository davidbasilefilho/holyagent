import { Schema } from "effect"

/** A name part of a record: lower-case ASCII words joined by single hyphens, or empty. */
export const Slug = Schema.String.check(Schema.isPattern(/^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/))

const MAX_LENGTH = 40
const READ_LENGTH = 512

/**
 * A readable name built from an objective, so a path says what the record is about. Accents fold to
 * their base letter, every other run of characters is a separator, and the result is cut at a word
 * boundary within 40 characters (a single longer word is cut mid-word). It is empty when the text
 * has no ASCII letter or digit once folded.
 */
export const slugOf = (text: string): string => {
  const words = text
    .slice(0, READ_LENGTH)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "")
  let slug = ""
  for (const word of words) {
    const next = slug === "" ? word : `${slug}-${word}`
    if (next.length > MAX_LENGTH) break
    slug = next
  }
  return slug === "" ? (words[0] ?? "").slice(0, MAX_LENGTH) : slug
}

/** The name of a record's directory or file: the slug and the id, or the id alone. */
export const recordName = (slug: string, id: string): string => (slug === "" ? id : `${slug}-${id}`)
