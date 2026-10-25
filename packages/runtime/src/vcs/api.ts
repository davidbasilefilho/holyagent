import { Effect } from "effect"

import { describeFailure } from "../cli/errors.ts"
import type { StateIo } from "../state/errors.ts"
import {
  type GitFailed,
  HookFailed,
  PartialCommit,
  RemoteMismatch,
  UnsupportedChange,
} from "./errors.ts"
import { Git, git, headCommit } from "./git.ts"
import type { Message } from "./message.ts"
import {
  branchHead,
  createBranch,
  createCommitOnBranch,
  putFirstFile,
  repoIsEmpty,
} from "./repo.ts"

/**
 * The most base64 text one createCommitOnBranch request carries. GitHub documents no limit, so this
 * is a conservative bound under which requests are known to go through; bigger change sets are
 * split into several commits.
 */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024

/** One staged change the API can carry: a regular file written or deleted. */
export interface StagedChange {
  readonly path: string
  readonly kind: "add" | "modify" | "delete"
  readonly oid: string
}

const RAW_ENTRY = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/

const describeMode = (mode: string): string =>
  mode === "120000"
    ? "a symlink"
    : mode === "160000"
      ? "a submodule"
      : mode === "100755"
        ? "an executable file"
        : `mode ${mode}`

const classify = (meta: string, path: string): Effect.Effect<StagedChange, UnsupportedChange> => {
  const match = RAW_ENTRY.exec(meta)
  const [, oldMode = "", newMode = "", oldOid = "", newOid = "", status = ""] = match ?? []
  const refuse = (reason: string) => Effect.fail(new UnsupportedChange({ path, reason }))
  if (match === null) return refuse(`git reported the change as "${meta}"`)
  if (status === "D") return Effect.succeed({ path, kind: "delete", oid: oldOid })
  if (status === "M" && oldMode !== newMode && oldOid === newOid)
    return refuse(`only its mode changed (${oldMode} to ${newMode}), which the API cannot record`)
  if (oldMode !== newMode && status !== "A")
    return refuse(`its type changed (${oldMode} to ${newMode}), which the API cannot record`)
  if (newMode !== "100644")
    return refuse(`it is ${describeMode(newMode)}, and the API writes regular files only`)
  return Effect.succeed({ path, kind: status === "A" ? "add" : "modify", oid: newOid })
}

/** The staged changes as the API can carry them, or the first one it cannot. */
export const stagedChanges = git([
  "diff",
  "--cached",
  "--raw",
  "-z",
  "--no-renames",
  "--no-abbrev",
]).pipe(
  Effect.flatMap((raw) => {
    const tokens = raw.split("\0").filter((token) => token !== "")
    const entries = Array.from({ length: Math.floor(tokens.length / 2) }, (_, index) => ({
      meta: tokens[index * 2] ?? "",
      path: tokens[index * 2 + 1] ?? "",
    }))
    return Effect.forEach(entries, ({ meta, path }) => classify(meta, path))
  }),
)

/** A change with the size of its request share. */
export interface Sized {
  readonly path: string
  readonly size: number
}

const total = (changes: ReadonlyArray<Sized>) => changes.reduce((sum, { size }) => sum + size, 0)

/**
 * Splits changes into batches under the limit, keeping the files of a top-level directory together;
 * a directory that alone exceeds the limit splits again by its next level. A single file over the
 * limit stays alone, for the caller to refuse.
 */
export const partition = <T extends Sized>(
  changes: ReadonlyArray<T>,
  limit: number,
  depth = 0,
): ReadonlyArray<ReadonlyArray<T>> => {
  if (changes.length <= 1 || total(changes) <= limit) return [changes]
  const groups = new Map<string, Array<T>>()
  for (const change of changes) {
    const segments = change.path.split("/")
    const key = segments.length > depth + 1 ? (segments[depth] ?? "") : change.path
    groups.set(key, [...(groups.get(key) ?? []), change])
  }
  const batches: Array<ReadonlyArray<T>> = []
  let current: Array<T> = []
  const flush = () => {
    if (current.length > 0) batches.push(current)
    current = []
  }
  for (const group of groups.values()) {
    if (total(group) > limit) {
      flush()
      batches.push(...partition(group, limit, depth + 1))
    } else {
      if (total(current) + total(group) > limit) flush()
      current.push(...group)
    }
  }
  flush()
  return batches
}

/** What an API commit produced. */
export interface ApiCommitted {
  readonly commits: ReadonlyArray<string>
  readonly files: number
  /** True when the repository was empty and its first file went through the contents endpoint. */
  readonly bootstrapped: boolean
  readonly createdBranch: boolean
  /** True when the change set was too large for one request and went in several commits. */
  readonly split: boolean
}

/** What an API commit needs. */
export interface ApiCommit {
  readonly repo: string
  readonly branch: string
  readonly message: Message
  /** Stages the named paths again, after the hook may have changed them. */
  readonly restage: Effect.Effect<void, GitFailed | StateIo, Git>
  readonly limit?: number
}

const toText = (message: Message) =>
  message.body === undefined ? message.headline : `${message.headline}\n\n${message.body}`

