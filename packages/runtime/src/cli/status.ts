import { Effect } from "effect"

import { gitMaybe } from "../vcs/git.ts"
import { inCloudSession } from "../vcs/identity.ts"
import type { Call } from "./types.ts"

const REFLOG_MOVE = /^checkout: moving from (.+) to .+$/

/**
 * The branch to switch a detached primary checkout back to: the branch it first moved off (the
 * oldest `checkout: moving from <branch> to …` line of the HEAD reflog that names a local branch),
 * else the remote's default branch, else `main`.
 */
const returnBranch = Effect.gen(function* () {
  const log = (yield* gitMaybe(["reflog", "show", "--format=%gs", "HEAD"])) ?? ""
  const moves = log
    .split("\n")
    .map((line) => REFLOG_MOVE.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
    .reverse()
  for (const name of moves)
    if ((yield* gitMaybe(["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) !== undefined)
      return name
  const remote = yield* gitMaybe(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
  return remote?.replace(/^origin\//, "") || "main"
})

/**
 * The notice for a claude.ai cloud session whose primary checkout (the main work tree, not a linked
 * one) is on a detached HEAD, or undefined for every other case, a local session and any git
 * failure included. The session panel shows that checkout against the assigned branch, so a
 * detached HEAD ahead of it shows a stray diff and offers a bogus PR; the notice says so and how to
 * switch back. It only informs and blocks nothing.
 */
export const cloudCheckoutNotice = (
  call: Pick<Call, "env" | "vcs">,
): Effect.Effect<string | undefined> =>
  inCloudSession(call.env)
    ? Effect.gen(function* () {
        const dirs = (yield* gitMaybe([
          "rev-parse",
          "--path-format=absolute",
          "--git-dir",
          "--git-common-dir",
        ]))?.split("\n")
        if (dirs?.length !== 2 || dirs[0] !== dirs[1]) return undefined
        if ((yield* gitMaybe(["symbolic-ref", "-q", "HEAD"])) !== undefined) return undefined
        const branch = yield* returnBranch
        return `The primary checkout of this cloud session is on a detached HEAD, so the session panel shows its diff against the assigned branch as a stray change and offers a PR for it. Return it with \`git switch ${branch}\`, and do work and review checkouts in a git worktree.`
      }).pipe(Effect.provide(call.vcs))
    : Effect.succeed(undefined)
