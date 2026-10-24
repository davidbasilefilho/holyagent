import { Effect } from "effect"

import { commitFile } from "../state/files.ts"
import { encodeLocal, readLocal, type Vcs } from "../state/local.ts"
import { withStateLock } from "../state/lock.ts"
import { GitHubFailed, NoCredential } from "./errors.ts"
import { type Git, gitMaybe, originUrl, repoSlug } from "./git.ts"
import type { GitHub } from "./github.ts"
import type { Detection, Identity, Owner } from "./model.ts"
import { fetchOwner, graphqlAvailable, noreplyEmails } from "./repo.ts"
import { readSettings } from "./settings.ts"

/** Rewrites the `vcs` part of the per-clone state under the state lock. */
export const saveVcs = (directory: string, change: (current: Vcs) => Vcs) =>
  withStateLock(
    directory,
    Effect.gen(function* () {
      const local = yield* readLocal(directory)
      for (const file of yield* encodeLocal(directory, { vcs: change(local.vcs) }))
        yield* commitFile(file.path, file.content)
    }),
  )

/** Replaces the cached detection. */
export const saveDetection = (directory: string, detection: Detection) =>
  saveVcs(directory, (current) => ({ ...current, detection }))

/** True for the identity an agent runtime configures, which never belongs to the user. */
export const looksLikeAgent = (identity: Identity): boolean =>
  identity.email.toLowerCase() === "noreply@anthropic.com" ||
  /^claude\b/i.test(identity.name.trim())

const sameAccount = (owner: Owner, email: string): boolean => {
  const given = email.trim().toLowerCase()
  return [owner.email, ...noreplyEmails(owner)].some((known) => known.toLowerCase() === given)
}

const describe = (identity: Identity) => `${identity.name} <${identity.email}>`

/** What a detection is computed from. */
interface Inputs {
  readonly identity: Identity
  readonly remote: string
  readonly api: boolean
  /** The credential's account, or why none could be read. */
  readonly owner: Owner | GitHubFailed
}

const keyOf = (inputs: Inputs, ownerLogin: string) =>
  [
    ownerLogin,
    inputs.identity.name,
    inputs.identity.email,
    inputs.remote,
    `api=${inputs.api}`,
  ].join("\n")

const decide = (
  key: string,
  inputs: Inputs,
): Effect.Effect<Detection, NoCredential, Git | GitHub> =>
  Effect.gen(function* () {
    const { identity, remote, owner } = inputs
    const signing = (yield* gitMaybe(["config", "--bool", "commit.gpgsign"])) === "true"
    const base = { key, identity, remote, verified: false } as const
    if (owner instanceof GitHubFailed) {
      if (looksLikeAgent(identity))
        return yield* new NoCredential({ identity: describe(identity), reason: owner.reason })
      return {
        ...base,
        path: "git",
        signed: signing,
        reason: "no GitHub credential works; commits use the configured git identity",
      } satisfies Detection
    }
    const viaOwner = { ...base, owner } as const
    if (sameAccount(owner, identity.email))
      return {
        ...viaOwner,
        path: "git",
        signed: signing,
        reason: signing
          ? "the git identity is the GitHub owner's; commits carry the configured signature"
          : "the git identity is the GitHub owner's; commit.gpgsign is off, so commits are unsigned",
      } satisfies Detection
    const differs = `the git identity ${describe(identity)} is not the owner ${owner.login}`
    if (!inputs.api)
      return {
        ...viaOwner,
        path: "git-owner",
        signed: false,
        reason: `${differs}; vcs.api is false, so git commits as the owner without a signature`,
      } satisfies Detection
    if (yield* graphqlAvailable)
      return {
        ...viaOwner,
        path: "api",
        signed: true,
        reason: `${differs}; GitHub authors and signs API commits as the owner`,
      } satisfies Detection
    return {
      ...viaOwner,
      path: "git-owner",
      signed: false,
      reason: `${differs} and the GraphQL API is unavailable, so git commits as the owner without a signature`,
    } satisfies Detection
  })

/**
 * The commit path of this clone: the cached detection while its inputs are unchanged (the owner,
 * the git identity, the remote and `vcs.api`), else a fresh one that is cached. When GitHub cannot
 * be reached the cached owner stands in, so an offline commit keeps its path.
 */
export const detect = (directory: string, root: string, refresh: boolean) =>
  Effect.gen(function* () {
    const settings = yield* readSettings(root)
    const cached = (yield* readLocal(directory)).vcs.detection
    const inputs: Inputs = {
      identity: {
        name: (yield* gitMaybe(["config", "user.name"])) ?? "",
        email: (yield* gitMaybe(["config", "user.email"])) ?? "",
      },
      remote: yield* originUrl,
      api: settings.api !== false,
      owner: yield* fetchOwner.pipe(Effect.catchTag("GitHubFailed", Effect.succeed)),
    }
    const login = inputs.owner instanceof GitHubFailed ? cached?.owner?.login : inputs.owner.login
    const key = keyOf(inputs, login ?? "-")
    if (!refresh && cached?.key === key) return { detection: cached, cached: true }
    const detection = yield* decide(key, inputs)
    yield* saveDetection(directory, detection)
    return { detection, cached: false }
  })

/** The `owner/repo` of the remote, for the calls that need GitHub. */
export const repoOf = (detection: Detection) => repoSlug(detection.remote)
