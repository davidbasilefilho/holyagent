/** Filters omitted and undefined process environment entries. */
export const definedEnv = (
  env: Readonly<Record<string, string | undefined>>,
  omit: ReadonlySet<string> = new Set(),
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !omit.has(entry[0]),
    ),
  )

/** Matches known runtime-owned identities without matching similar human names. */
export const looksLikeAgent = ({
  name,
  email,
}: {
  readonly name: string
  readonly email: string
}): boolean =>
  email.trim().toLowerCase() === "noreply@anthropic.com" ||
  ["claude", "claude code"].includes(name.replace(/\s+/g, " ").trim().toLowerCase())
