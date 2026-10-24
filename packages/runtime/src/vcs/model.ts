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

/** The outcome of `vcs detect`, cached in the per-clone `vcs.json`. */
export const Detection = Schema.Struct({
  /** What the detection was computed from; any change recomputes it. */
  key: Schema.String,
  path: CommitPath,
  /** Whether GitHub will show the commits of this path as verified. */
  signed: Schema.Boolean,
  reason: Schema.String,
  /** Absent when no credential works and the git identity is the user's own. */
  owner: Schema.optionalKey(Owner),
  identity: Identity,
  remote: Schema.String,
  /** True once a commit of this path was read back from GitHub and matched. */
  verified: Schema.Boolean,
  /** The first git commit awaiting that read-back, which waits for its push. */
  pending: Schema.optionalKey(Schema.String),
})
/** The outcome of `vcs detect`. */
export type Detection = typeof Detection.Type
