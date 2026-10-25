import { join, relative } from "node:path"

import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { resolveIntent } from "../cli/intent.ts"
import { pathProblem } from "../domain/paths.ts"
import { intentFolder } from "../state/layout.ts"
import { readOpenState } from "../state/store.ts"
import { AgentIdentity, NothingToCommit, StagedOutsideScope } from "./errors.ts"
import { currentBranch, git, gitMaybe, gitPaths } from "./git.ts"
import type { Message } from "./message.ts"

/** What `vcs commit` was asked to do. */
export interface CommitRequest {
  readonly directory: string
  readonly root: string
  readonly message: Message
  readonly paths: ReadonlyArray<string>
}

/** The outcome of `vcs commit`. */
export interface Committed {
  readonly branch: string
  readonly commit: string
  readonly files: number
  /** The Intent state that rode along, when it had changed. */
  readonly state?: ReadonlyArray<string>
}

const inScope = (scope: ReadonlyArray<string>, path: string) =>
  scope.some((entry) => path === entry || path.startsWith(`${entry}/`))

/** True for the identity an agent runtime configures, which never belongs to the user. */
export const looksLikeAgent = (identity: { readonly name: string; readonly email: string }) =>
  identity.email.toLowerCase() === "noreply@anthropic.com" ||
  /^claude\b/i.test(identity.name.trim())

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
 * The Intent state that rode along with a commit, relative to the project: the folder of the Intent
 * in use, else (a worktree where no Intent is in use, with several open) the whole Intents folder
 * of the worktree the command runs in. Only what changed is returned.
 */
const changedIntentState = (directory: string, root: string) =>
  readOpenState(directory).pipe(
    Effect.flatMap(resolveIntent),
    Effect.map((intent) => relative(root, intentFolder(directory, intent))),
    Effect.catchTag("NoActiveIntent", () =>
      Effect.succeed(relative(root, join(directory, "intents"))),
    ),
    Effect.flatMap((folder) =>
      gitPaths(["status", "--porcelain", "--untracked-files=all"], [folder]).pipe(
        Effect.map((status) => (status === "" ? [] : [folder])),
      ),
    ),
  )

const stagedPaths = git(["diff", "--cached", "--name-only", "--no-renames", "-z"]).pipe(
  Effect.map((names) => names.split("\0").filter((path) => path !== "")),
)

const validatedPaths = (paths: ReadonlyArray<string>) =>
  Effect.forEach(paths, (path) => {
    const clean = path.replace(/\/+$/, "")
    const problem = pathProblem(clean)
    return problem === undefined
      ? Effect.succeed(clean)
      : Effect.fail(
          new Usage({
            message: `Invalid path "${path}": ${problem}`,
            hint: "Name files or folders relative to the project root.",
          }),
        )
  })

/**
 * Commits exactly the named paths plus the Intent state of this worktree when it changed, with the
 * configured git identity (an agent's is refused). Changes staged beforehand outside that scope
 * refuse the commit, so the commit is never wider than the request. The repository's own hooks run,
 * the commit-msg hook among them.
 */
export const commit = (request: CommitRequest) =>
  Effect.gen(function* () {
    const { directory, root, message } = request
    yield* requireOwnIdentity
    const declared = yield* validatedPaths(request.paths)
    const state = yield* changedIntentState(directory, root)
    const scope = [...declared, ...state]

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
    return {
      branch,
      commit: sha,
      files,
      ...(state.length === 0 ? {} : { state }),
    } satisfies Committed
  })
