/** True for the identity an agent runtime configures, which never belongs to the user. */
export const looksLikeAgent = (identity: { readonly name: string; readonly email: string }) =>
  identity.email.toLowerCase() === "noreply@anthropic.com" ||
  /^claude\b/i.test(identity.name.trim())
