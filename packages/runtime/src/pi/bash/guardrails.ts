/**
 * The environment variables that turn off Billion Context's guardrails on the bash tool: the
 * default 60 s timeout it adds to a call that names none, the 50 KB cap on a result and the
 * repeated-call breaker (which watches every tool, not only bash). `0` is Billion Context's own
 * "off" for the first two, and `0` or `false` for the third. The values win over its settings file.
 * The same three settings are written to its file by {@link BILLION_CONTEXT_GUARDRAILS_FILE}.
 */
export const BILLION_CONTEXT_GUARDRAILS_OFF = {
  BILI_GUARDRAIL_BASH_TIMEOUT: "0",
  BILI_GUARDRAIL_MAX_OUTPUT_BYTES: "0",
  BILI_GUARDRAIL_REPETITION: "0",
} as const

/**
 * The same guardrail settings as keys of Billion Context's JSON file
 * (`~/.config/billion-context/billion-context.json`). Billion Context reads its environment when
 * its extension loads, which can be before the HolyAgent extension has read the config and set
 * {@link BILLION_CONTEXT_GUARDRAILS_OFF}, so setup also writes these keys: the file is read at that
 * same moment and needs no load order. The environment wins when both are set.
 */
export const BILLION_CONTEXT_GUARDRAILS_FILE = {
  guardrails: { bashTimeout: 0, maxOutputBytes: 0, repetition: false },
} as const
