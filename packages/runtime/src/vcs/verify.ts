import { Effect } from "effect"

import { saveDetection } from "./detect.ts"
import { VerificationMismatch } from "./errors.ts"
import type { Detection } from "./model.ts"
import { readCommit } from "./repo.ts"

/** The detection with the pending read-back dropped. */
export const withoutPending = (detection: Detection): Detection => {
  const { pending: _pending, ...rest } = detection
  return rest
}

/**
 * Reads a commit back from GitHub and checks it against what the detected path promises: the author
 * account is the credential owner and the signature state is the expected one. A match is
 * remembered so only the first commit of a detection is read back; a mismatch fails and is never
 * answered by switching path. Without a known owner there is nothing to compare against.
 */
export const verifyCommit = (directory: string, detection: Detection, repo: string, sha: string) =>
  Effect.gen(function* () {
    if (detection.owner === undefined) return
    const view = yield* readCommit(repo, sha)
    const { verified, reason } = view.commit.verification
    const problems: Array<string> = []
    if (view.author?.login.toLowerCase() !== detection.owner.login.toLowerCase())
      problems.push(
        `author is ${view.author?.login ?? "no GitHub account"}, expected ${detection.owner.login}`,
      )
    if (verified !== detection.signed)
      problems.push(
        `signature is ${verified ? "verified" : `not verified (${reason})`}, expected ${detection.signed ? "verified" : "unsigned"}`,
      )
    if (problems.length > 0) return yield* new VerificationMismatch({ commit: sha, problems })
    yield* saveDetection(directory, { ...withoutPending(detection), verified: true })
  })

/**
 * Like {@link verifyCommit}, but a read that fails (no access, network) is not a verdict: it comes
 * back as a note for the output and the read-back is tried again next time. A mismatch still
 * fails.
 */
export const verifyIfReadable = (
  directory: string,
  detection: Detection,
  repo: string,
  sha: string,
) =>
  verifyCommit(directory, detection, repo, sha).pipe(
    Effect.as(undefined as string | undefined),
    Effect.catchTag("GitHubFailed", (error) =>
      Effect.succeed(`the commit could not be read back from GitHub: ${error.reason}`),
    ),
  )
