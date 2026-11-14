/** The email the agent runtime configures for its commits. */
const AGENT_EMAIL = "noreply@anthropic.com"

/** The names the agent runtime configures; a person whose name merely contains one is not it. */
const AGENT_NAMES: ReadonlyArray<string> = ["claude", "claude code"]

/**
 * True for exactly the identity an agent runtime configures, which never belongs to the user: the
 * email `noreply@anthropic.com`, or the name "Claude" or "Claude Code" (any letter case, any run of
 * spaces, tabs or non-breaking spaces between the words counting as one space). A person whose name
 * only contains Claude, such as "Claude Dupont", is not an agent.
 */
export const looksLikeAgent = (identity: { readonly name: string; readonly email: string }) =>
  identity.email.trim().toLowerCase() === AGENT_EMAIL ||
  AGENT_NAMES.includes(identity.name.replace(/\s+/g, " ").trim().toLowerCase())

/**
 * True when the process runs in a claude.ai cloud session (`CLAUDE_CODE_REMOTE=true`), where git's
 * committer is the platform's Claude and the author has to be set to the user.
 */
export const inCloudSession = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env["CLAUDE_CODE_REMOTE"] === "true"

/**
 * The name and email of a `git var GIT_AUTHOR_IDENT` line (`Name <email> <timestamp> <zone>`), or
 * undefined for a line of another shape.
 */
export const parseIdent = (
  line: string,
): { readonly name: string; readonly email: string } | undefined => {
  const match = /^(.*) <([^<>]*)> \d+ [+-]\d{4}$/.exec(line.trim())
  return match === null ? undefined : { name: match[1] ?? "", email: match[2] ?? "" }
}
