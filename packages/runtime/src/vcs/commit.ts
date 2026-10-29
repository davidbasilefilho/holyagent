import { sep } from "node:path"

import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { pathProblem, toPosix } from "../domain/paths.ts"
import { STATE_DIRECTORY, TRACKED_STATE_PATHSPEC } from "../state/layout.ts"
import { parseStateMode, STATE_MODE_KEY, type StateMode } from "../state/mode.ts"
import {
  AgentIdentity,
  CloudAuthor,
  GitFailed,
  NothingToCommit,
  StagedOutsideScope,
} from "./errors.ts"
import { currentBranch, Git, git, gitMaybe, gitPaths } from "./git.ts"
import { looksLikeAgent, parseIdent } from "./identity.ts"
import type { Message } from "./message.ts"

/** What `vcs commit` was asked to do. */
export interface CommitRequest {
  readonly message: Message
  readonly paths: ReadonlyArray<string>
  /** True in a claude.ai cloud session, where the author is checked and the committer is not. */
  readonly cloud: boolean
}

/** The outcome of `vcs commit`. */
export interface Committed {
  readonly branch: string
  readonly commit: string
  readonly files: number
}

const inScope = (scope: ReadonlyArray<string>, path: string) =>
  scope.some((entry) => path === entry || path.startsWith(`${entry}/`))

/** Refuses to commit as an agent: the identity git would use must be the user's own. */
const requireOwnIdentity = Effect.gen(function* () {
  const identity = {
    name: (yield* gitMaybe(["config", "user.name"])) ?? "",
    email: (yield* gitMaybe(["config", "user.email"])) ?? "",
  }
  if (looksLikeAgent(identity))
    return yield* new AgentIdentity({ identity: `${identity.name} <${identity.email}>` })
})

/**
 * In a claude.ai cloud session, refuses a commit whose author is missing or looks like an agent's.
 * The author is what git resolves for the commit (`GIT_AUTHOR_*`, else `author.*`, else `user.*`),
 * and the committer, which is the platform's Claude there, is left alone.
 */
const requireOwnAuthor = Effect.gen(function* () {
  const line = yield* gitMaybe(["var", "GIT_AUTHOR_IDENT"])
  const author = line === undefined ? undefined : parseIdent(line)
  if (author === undefined) return yield* new CloudAuthor({ author: "(none set)" })
  if (author.name === "" || author.email === "" || looksLikeAgent(author))
    return yield* new CloudAuthor({ author: `${author.name} <${author.email}>` })
})

const stagedPaths = git(["diff", "--cached", "--name-only", "--no-renames", "-z"]).pipe(
  Effect.map((names) => names.split("\0").filter((path) => path !== "")),
)

/**
 * The commit scope for the named paths: each path in git's `/` form without a trailing slash, or a
 * `Usage` failure for one that is not a portable project path or that is Intent state while the
 * state mode keeps it out of work commits (every mode but `work`). A path written with the
 * platform's separator (`src\a.ts` on Windows) names the same file as git's `src/a.ts`, so it is
 * converted before the checks. The separator is a parameter so a test can stand in for Windows.
 */
export const commitScope = (
  paths: ReadonlyArray<string>,
  separator: string = sep,
  mode: StateMode = "branch",
) =>
  Effect.forEach(paths, (path) => {
    const clean = toPosix(path, separator).replace(/\/+$/, "")
    const problem = pathProblem(clean)
    if (problem !== undefined)
      return Effect.fail(
        new Usage({
          message: `Invalid path "${path}": ${problem}`,
          hint: "Name files or folders relative to the project root.",
        }),
      )
    // Git on a case-insensitive file system treats `.HolyAgent` as the same folder.
    const folded = clean.toLowerCase()
    const state = folded === STATE_DIRECTORY || folded.startsWith(`${STATE_DIRECTORY}/`)
    if (!state || mode === "work") return Effect.succeed(clean)
    // On the state branch a work branch that carried the state could conflict with it when the two
    // are merged or stacked; in the local mode no commit carries it.
    return Effect.fail(
      new Usage({
        message:
          mode === "local"
            ? `"${path}" is Intent state, which this clone keeps out of git (state mode local)`
            : `"${path}" is Intent state, which is committed on the state branch by the holyagent commands`,
        hint:
          mode === "local"
            ? "Commit only work files with `vcs commit`; `holyagent state mode work` would put the state in the work commits."
            : "Commit only work files with `vcs commit`; Intent state never goes on a work branch in the branch mode.",
      }),
    )
  })

