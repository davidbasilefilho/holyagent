import { Effect } from "effect"

import { gitMaybe } from "../vcs/git.ts"
import { inCloudSession } from "../vcs/identity.ts"
import type { Call } from "./types.ts"

const REFLOG_MOVE = /^checkout: moving from (\S+) to (\S+)$/

/** What may reach the notice, the model's context: a plain name with no shell or markup characters. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** Whether a name is a local branch git accepts as written, with only characters of SAFE_BRANCH. */
const safeBranch = (name: string) =>
  SAFE_BRANCH.test(name)
    ? gitMaybe(["check-ref-format", "--branch", name]).pipe(Effect.map((out) => out === name))
    : Effect.succeed(false)

/**
 * The local branch the checkout started on: the oldest move of the HEAD reflog (`checkout: moving
 * from <source> to <destination>`) whose destination is an existing branch, as when the platform
 * clones and runs `checkout -b <assigned>`, else whose source is one, as when a clone that already
 * sat on the assigned branch was detached. Undefined when the reflog names none.
 */
const startBranch = Effect.gen(function* () {
  const log = (yield* gitMaybe(["reflog", "show", "--format=%gs", "HEAD"])) ?? ""
  const moves = log
    .split("\n")
    .map((line) => REFLOG_MOVE.exec(line))
    .filter((move) => move !== null)
    .reverse()
  for (const move of moves)
    for (const name of [move[2], move[1]])
      if (
        name !== undefined &&
        (yield* gitMaybe(["show-ref", "--verify", "--quiet", `refs/heads/${name}`])) !== undefined
      )
        return name
  return undefined
})

/**
 * The branch to name in the notice: the start branch, else the remote's default branch, else
 * `main`, each only when it passes the allowlist, since a branch name is outside text.
 */
const returnBranch = (start: string | undefined) =>
  Effect.gen(function* () {
    if (start !== undefined && (yield* safeBranch(start))) return start
    const remote = (yield* gitMaybe([
      "symbolic-ref",
      "--short",
      "-q",
      "refs/remotes/origin/HEAD",
    ]))?.replace(/^origin\//, "")
    return remote !== undefined && (yield* safeBranch(remote)) ? remote : "main"
  })

/**
 * The notice for a claude.ai cloud session whose primary checkout (the main work tree, not a linked
 * one) is on a detached HEAD or on a named branch other than the one it started on, or undefined
 * for every other case, a local session and any git failure included. The session panel shows that
 * checkout against the assigned branch, so commits there show a stray diff and offer a bogus PR;
 * the notice says so and how to switch back. It only informs and blocks nothing.
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
        const current = yield* gitMaybe(["symbolic-ref", "--short", "-q", "HEAD"])
        const start = yield* startBranch
        if (current !== undefined && (start === undefined || current === start)) return undefined
        const moved =
          current === undefined ? "is on a detached HEAD" : "moved off the branch it started on"
        const branch = yield* returnBranch(start)
        return `The primary checkout of this cloud session ${moved}, so the session panel shows its diff against the assigned branch as a stray change and offers a PR for it. Return it with \`git switch ${branch}\`, and do work and review checkouts in a git worktree.`
      }).pipe(Effect.provide(call.vcs))
    : Effect.succeed(undefined)
