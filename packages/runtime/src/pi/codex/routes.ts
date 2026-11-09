import type { RouteChoice, RouteKey, Thinking } from "../../config/schema.ts"

/** Pi's provider id for the ChatGPT-subscription Codex backend, the `<provider>` of `--model`. */
export const CODEX_PROVIDER_ID = "openai-codex"

/** GPT-6.1 Sol, the root's model. */
export const SOL = "gpt-6.1-sol"
/** GPT-6.1 Terra, the model of the specialists that write, trace, review and see. */
export const TERRA = "gpt-6.1-terra"
/** GPT-6 Luna, the model of the light specialists; it never runs at `xhigh`. */
export const LUNA = "gpt-6-luna"

const choice = (model: string, thinking: Thinking): RouteChoice => ({ model, thinking })

/**
 * The default route table of the Codex provider, as the maintainer approved it: the root on Sol at
 * high; the light specialists (map, lookup, validation, mechanical, operations and the audit) on
 * Luna from low to high, never `xhigh`; every other specialist on Terra from medium to `xhigh`, the
 * visual ones and computer use included. An Assignment that uses the screen capability runs on
 * Terra at medium or above, which the later capability applies.
 */
export const CODEX_ROUTES: Readonly<Record<RouteKey, RouteChoice>> = {
  // plans, decides and makes the final pass
  root: choice(SOL, "high"),
  // reads and reports the layout
  "Explorer.map": choice(LUNA, "low"),
  // answers a narrow question from files
  "Explorer.lookup": choice(LUNA, "low"),
  // follows one flow through the code
  "Explorer.trace": choice(TERRA, "medium"),
  // fetches one fact from documentation
  "Librarian.lookup": choice(LUNA, "low"),
  // gathers and compares sources
  "Librarian.research": choice(TERRA, "medium"),
  // bounded edits with a known recipe
  "Worker.mechanical": choice(LUNA, "medium"),
  // writes the change that gets merged
  "Worker.implementation": choice(TERRA, "high"),
  // spans several systems and contracts
  "Worker.integration": choice(TERRA, "medium"),
  // runs commands along a documented procedure
  "Worker.operations": choice(LUNA, "medium"),
  // runs the gates and reports their output
  "Worker.validation": choice(LUNA, "low"),
  // root-cause work needs the deepest reasoning
  "Worker.debugging": choice(TERRA, "xhigh"),
  // visual work runs on Terra
  "Worker.visual": choice(TERRA, "high"),
  // visual work runs on Terra
  "Reviewer.visual": choice(TERRA, "high"),
  // a missed defect costs more than the tokens
  "Reviewer.code": choice(TERRA, "high"),
  // judges whether the tests prove the behavior
  "Reviewer.testing": choice(TERRA, "medium"),
  // checks records against evidence
  "Reviewer.audit": choice(LUNA, "high"),
  // judges trust boundaries
  "Reviewer.security": choice(TERRA, "xhigh"),
  // judges instruction text against its requirements
  "Reviewer.artifact": choice(TERRA, "medium"),
}
