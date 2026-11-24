import { encode, escapeString, rawString } from "@toon-format/toon"

export { decode as decodeRecord } from "@toon-format/toon"

/** Encodes TOON without terminal control bytes, preserving the decoded values and keys. */
export const encodeRecord = (value: unknown): string =>
  encode(value, {
    // TOON's encoder quotes keys containing C1 controls, but may leave such values unquoted.
    // Force only those values into quoted strings so the Unicode escapes decode correctly.
    replacer: (_key, item) =>
      typeof item === "string" && /[\u007f-\u009f]/.test(item)
        ? rawString(`"${escapeString(item)}"`)
        : item,
  }).replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )
