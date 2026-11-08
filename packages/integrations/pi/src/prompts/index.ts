import type { RoleTask } from "../../../../runtime/src/domain/route.ts"
import codeReview from "./code-review.md" with { type: "text" }
import securityReview from "./security-review.md" with { type: "text" }

/** One first-pass prompt template of the Pi package: the file it ships as and what it holds. */
export interface PromptTemplate {
  /** The template's name, which is its file name without `.md` and its `/` command in Pi. */
  readonly name: string
  /** The frontmatter lines (`description`, `argument-hint`), without the fences. */
  readonly head: ReadonlyArray<string>
  /** The prompt text after the frontmatter. */
  readonly body: string
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

const parseTemplate = (name: string, text: string): PromptTemplate => {
  const match = FRONTMATTER.exec(text)
  if (match === null) throw new Error(`prompts/${name}.md has no frontmatter`)
  return { name, head: (match[1] ?? "").split("\n"), body: (match[2] ?? "").trim() }
}

/** The templates the package ships in its `prompts/` folder, in name order. */
export const PROMPT_TEMPLATES: ReadonlyArray<PromptTemplate> = [
  parseTemplate("code-review", codeReview),
  parseTemplate("security-review", securityReview),
]

/**
 * The role tasks whose task starts with a first-pass prompt on Pi, and the template each one gets.
 * These are the two reviews that run the built-in `/code-review` and `/security-review` on Claude.
 */
const FIRST_PASS: Readonly<Partial<Record<RoleTask, string>>> = {
  "Reviewer.code": "code-review",
  "Reviewer.security": "security-review",
}

// Pi fills `${@:-default}` from the arguments of a `/name` call; the launcher has none, so it takes
// the default, which names the Assignment that follows the prompt.
const ARGUMENTS_DEFAULT = /\$\{@:-([^}]*)\}/g

/**
 * The first-pass prompt a launcher puts at the start of a role's task, with the template's
 * arguments at their defaults, or undefined for a role that has none (every role but
 * `Reviewer.code` and `Reviewer.security`).
 */
export const firstPassPrompt = (roleTask: RoleTask): string | undefined => {
  const name = FIRST_PASS[roleTask]
  const template = PROMPT_TEMPLATES.find((candidate) => candidate.name === name)
  return template?.body.replace(ARGUMENTS_DEFAULT, "$1")
}
