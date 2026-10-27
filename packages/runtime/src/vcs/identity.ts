/** True for the identity an agent runtime configures, which never belongs to the user. */
export const looksLikeAgent = (identity: { readonly name: string; readonly email: string }) =>
  identity.email.toLowerCase() === "noreply@anthropic.com" ||
  /^claude\b/i.test(identity.name.trim())

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
