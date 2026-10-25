import { Effect, Schema } from "effect"

import { decodeAnswer, GitHub } from "./github.ts"
import type { Owner } from "./model.ts"

/** A path below the API root with each segment escaped, so `a/b c` stays two segments. */
export const apiPath = (path: string): string => path.split("/").map(encodeURIComponent).join("/")

const User = Schema.Struct({
  login: Schema.String,
  id: Schema.Int,
  name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
})

/** The noreply addresses GitHub accepts for an account. */
export const noreplyEmails = (owner: Pick<Owner, "login" | "id">): ReadonlyArray<string> => [
  `${owner.id}+${owner.login}@users.noreply.github.com`,
  `${owner.login}@users.noreply.github.com`,
]

/** The owner of the credential: `GET /user`, with the noreply address when no email is public. */
export const fetchOwner = GitHub.use((github) => github.rest({ method: "GET", path: "user" })).pipe(
  Effect.flatMap((answer) => decodeAnswer(User, "GET user", answer)),
  Effect.map((user): Owner => ({
    login: user.login,
    id: user.id,
    ...(user.name === null || user.name === "" ? {} : { name: user.name }),
    email: user.email ?? noreplyEmails(user)[0] ?? "",
  })),
)

/** True when GraphQL answers for this credential; any failure means it does not. */
export const graphqlAvailable = GitHub.use((github) => github.graphql("{viewer{login}}", {})).pipe(
  Effect.as(true),
  Effect.orElseSucceed(() => false),
)

const Ref = Schema.Struct({ object: Schema.Struct({ sha: Schema.String }) })

/**
 * The commit a branch points at on GitHub, or undefined when the branch (or the repository's first
 * commit) does not exist.
 */
export const branchHead = (repo: string, branch: string) =>
  GitHub.use((github) =>
    github.rest({ method: "GET", path: `repos/${repo}/git/ref/heads/${apiPath(branch)}` }),
  ).pipe(
    Effect.flatMap((answer) => decodeAnswer(Ref, "GET git/ref", answer)),
    Effect.map((ref) => ref.object.sha as string | undefined),
    Effect.catchIf(
      (error) => error.status === 404 || error.status === 409,
      () => Effect.succeed(undefined),
    ),
  )

/** True when the repository has no branch yet. */
export const repoIsEmpty = (repo: string) =>
  GitHub.use((github) =>
    github.rest({ method: "GET", path: `repos/${repo}/branches?per_page=1` }),
  ).pipe(
    Effect.flatMap((answer) => decodeAnswer(Schema.Array(Schema.Unknown), "GET branches", answer)),
    Effect.map((branches) => branches.length === 0),
  )

/** Creates a branch on GitHub at a commit that GitHub already has. */
export const createBranch = (repo: string, branch: string, sha: string) =>
  GitHub.use((github) =>
    github.rest({
      method: "POST",
      path: `repos/${repo}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha },
    }),
  ).pipe(Effect.asVoid)

const PutResult = Schema.Struct({ commit: Schema.Struct({ sha: Schema.String }) })

/**
 * Creates the first commit of an empty repository with one file (`PUT contents`), the one write
 * GitHub accepts there. No author or committer is sent, so the commit is the credential owner's.
 */
export const putFirstFile = (
  repo: string,
  file: {
    readonly path: string
    readonly contents: string
    readonly message: string
    readonly branch: string
  },
) =>
  GitHub.use((github) =>
    github.rest({
      method: "PUT",
      path: `repos/${repo}/contents/${apiPath(file.path)}`,
      body: { message: file.message, content: file.contents, branch: file.branch },
    }),
  ).pipe(
    Effect.flatMap((answer) => decodeAnswer(PutResult, "PUT contents", answer)),
    Effect.map((result) => result.commit.sha),
  )

/** The mutation that appends one commit to an existing branch. */
export const CREATE_COMMIT_ON_BRANCH = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) { commit { oid } }
}`

/** The input of createCommitOnBranch, in the shape GitHub's schema names. */
export interface CommitOnBranchInput {
  readonly branch: { readonly repositoryNameWithOwner: string; readonly branchName: string }
  readonly expectedHeadOid: string
  readonly message: { readonly headline: string; readonly body?: string }
  readonly fileChanges: {
    readonly additions: ReadonlyArray<{ readonly path: string; readonly contents: string }>
    readonly deletions: ReadonlyArray<{ readonly path: string }>
  }
}

const Created = Schema.Struct({
  createCommitOnBranch: Schema.Struct({ commit: Schema.Struct({ oid: Schema.String }) }),
})

/**
 * Appends a commit to a branch and returns its id; GitHub authors and signs it for the credential
 * owner.
 */
export const createCommitOnBranch = (input: CommitOnBranchInput) =>
  GitHub.use((github) => github.graphql(CREATE_COMMIT_ON_BRANCH, { input })).pipe(
    Effect.flatMap((data) => decodeAnswer(Created, "createCommitOnBranch", data)),
    Effect.map((created) => created.createCommitOnBranch.commit.oid),
  )

const CommitView = Schema.Struct({
  sha: Schema.String,
  author: Schema.NullOr(Schema.Struct({ login: Schema.String })),
  commit: Schema.Struct({
    verification: Schema.Struct({ verified: Schema.Boolean, reason: Schema.String }),
  }),
})

/** A commit as GitHub shows it: the linked author account and the signature verdict. */
export const readCommit = (repo: string, sha: string) =>
  GitHub.use((github) => github.rest({ method: "GET", path: `repos/${repo}/commits/${sha}` })).pipe(
    Effect.flatMap((answer) => decodeAnswer(CommitView, "GET commits", answer)),
  )
