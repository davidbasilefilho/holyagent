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

/** The git identity belongs to an agent, so a commit with it would not be the user's. */
export class AgentIdentity extends Data.TaggedError("AgentIdentity")<{
  readonly identity: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `The git identity ${this.identity} looks like an agent's, so the commit would not be the user's`
  }
}

/**
 * In a claude.ai cloud session the commit author is missing or looks like an agent's, so the commit
 * would not be the user's. The committer is the platform's Claude there and is not checked.
 */
export class CloudAuthor extends Data.TaggedError("CloudAuthor")<{
  readonly author: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `The commit author ${this.author} is missing or looks like an agent's, so the commit would not be the user's`
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

/** The remote is unusable for a pull request. */
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

/** The tags of this module's failures that mean the current state refuses the step (exit 3). */
export const VCS_REFUSED_ERRORS: ReadonlyArray<string> = [
  "AgentIdentity",
  "CloudAuthor",
  "MessageRefused",
  "NothingToCommit",
  "StagedOutsideScope",
  "RemoteMismatch",
  "DetachedHead",
]

/** What to do about each failure of this module. */
export const VCS_HINTS: Readonly<Record<string, string>> = {
  GitFailed:
    "Fix what git reports above (a failing commit hook included), then run the command again.",
  GitHubFailed:
    "Check `gh auth status`, the repository's access and that the branch is pushed; the message names the call.",
  AgentIdentity:
    "Set the user's own identity for this repository: `git config user.name <name>` and `git config user.email <email>`, then commit again.",
  CloudAuthor:
    "Set the user as the author of this clone, once: call the GitHub connector's get_me (mcp__github__get_me), run `holyagent vcs identity --name <name> --email <id>+<login>@users.noreply.github.com` with the name, id and login it returns (the login when the name is empty), then commit again. The committer stays Claude, which keeps the branch commits Verified.",
  MessageRefused:
    "Reword the message to say what changed and why; a project whose domain uses the word can list it in vcs.allowWords of .holyagent/config.json.",
  NothingToCommit: "Check the paths; commit only after the files changed.",
  StagedOutsideScope: "Unstage them with `git restore --staged <path>` or name them in the commit.",
  RemoteMismatch: "Set origin to the GitHub repository (`git remote add origin <url>`) and retry.",
  DetachedHead: "Check out or create a branch with `git switch -c <name>`.",
}
