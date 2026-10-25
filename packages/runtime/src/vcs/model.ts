import { Schema } from "effect"

/**
 * How commits are made. `git` is plain git with the user's own identity and signing, `api` is
 * GitHub's createCommitOnBranch (authored by the credential owner and signed by GitHub) and
 * `git-owner` is git with author and committer set to the credential owner, unsigned.
 */
export const CommitPath = Schema.Literals(["git", "api", "git-owner"])
/** The way commits are made (see {@link CommitPath}). */
export type CommitPath = typeof CommitPath.Type

/** The GitHub account behind the credential. */
export const Owner = Schema.Struct({
  login: Schema.String,
  id: Schema.Int,
  name: Schema.optionalKey(Schema.String),
  /** The public email, else the noreply address of the account. */
  email: Schema.String,
})
/** The GitHub account behind the credential. */
export type Owner = typeof Owner.Type

/** The identity git would commit with. */
export const Identity = Schema.Struct({ name: Schema.String, email: Schema.String })
/** The identity git would commit with. */
export type Identity = typeof Identity.Type

/** A full commit id, SHA-1 or SHA-256. */
export const Sha = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/))

/**
 * What the per-clone `vcs.json` keeps of a detection. Everything else (owner, identity, path) is
 * decided from live inputs on every run, so a stale or edited file cannot choose whose commits
 * these are.
 */
export const DetectionCache = Schema.Struct({
  /** What the detection was computed from; any change recomputes it. */
  key: Schema.String,
  /** Whether the GraphQL API answered when it was probed. */
  graphql: Schema.Boolean,
  /** True once a commit of this path was read back from GitHub and matched. */
  verified: Schema.Boolean,
  /** The first git commit awaiting that read-back, which waits for its push. */
  pending: Schema.optionalKey(Sha),
})
/** What the per-clone `vcs.json` keeps of a detection. */
export type DetectionCache = typeof DetectionCache.Type

/** The outcome of `vcs detect`. */
export interface Detection {
  readonly key: string
  readonly path: CommitPath
  /** Whether GitHub will show the commits of this path as verified. */
  readonly signed: boolean
  readonly reason: string
  /** Absent when no credential works and the git identity is the user's own. */
  readonly owner?: Owner
  readonly identity: Identity
  /** The remote URL without credentials. */
  readonly remote: string
  readonly graphql: boolean
  readonly verified: boolean
  readonly pending?: string
}
