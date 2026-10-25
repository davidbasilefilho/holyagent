import { Effect, Option, Schema } from "effect"

import { commitFile } from "../state/files.ts"
import { encodeLocal, readLocal, type Vcs } from "../state/local.ts"
import { withStateLock } from "../state/lock.ts"
import { GitHubFailed, NoCredential } from "./errors.ts"
import { gitMaybe, isGithubRemote, originUrl, repoSlug } from "./git.ts"
import { type Detection, DetectionCache, type Identity, type Owner } from "./model.ts"
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

/**
 * Remembers what a detection may keep (see {@link DetectionCache}). A detection made without a known
 * owner is never kept, so it cannot outlive the failure that shaped it.
 */
export const saveDetection = (directory: string, detection: Detection) =>
  detection.owner === undefined
    ? Effect.void
    : saveVcs(directory, (current) => ({
        ...current,
        detection: {
          key: detection.key,
          graphql: detection.graphql,
          verified: detection.verified,
          ...(detection.pending === undefined ? {} : { pending: detection.pending }),
        },
      }))

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
  readonly signing: boolean
  /** The credential's account, or why none could be read. */
  readonly owner: Owner | GitHubFailed
}

const keyOf = (inputs: Inputs) =>
  [
    inputs.owner instanceof GitHubFailed ? "-" : inputs.owner.login,
    inputs.identity.name,
    inputs.identity.email,
    inputs.remote,
    `api=${inputs.api}`,
    `gpgsign=${inputs.signing}`,
  ].join("\n")

/** Whether the API path is in play at all, so the GraphQL probe is worth making. */
const wantsApi = (inputs: Inputs) =>
  !(inputs.owner instanceof GitHubFailed) &&
  !sameAccount(inputs.owner, inputs.identity.email) &&
  inputs.api &&
  isGithubRemote(inputs.remote)

const decide = (
  key: string,
  inputs: Inputs,
  graphql: boolean,
  kept: Pick<Detection, "verified" | "pending">,
): Effect.Effect<Detection, NoCredential> => {
  const { identity, remote, owner, signing } = inputs
  const base = { key, identity, remote, graphql, ...kept } as const
  if (owner instanceof GitHubFailed) {
    if (looksLikeAgent(identity))
      return Effect.fail(new NoCredential({ identity: describe(identity), reason: owner.reason }))
    return Effect.succeed({
      ...base,
      path: "git",
      signed: signing,
      reason: "no GitHub credential works; commits use the configured git identity",
    })
  }
  const viaOwner = { ...base, owner } as const
  if (sameAccount(owner, identity.email))
    return Effect.succeed({
      ...viaOwner,
      path: "git",
      signed: signing,
      reason: signing
        ? "the git identity is the GitHub owner's; commits carry the configured signature"
        : "the git identity is the GitHub owner's; commit.gpgsign is off, so commits are unsigned",
    })
  const differs = `the git identity ${describe(identity)} is not the owner ${owner.login}`
  const viaGit = (why: string) =>
    Effect.succeed<Detection>({
      ...viaOwner,
      path: "git-owner",
      signed: false,
      reason: `${differs}${why}, so git commits as the owner without a signature`,
    })
  if (!inputs.api) return viaGit("; vcs.api is false")
  if (!isGithubRemote(remote)) return viaGit("; origin is not a github.com remote")
  if (!graphql) return viaGit(" and the GraphQL API is unavailable")
  return Effect.succeed({
    ...viaOwner,
    path: "api",
    signed: true,
    reason: `${differs}; GitHub authors and signs API commits as the owner`,
  })
}

/**
 * The commit path of this clone. The owner, identity, remote and settings are read live on every
 * run; the cache only spares the GraphQL probe and remembers the read-back state, and only while
 * the key of those inputs is unchanged. A detection made while GitHub could not be reached is
 * returned but never cached.
 */
export const detect = (directory: string, root: string, refresh: boolean) =>
  Effect.gen(function* () {
    const settings = yield* readSettings(root)
    // A cache that is in an old shape or does not decode is the same as no cache: it is recomputed
    // and rewritten below.
    const cache = Option.getOrUndefined(
      Schema.decodeUnknownOption(DetectionCache)((yield* readLocal(directory)).vcs.detection),
    )
    const inputs: Inputs = {
      identity: {
        name: (yield* gitMaybe(["config", "user.name"])) ?? "",
        email: (yield* gitMaybe(["config", "user.email"])) ?? "",
      },
      remote: yield* originUrl,
      api: settings.api !== false,
      signing: (yield* gitMaybe(["config", "--bool", "commit.gpgsign"])) === "true",
      owner: yield* fetchOwner.pipe(Effect.catchTag("GitHubFailed", Effect.succeed)),
    }
    const key = keyOf(inputs)
    const hit = !refresh && !(inputs.owner instanceof GitHubFailed) && cache?.key === key
    const graphql = hit ? cache.graphql : wantsApi(inputs) ? yield* graphqlAvailable : false
    const detection = yield* decide(key, inputs, graphql, {
      verified: hit ? cache.verified : false,
      ...(hit && cache.pending !== undefined ? { pending: cache.pending } : {}),
    })
    if (!hit) yield* saveDetection(directory, detection)
    return { detection, cached: hit }
  })

/** The `owner/repo` of the remote, for the calls that need GitHub. */
export const repoOf = (detection: Detection) => repoSlug(detection.remote)
