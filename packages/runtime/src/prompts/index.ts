import type { RoleTask } from "../domain/route.ts"
import codeReview from "./code-review.md" with { type: "text" }
import securityReview from "./security-review.md" with { type: "text" }

/** One first-pass prompt template: the file it ships as in the Pi package and what it holds. */
export interface PromptTemplate {
  /** The template's name, which is its file name without `.md` and its `/` command in Pi. */
  readonly name: string
  /** The frontmatter lines (`description`, `argument-hint`), without the fences. */
  readonly head: ReadonlyArray<string>
  /** The prompt text after the frontmatter. */
  readonly body: string
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

// A source without frontmatter has an empty head and keeps its text as the body; the tests require
// the head of every template, so the build fails on it.
const parseTemplate = (name: string, text: string): PromptTemplate => {
  const match = FRONTMATTER.exec(text)
  return match === null
    ? { name, head: [], body: text.trim() }
    : { name, head: (match[1] ?? "").split("\n"), body: (match[2] ?? "").trim() }
}

const CODE_REVIEW = parseTemplate("code-review", codeReview)
const SECURITY_REVIEW = parseTemplate("security-review", securityReview)

/** The templates the Pi package ships in its `prompts/` folder, in name order. */
export const PROMPT_TEMPLATES: ReadonlyArray<PromptTemplate> = [CODE_REVIEW, SECURITY_REVIEW]

/**
 * The role tasks whose task starts with a first-pass prompt on Pi, and the template each one gets.
 * These are the two reviews that run the built-in `/code-review` and `/security-review` on Claude.
 */
const FIRST_PASS: Readonly<Partial<Record<RoleTask, PromptTemplate>>> = {
  "Reviewer.code": CODE_REVIEW,
  "Reviewer.security": SECURITY_REVIEW,
}

// Pi fills `${@:-default}` from the arguments of a `/name` call; the launcher has none, so it takes
// the default, which names the Assignment that follows the prompt.
const ARGUMENTS_DEFAULT = /\$\{@:-([^}]*)\}/g

/**
 * The first-pass prompt a launcher puts at the start of a role's task, with the template's
 * arguments at their defaults, or undefined for a role that has none (every role but
 * `Reviewer.code` and `Reviewer.security`).
 */
export const firstPassPrompt = (roleTask: RoleTask): string | undefined =>
  // A replacer function keeps `$` sequences in the default text literal.
  FIRST_PASS[roleTask]?.body.replace(ARGUMENTS_DEFAULT, (_match, fallback: string) => fallback)
