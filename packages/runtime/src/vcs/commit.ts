import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { pathProblem } from "../domain/paths.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { AgentIdentity, CloudAuthor, NothingToCommit, StagedOutsideScope } from "./errors.ts"
import { currentBranch, git, gitMaybe, gitPaths } from "./git.ts"
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

const validatedPaths = (paths: ReadonlyArray<string>) =>
  Effect.forEach(paths, (path) => {
    const clean = path.replace(/\/+$/, "")
    const problem = pathProblem(clean)
    if (problem !== undefined)
      return Effect.fail(
        new Usage({
          message: `Invalid path "${path}": ${problem}`,
          hint: "Name files or folders relative to the project root.",
        }),
      )
    // The state lives on its own branch; a work branch that carried it could conflict with that
    // branch when the two are merged or stacked.
    return clean === STATE_DIRECTORY || clean.startsWith(`${STATE_DIRECTORY}/`)
      ? Effect.fail(
          new Usage({
            message: `"${path}" is Intent state, which is committed on the state branch by the holyagent commands`,
            hint: "Commit only work files with `vcs commit`; Intent state never goes on a work branch.",
          }),
        )
      : Effect.succeed(clean)
  })

/**
 * Commits exactly the named paths with the configured git identity (an agent's is refused). In a
 * claude.ai cloud session the author is checked instead and the committer is the platform's. Intent
 * state is not part of it: it is committed on the state branch as it changes, and a path under
 * `.holyagent/` is refused. Changes staged beforehand outside the named paths refuse the commit, so
 * the commit is never wider than the request. The repository's own hooks run, the commit-msg hook
 * among them.
 */
export const commit = (request: CommitRequest) =>
  Effect.gen(function* () {
    const { message } = request
    yield* request.cloud ? requireOwnAuthor : requireOwnIdentity
    const scope = yield* validatedPaths(request.paths)

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
