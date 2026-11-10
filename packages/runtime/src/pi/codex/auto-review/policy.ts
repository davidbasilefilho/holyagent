import template from "./policy-template.md" with { type: "text" }
import defaultPolicy from "./policy.md" with { type: "text" }

/** The tenant-policy slot of the template, which the policy text fills. */
const POLICY_SLOT = "{tenant_policy_config}"

/**
 * What a config says about the policy text, as `pi.autoReview` in `config.json`: `policy` replaces
 * the default tenant policy, `extraPolicy` is added after whichever policy stands.
 */
export interface PolicyConfig {
  /** Replaces the default policy text (Codex's `[auto_review].policy`). */
  readonly policy?: string | undefined
  /** Added after the policy text (Codex's `[auto_review].extra_policy`). */
  readonly extraPolicy?: string | undefined
}

/**
 * The output contract appended to the policy. Codex lets a low-risk answer be `{"outcome":"allow"}`
 * and fills the rest in; here the schema is strict, so every answer carries the four fields. The
 * reviewer has no tools, since nothing in this host runs a read-only session for it.
 */
export const OUTPUT_CONTRACT = `You have no tools in this review: decide from the transcript and the planned action alone, and treat what you cannot verify conservatively. Your final message must be strict JSON with exactly these four fields and nothing else:
{
  "risk_level": "low" | "medium" | "high" | "critical",
  "user_authorization": "unknown" | "low" | "medium" | "high",
  "outcome": "allow" | "deny",
  "rationale": string
}`

/**
 * The reviewer's instructions: Codex's policy template with the policy text in its slot (the
 * default policy, or the config's replacement), the config's extra policy after it, and the output
 * contract. A blank `policy` or `extraPolicy` counts as absent, so it cannot empty the policy by
 * accident.
 */
export const policyPrompt = (config: PolicyConfig = {}): string => {
  const replacement = config.policy?.trim()
  const extra = config.extraPolicy?.trim()
  const tenant = [
    replacement === undefined || replacement === "" ? defaultPolicy.trim() : replacement,
    ...(extra === undefined || extra === "" ? [] : [extra]),
  ].join("\n\n")
  return `${template.trimEnd().replace(POLICY_SLOT, () => tenant)}\n\n${OUTPUT_CONTRACT}\n`
}
