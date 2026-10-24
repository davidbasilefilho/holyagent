import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { detect, saveDetection } from "./detect.ts"
import { RemoteMismatch } from "./errors.ts"
import { currentBranch, git, gitMaybe, isAncestor, repoSlug } from "./git.ts"
import { branchHead } from "./repo.ts"
import { verifyIfReadable, withoutPending } from "./verify.ts"

/** A branch name git accepts as it is written, so it cannot be an option or a forced refspec. */
export const validBranch = (name: string) =>
  gitMaybe(["check-ref-format", "--branch", name]).pipe(
    Effect.filterOrFail(
      // A leading plus is legal in a ref name but makes the push refspec a forced one.
      (checked) => checked === name && !name.startsWith("+"),
      () =>
        new Usage({
          message: `"${name}" is not a plain branch name`,
          hint: "Name branches without a leading dash or plus, such as feature/parser.",
        }),
    ),
  )

/** The outcome of `vcs push`. */
export interface Pushed {
  readonly path: string
  /** False on the api path, where commits are already on GitHub. */
  readonly pushed: boolean
  readonly heads: ReadonlyArray<string>
  /** Set when the first commit could not be read back from GitHub yet. */
  readonly note?: string | undefined
}

/**
 * Pushes the named branches (default: the current one) in one `git push -u origin`, never forced.
 * On the api path commits are already on GitHub, so it only reports the remote heads. The first
 * push after a git commit reads that commit back from GitHub.
 */
export const push = (directory: string, root: string, branches: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { detection } = yield* detect(directory, root, false)
    const targets = branches.length > 0 ? branches : [yield* currentBranch]
    yield* Effect.forEach(targets, validBranch)
    const repo = repoSlug(detection.remote)

    if (detection.path === "api") {
      if (repo === undefined)
        return yield* new RemoteMismatch({ reason: "origin does not name a GitHub repository" })
      const heads = yield* Effect.forEach(targets, (branch) =>
        branchHead(repo, branch).pipe(
          Effect.map((oid) => `${branch}=${oid?.slice(0, 7) ?? "missing"}`),
        ),
      )
      return { path: detection.path, pushed: false, heads } satisfies Pushed
    }

    yield* git(["push", "-u", "origin", ...targets])
    const heads = yield* Effect.forEach(targets, (branch) =>
      git(["rev-parse", "--short", branch]).pipe(Effect.map((sha) => `${branch}=${sha}`)),
    )

    const { pending } = detection
    let note: string | undefined
    if (pending !== undefined && repo !== undefined) {
      const known = (yield* gitMaybe(["cat-file", "-e", pending])) !== undefined
      const reachable = known
        ? (yield* Effect.forEach(targets, (branch) => isAncestor(pending, branch))).includes(true)
        : false
      if (reachable) note = yield* verifyIfReadable(directory, detection, repo, pending)
      else if (!known) yield* saveDetection(directory, withoutPending(detection))
    }
    return { path: detection.path, pushed: true, heads, note } satisfies Pushed
  })
