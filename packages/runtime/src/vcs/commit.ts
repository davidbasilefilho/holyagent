import { join, relative } from "node:path"

import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { resolveIntent } from "../cli/intent.ts"
import { pathProblem } from "../domain/paths.ts"
import { io } from "../state/files.ts"
import { intentFolder } from "../state/layout.ts"
import { readOpenState } from "../state/store.ts"
import { commitViaApi } from "./api.ts"
import { detect, saveDetection } from "./detect.ts"
import { NothingToCommit, RemoteMismatch, StagedOutsideScope } from "./errors.ts"
import { currentBranch, git, gitPaths, repoSlug } from "./git.ts"
import type { Message } from "./message.ts"
import type { Detection } from "./model.ts"
import { verifyIfReadable } from "./verify.ts"

/** What `vcs commit` was asked to do. */
export interface CommitRequest {
  readonly directory: string
  readonly root: string
  readonly message: Message
  readonly paths: ReadonlyArray<string>
}

/** The outcome of `vcs commit`. */
export interface Committed {
  readonly detection: Detection
  readonly branch: string
  readonly commits: ReadonlyArray<string>
  readonly files: number
  /** The Intent state folder that rode along, when it had changed. */
  readonly state?: string
  readonly extra: Readonly<Record<string, unknown>>
}

const inScope = (scope: ReadonlyArray<string>, path: string) =>
  scope.some((entry) => path === entry || path.startsWith(`${entry}/`))

/** The relative folder of the Intent in use, when there is one and its files changed. */
const changedIntentFolder = (directory: string, root: string) =>
  readOpenState(directory).pipe(
    Effect.flatMap(resolveIntent),
    Effect.map((intent): string | undefined => relative(root, intentFolder(directory, intent))),
    Effect.catchTag("NoActiveIntent", () => Effect.succeed(undefined)),
    Effect.flatMap((folder) =>
      folder === undefined
        ? Effect.succeed(undefined)
        : gitPaths(["status", "--porcelain", "--untracked-files=all"], [folder]).pipe(
            Effect.map((status) => (status === "" ? undefined : folder)),
          ),
    ),
  )

const stagedPaths = git(["diff", "--cached", "--name-only", "--no-renames", "-z"]).pipe(
  Effect.map((names) => names.split("\0").filter((path) => path !== "")),
)

/** Stages again the files a hook may have rewritten: the staged ones that still exist. */
const restage = (root: string) =>
  stagedPaths.pipe(
    Effect.flatMap((staged) =>
      Effect.filter(staged, (path) => io(path, () => Bun.file(join(root, path)).exists())),
    ),
    Effect.flatMap((existing) =>
      existing.length === 0 ? Effect.void : gitPaths(["add"], existing).pipe(Effect.asVoid),
    ),
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
 * Commits exactly the named paths plus the Intent state folder when it changed, through the path
 * the detection chose. Changes staged beforehand outside that scope refuse the commit, so the
 * commit is never wider than the request.
 */
export const commit = (request: CommitRequest) =>
  Effect.gen(function* () {
    const { directory, root, message } = request
    const { detection } = yield* detect(directory, root, false)
    const declared = yield* validatedPaths(request.paths)
    const state = yield* changedIntentFolder(directory, root)
    const scope = state === undefined ? declared : [...declared, state]

    const alreadyStaged = yield* stagedPaths
    const outside = alreadyStaged.filter((path) => !inScope(scope, path))
    if (outside.length > 0) return yield* new StagedOutsideScope({ paths: outside })

    yield* gitPaths(["add", "-A"], scope)
    const files = (yield* stagedPaths).length
    if (files === 0) return yield* new NothingToCommit({ paths: scope })

    const branch = yield* currentBranch
    const common = { detection, branch, files, ...(state === undefined ? {} : { state }) }

    if (detection.path !== "api") {
      const sha = yield* commitWithGit(detection, message)
      if (!detection.verified && detection.pending === undefined && detection.owner !== undefined)
        yield* saveDetection(directory, { ...detection, pending: sha })
      return { ...common, commits: [sha], extra: {} } satisfies Committed
    }

    const repo = repoSlug(detection.remote)
    if (repo === undefined)
      return yield* new RemoteMismatch({
        reason:
          "origin is not set or does not name a GitHub repository, so there is no remote to commit to",
      })
    const done = yield* commitViaApi({ repo, branch, message, restage: restage(root) })
    const last = done.commits.at(-1)
    const note =
      last === undefined || detection.verified
        ? undefined
        : yield* verifyIfReadable(directory, detection, repo, last)
    return {
      ...common,
      files: done.files,
      commits: done.commits,
      extra: {
        split: done.split ? true : undefined,
        bootstrapped: done.bootstrapped ? true : undefined,
        createdBranch: done.createdBranch ? true : undefined,
        note,
      },
    } satisfies Committed
  })

const commitWithGit = (detection: Detection, message: Message) => {
  const owner = detection.path === "git-owner" ? detection.owner : undefined
  const name = owner?.name ?? owner?.login ?? ""
  const identity =
    owner === undefined
      ? {}
      : {
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: owner.email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: owner.email,
        }
  return git(
    [
      ...(owner === undefined
        ? []
        : ["-c", `user.name=${name}`, "-c", `user.email=${owner.email}`]),
      "commit",
      ...(owner === undefined ? [] : ["--no-gpg-sign"]),
      "-m",
      message.headline,
      ...(message.body === undefined ? [] : ["-m", message.body]),
    ],
    identity,
  ).pipe(Effect.andThen(git(["rev-parse", "HEAD"])))
}
