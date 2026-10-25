import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { detect } from "./detect.ts"
import { RemoteMismatch } from "./errors.ts"
import { git, repoSlug, validBranch } from "./git.ts"
import { createBranch } from "./repo.ts"

/** The outcome of `vcs branch`. */
export interface Branched {
  readonly branch: string
  readonly from: string
  /** True when the branch also exists on GitHub already (the api path). */
  readonly remote: boolean
}

/**
 * Creates a branch at a ref (default: HEAD) and switches to it. On the api path the branch is also
 * created on GitHub first, because API commits append to a branch that exists there; on the git
 * paths `vcs push` publishes it later.
 */
export const branch = (directory: string, root: string, name: string, from: string | undefined) =>
  Effect.gen(function* () {
    yield* validBranch(name)
    if (from?.startsWith("-"))
      return yield* new Usage({
        message: `--from "${from}" looks like an option`,
        hint: "Name a branch, tag or commit.",
      })
    const { detection } = yield* detect(directory, root, false)
    const sha = yield* git(["rev-parse", "--verify", `${from ?? "HEAD"}^{commit}`])
    const apiPath = detection.path === "api"
    if (apiPath) {
      const repo = repoSlug(detection.remote)
      if (repo === undefined)
        return yield* new RemoteMismatch({ reason: "origin does not name a GitHub repository" })
      yield* createBranch(repo, name, sha)
    }
    yield* git(["switch", "--no-track", "-c", name, sha])
    return { branch: name, from: sha.slice(0, 7), remote: apiPath } satisfies Branched
  })