/** Local and remote state must agree before a commit is appended to the remote branch. */
const checkRemote = (repo: string, branch: string) =>
  Effect.gen(function* () {
    const local = yield* headCommit
    const remote = yield* branchHead(repo, branch)
    if (remote !== undefined) {
      if (local !== remote)
        return yield* new RemoteMismatch({
          reason: `${branch} is at ${local?.slice(0, 7) ?? "no commit"} locally and ${remote.slice(0, 7)} on GitHub; API commits append to the GitHub branch`,
        })
      return { remote, empty: false, createdBranch: false }
    }
    if (yield* repoIsEmpty(repo)) {
      if (local !== undefined)
        return yield* new RemoteMismatch({
          reason: `the GitHub repository is empty but ${branch} has local commits; the first commit must be made through the API from an empty branch`,
        })
      return { remote: undefined, empty: true, createdBranch: false }
    }
    if (local === undefined)
      return yield* new RemoteMismatch({
        reason: `${branch} has no commit locally and does not exist on GitHub; check out an existing branch`,
      })
    yield* createBranch(repo, branch, local)
    return { remote: local, empty: false, createdBranch: true }
  })

/**
 * Commits the staged changes through GitHub: the repository's pre-commit hook runs and the paths
 * are staged again, then createCommitOnBranch appends one commit per batch to the remote branch (or
 * the contents endpoint creates the first file of an empty repository), and the local branch is
 * moved to the last commit. The index already holds the new tree, so only HEAD moves.
 */
export const commitViaApi = (request: ApiCommit) =>
  Effect.gen(function* () {
    const { repo, branch, message } = request

    const hook = yield* Git.use((service) =>
      service.run(["hook", "run", "--ignore-missing", "pre-commit"]),
    )
    if (hook.code !== 0)
      return yield* new HookFailed({
        output: `${hook.stderr}\n${hook.stdout}`.trim().split("\n").slice(-20).join("\n"),
      })
    yield* request.restage

    const changes = yield* stagedChanges
    const sized = yield* Effect.forEach(changes, (change) =>
      change.kind === "delete"
        ? Effect.succeed({ ...change, contents: "", size: change.path.length + 64 })
        : Git.use((service) => service.blob(change.oid)).pipe(
            Effect.map((bytes) => {
              const contents = Buffer.from(bytes).toString("base64")
              return { ...change, contents, size: contents.length + change.path.length + 64 }
            }),
          ),
    )
    const limit = request.limit ?? MAX_REQUEST_BYTES
    const batches = partition(sized, limit)
    for (const batch of batches)
      if (batch.length === 1 && total(batch) > limit)
        return yield* new UnsupportedChange({
          path: batch[0]?.path ?? "",
          reason: `it is larger than ${Math.floor(limit / 1024 / 1024)} MiB as one request`,
        })

    // The branch is created on GitHub only now that the hook passed and the change set is known
    // to fit through the API.
    const state = yield* checkRemote(repo, branch)

    let expected = state.remote
    let bootstrapped: boolean = false
    const commits: Array<string> = []
    const publish = Effect.gen(function* () {
      for (const [index, batch] of batches.entries()) {
        const headline =
          batches.length === 1
            ? message.headline
            : `${message.headline} (${index + 1}/${batches.length})`
        const named = { ...message, headline }
        let rest = batch
        if (expected === undefined) {
          const first = batch.find((change) => change.kind === "add")
          if (first === undefined)
            return yield* new UnsupportedChange({
              path: batch[0]?.path ?? "",
              reason: "the first commit of an empty repository must add a file",
            })
          const sha = yield* putFirstFile(repo, {
            path: first.path,
            contents: first.contents,
            message: toText(named),
            branch,
          })
          if ((yield* branchHead(repo, branch)) !== sha)
            return yield* new RemoteMismatch({
              reason: `GitHub created the first commit ${sha.slice(0, 7)} but not on the branch ${branch}`,
            })
          expected = sha
          bootstrapped = true
          commits.push(sha)
          rest = batch.filter((change) => change !== first)
          if (rest.length === 0) continue
        }
        expected = yield* createCommitOnBranch({
          branch: { repositoryNameWithOwner: repo, branchName: branch },
          expectedHeadOid: expected,
          message: named,
          fileChanges: {
            additions: rest
              .filter((change) => change.kind !== "delete")
              .map(({ path, contents }) => ({ path, contents })),
            deletions: rest
              .filter((change) => change.kind === "delete")
              .map(({ path }) => ({ path })),
          },
        })
        commits.push(expected)
      }

      const last = commits.at(-1)
      if (last !== undefined) {
        yield* git(["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`])
        yield* git(["reset", "--soft", last])
      }
    })
    // Whatever fails once GitHub holds a commit must say so, with the way back to a clean state.
    yield* publish.pipe(
      Effect.catch((error) =>
        Effect.fail(
          commits.length === 0
            ? error
            : new PartialCommit({ commits, branch, reason: describeFailure(error).message }),
        ),
      ),
    )
    return {
      commits,
      files: changes.length,
      bootstrapped,
      createdBranch: state.createdBranch,
      split: batches.length > 1,
    } satisfies ApiCommitted
  })
