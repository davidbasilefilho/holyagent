import type { Config } from "../../config/schema.ts"
import { BILLION_CONTEXT_GUARDRAILS_OFF } from "./guardrails.ts"

/**
 * Whether the config runs the bash tool on just-bash: `pi.enable` and its own switch,
 * `pi.features.justBash` (on by default), both on. Off, Pi's own bash tool and Billion Context's
 * guardrails stay as they are.
 */
export const justBashOn = (config: Config): boolean =>
  config.pi.enable && config.pi.features.justBash

/**
 * The process-wide variables the module decides: Billion Context's bash guardrails off while the
 * bash tool runs on just-bash, nothing otherwise. The guardrails cap a result at 50 KB and stop a
 * call at 60 s, limits the shell has its own answers for (Pi's `timeout`, Pi's output truncation).
 */
export const justBashEnvironment = (config: Config): Readonly<Record<string, string>> =>
  justBashOn(config) ? BILLION_CONTEXT_GUARDRAILS_OFF : {}
