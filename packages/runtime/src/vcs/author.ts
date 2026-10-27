import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { git } from "./git.ts"
import { looksLikeAgent } from "./identity.ts"

/** What `vcs identity` was asked to write. */
export interface AuthorRequest {
  readonly name: string
  readonly email: string
}

/** The usage line of `vcs identity`. */
export const IDENTITY_USAGE = "vcs identity --name <name> --email <email>"

/**
 * Sets `author.name` and `author.email` in the clone's local git config (`.git/config`, never a
 * file of the work tree), which git uses for the author of a commit without touching the committer.
 * The values must read as a person's: a name and an email address without angle brackets or control
 * characters, and not the identity of an agent.
 */
export const setAuthor = (request: AuthorRequest) =>
  Effect.gen(function* () {
    const name = request.name.trim()
    const email = request.email.trim()
    const refuse = (message: string) =>
      new Usage({ message, hint: `Usage: holyagent ${IDENTITY_USAGE}` })
    const plain = (text: string) => !/[<>\p{Cc}]/u.test(text)
    if (name === "" || !plain(name))
      return yield* refuse(
        "--name needs the user's name, without angle brackets or control characters",
      )
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(email) || !plain(email))
      return yield* refuse(
        "--email needs an email address such as 1234+login@users.noreply.github.com",
      )
    if (looksLikeAgent({ name, email }))
      return yield* refuse(`${name} <${email}> looks like an agent's identity, not the user's`)
    yield* git(["config", "--local", "author.name", name])
    yield* git(["config", "--local", "author.email", email])
    return { name, email }
  })