/** The state mode of this clone, from git config; an unknown value is a usage failure. */
const stateMode = gitMaybe(["config", "--get", STATE_MODE_KEY]).pipe(
  Effect.flatMap(parseStateMode),
  Effect.mapError(
    (error) =>
      new Usage({
        message: error.message,
        hint: `Set git config ${STATE_MODE_KEY} to branch, work or local, or unset it.`,
      }),
  ),
)

/**
 * The state files git sees changed (an ignored file is not one) and the project's settings are not:
 * the work mode stages the former with the work, and the settings only when the caller names them.
 */
const changedState = Effect.gen(function* () {
  const args = [
    "status",
    "--porcelain",
    "-z",
    "--no-renames",
    "--untracked-files=all",
    "--",
    ...TRACKED_STATE_PATHSPEC,
  ]
  // Not through `git()`, which trims the leading space of the first status code.
  const ran = yield* Git.use((service) => service.run(args))
  if (ran.code !== 0)
    return yield* new GitFailed({ args, code: ran.code, output: ran.stderr.trim() })
  return ran.stdout
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
})

/**
 * In the local mode, refuses a commit while git tracks state files, which the exclude entry cannot
 * hide.
 */
const requireUntrackedState = git(["ls-files", "--", ...TRACKED_STATE_PATHSPEC]).pipe(
  Effect.flatMap((tracked) =>
    tracked === ""
      ? Effect.void
      : Effect.fail(
          new Usage({
            message: `git tracks files under ${STATE_DIRECTORY}/, which state mode local cannot keep out of a commit`,
            hint: "Switch to the work mode with `holyagent state mode work`, or untrack the files.",
          }),
        ),
  ),
)

/**
 * Commits exactly the named paths with the configured git identity (an agent's is refused). In a
 * claude.ai cloud session the author is checked instead and the committer is the platform's. In the
 * default `branch` mode Intent state is not part of it: it is committed on the state branch as it
 * changes, and a path under `.holyagent/` is refused (as in `local`, which commits it nowhere). In
 * the `work` mode the changed state files (not the project's settings) are staged with the work.
 * Changes staged beforehand outside the named paths refuse the commit, so the commit is never wider
 * than the request. The repository's own hooks run, the commit-msg hook among them.
 */
export const commit = (request: CommitRequest) =>
  Effect.gen(function* () {
    const { message } = request
    yield* request.cloud ? requireOwnAuthor : requireOwnIdentity
    const mode = yield* stateMode
    const named = yield* commitScope(request.paths, sep, mode)
    if (mode === "local") yield* requireUntrackedState
    // In the work mode the state rides the work commit: the changed state files join the scope.
    const scope =
      mode === "work" && !named.includes(STATE_DIRECTORY)
        ? [...named, ...(yield* changedState)]
        : named

    const alreadyStaged = yield* stagedPaths
    const outside = alreadyStaged.filter((path) => !inScope(scope, path))
    if (outside.length > 0) return yield* new StagedOutsideScope({ paths: outside })

    yield* gitPaths(["add", "-A"], scope)
    const files = (yield* stagedPaths).length
    if (files === 0) return yield* new NothingToCommit({ paths: scope })

    const branch = yield* currentBranch
    yield* git([
      "commit",
      "-m",
      message.headline,
      ...(message.body === undefined ? [] : ["-m", message.body]),
    ])
    const sha = yield* git(["rev-parse", "HEAD"])
    return { branch, commit: sha, files } satisfies Committed
  })
