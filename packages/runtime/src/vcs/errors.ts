import { Data } from "effect"

/** A git command exited with a failure. */
export class GitFailed extends Data.TaggedError("GitFailed")<{
  readonly args: ReadonlyArray<string>
  readonly code: number
  readonly output: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `git ${this.args.join(" ")} exited ${this.code}: ${this.output}`
  }
}

/** A GitHub call failed or answered with something unexpected. */
export class GitHubFailed extends Data.TaggedError("GitHubFailed")<{
  readonly what: string
  readonly status: number | undefined
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`
    return `GitHub ${this.what} failed${status}: ${this.reason}`
  }
}

/** No GitHub credential works and the git identity belongs to an agent, so no commit is the user's. */
export class NoCredential extends Data.TaggedError("NoCredential")<{
  readonly identity: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `No GitHub credential works (${this.reason}) and the git identity ${this.identity} looks like an agent, so commits would not be the user's`
  }
}

/** A commit message or PR text talks about the user or the agent process. */
export class MessageRefused extends Data.TaggedError("MessageRefused")<{
  readonly phrases: ReadonlyArray<string>
}> {
  /** The description shown to the user. */
  override get message() {
    return `The message contains ${this.phrases.map((phrase) => `"${phrase}"`).join(", ")}; a commit message describes the change, not who asked for it or how it was made`
  }
}

/** Nothing is staged for the paths a commit named. */
export class NothingToCommit extends Data.TaggedError("NothingToCommit")<{
  readonly paths: ReadonlyArray<string>
}> {
  /** The description shown to the user. */
  override get message() {
    return `Nothing changed in ${this.paths.join(", ")}`
  }
}

/** The index holds changes outside the paths a commit named. */
export class StagedOutsideScope extends Data.TaggedError("StagedOutsideScope")<{
  readonly paths: ReadonlyArray<string>
}> {
  /** The description shown to the user. */
  override get message() {
    return `Staged changes outside the named paths would join the commit: ${this.paths.join(", ")}`
  }
}

/** A change the createCommitOnBranch mutation cannot carry faithfully. */
export class UnsupportedChange extends Data.TaggedError("UnsupportedChange")<{
  readonly path: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.path} cannot be committed through the GitHub API: ${this.reason}`
  }
}

/** The repository's pre-commit hook failed. */
export class HookFailed extends Data.TaggedError("HookFailed")<{
  readonly output: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `The pre-commit hook failed: ${this.output}`
  }
}

/** The local branch and GitHub disagree about where the branch is, or the remote is unusable. */
export class RemoteMismatch extends Data.TaggedError("RemoteMismatch")<{
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return this.reason
  }
}

/** HEAD is not on a branch. */
export class DetachedHead extends Data.TaggedError("DetachedHead") {
  /** The description shown to the user. */
  override get message() {
    return "HEAD is detached, so there is no branch to commit to"
  }
}

/** The commit on GitHub does not show the author or signature the detected path promises. */
export class VerificationMismatch extends Data.TaggedError("VerificationMismatch")<{
  readonly commit: string
  readonly problems: ReadonlyArray<string>
}> {
  /** The description shown to the user. */
  override get message() {
    return `GitHub shows commit ${this.commit.slice(0, 7)} differently than expected: ${this.problems.join("; ")}`
  }
}

/** The tags of this module's failures that mean the current state refuses the step (exit 3). */
export const VCS_REFUSED_ERRORS: ReadonlyArray<string> = [
  "NoCredential",
  "MessageRefused",
  "NothingToCommit",
  "StagedOutsideScope",
  "UnsupportedChange",
  "HookFailed",
  "RemoteMismatch",
  "DetachedHead",
  "VerificationMismatch",
]

/** What to do about each failure of this module. */
export const VCS_HINTS: Readonly<Record<string, string>> = {
  GitFailed: "Fix what git reports above, then run the command again.",
  GitHubFailed:
    "Check `gh api user`, the repository's access and that the branch is pushed; the message names the call.",
  NoCredential:
    "Run `gh auth login` or set GH_TOKEN, or set git user.name and user.email to the user's own, then `holyagent-runtime vcs detect --refresh`.",
  MessageRefused:
    "Reword the message to say what changed and why; a project whose domain uses the word can list it in vcs.allowWords of .holyagent/config.json.",
  NothingToCommit: "Check the paths; commit only after the files changed.",
  StagedOutsideScope: "Unstage them with `git restore --staged <path>` or name them in the commit.",
  UnsupportedChange:
    "Commit it with git by setting `vcs.api` to false in .holyagent/config.json, then `holyagent-runtime vcs detect --refresh`.",
  HookFailed: "Fix what the hook reports, then run the command again.",
  RemoteMismatch: "Bring the local branch level with GitHub (git pull --ff-only) and retry.",
  DetachedHead: "Check out or create a branch with `holyagent-runtime vcs branch <name>`.",
  VerificationMismatch:
    "The commit stays on GitHub. Fix the credential or git identity, then run `holyagent-runtime vcs detect --refresh`.",
}
