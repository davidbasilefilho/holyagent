import { sep } from "node:path"

import { Effect } from "effect"

import { Usage } from "../cli/errors.ts"
import { pathProblem, toPosix } from "../domain/paths.ts"
import { CONFIG_FILE, STATE_DIRECTORY, TRACKED_STATE_PATHSPEC } from "../state/layout.ts"
import { parseStateMode, STATE_MODE_KEY, type StateMode } from "../state/mode.ts"
import {
  AgentIdentity,
  CloudAuthor,
  GitFailed,
  NothingToCommit,
  StagedOutsideScope,
} from "./errors.ts"
import { currentBranch, Git, git, gitMaybe, gitPaths } from "./git.ts"
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

/** True when the git path is a scope entry or inside it; folds case where the file system does. */
const inScope = (scope: ReadonlyArray<string>, path: string, ignoreCase: boolean) => {
  const fold = (text: string) => (ignoreCase ? text.toLowerCase() : text)
  const candidate = fold(path)
  return scope.some((entry) => {
    const folded = fold(entry)
    return candidate === folded || candidate.startsWith(`${folded}/`)
  })
}

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

/**
 * True when the git path is the state folder or inside it, in any letter case when `foldCase` is
 * set: on a file system that ignores case `.HolyAgent` is the same folder, and `core.ignorecase`
 * does not always say so (a clone copied from another system keeps its value).
 */
const inStateFolder = (path: string, foldCase: boolean) => {
  const folded = foldCase ? path.toLowerCase() : path
  return folded === STATE_DIRECTORY || folded.startsWith(`${STATE_DIRECTORY}/`)
}

/** True when the git path is the project's settings file in the state folder, in any case. */
const isConfigFile = (path: string) => path.toLowerCase() === `${STATE_DIRECTORY}/${CONFIG_FILE}`

/** A first segment shaped like an NTFS 8.3 short name: up to six characters, `~`, digits. */
const SHORT_NAME = /^[^/~]{1,6}~\d+$/

/**
 * The first segments of the paths that look like an 8.3 short name. Windows resolves such a name to
 * a folder whose long form cannot be known from the text: `HOLYAG~1` is `.holyagent`, and after
 * several collisions it is a hashed name (`HOA3F2~1`) that matches no pattern of the long name. The
 * state folder reached through one would pass the checks by name, so a name of this shape is
 * refused unless it is a real entry of the work tree.
 */
const shortNames = (paths: ReadonlyArray<string>, separator: string) => [
  ...new Set(
    paths
      .map((path) => toPosix(path, separator).split("/")[0] ?? "")
      .filter((name) => SHORT_NAME.test(name)),
  ),
]

/**
 * Which of the names are real entries of the work tree (a tracked file or folder, or one git sees
 * untracked), not an alias for another name. A listing from git holds long names only, so an 8.3
 * alias is never in it.
 */
const realEntries = (names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) =>
    gitPaths(["ls-files", "-z", "--cached", "--others", "--directory"], [name]).pipe(
      Effect.map((listing) => (listing === "" ? [] : [name])),
    ),
  ).pipe(Effect.map((found) => new Set(found.flat())))

/** True when `core.ignorecase` is on: the file system treats names that differ in case as one. */
const ignoresCase = gitMaybe(["config", "--type=bool", "--get", "core.ignorecase"]).pipe(
  Effect.map((value) => value === "true"),
)

/**
 * The commit scope for the named paths: each path in git's `/` form without a trailing slash, or a
 * `Usage` failure for one that is not a portable project path or that is Intent state while the
 * state mode keeps it out of work commits (every mode but `work`). A path written with the
 * platform's separator (`src\a.ts` on Windows) names the same file as git's `src/a.ts`, so it is
 * converted before the checks. The separator is a parameter so a test can stand in for Windows.
 * Outside the `work` mode the state folder is refused in any letter case, since a file system that
 * ignores case may not say so in `core.ignorecase`; in the `work` mode a path is matched whatever
 * its case only where the file system ignores case (`ignoreCase`) and comes back in the folder's
 * own case. A first segment shaped like an 8.3 short name (`HOLYAG~1`, a hashed `HOA3F2~1`) is
 * refused in every mode unless `existing` names it as a real entry of the work tree.
 */
export const commitScope = (
  paths: ReadonlyArray<string>,
  separator: string = sep,
  mode: StateMode = "branch",
  ignoreCase: boolean = false,
  existing: ReadonlySet<string> = new Set(),
) =>
  Effect.forEach(paths, (path) => {
    const clean = toPosix(path, separator).replace(/\/+$/, "")
    const problem = pathProblem(clean)
    if (problem !== undefined)
      return Effect.fail(
        new Usage({
          message: `Invalid path "${path}": ${problem}`,
          hint: "Name files or folders relative to the project root.",
        }),
      )
    const first = clean.split("/")[0] ?? ""
    if (SHORT_NAME.test(first) && !existing.has(first))
      return Effect.fail(
        new Usage({
          message: `Invalid path "${path}": "${first}" looks like the Windows short name of a folder, which could be the ${STATE_DIRECTORY} state folder`,
          hint: "Name the folder by its full name, or leave Intent state out of `vcs commit`.",
        }),
      )
    if (!inStateFolder(clean, ignoreCase || mode !== "work")) return Effect.succeed(clean)
    if (mode === "work")
      return Effect.succeed(`${STATE_DIRECTORY}${clean.slice(STATE_DIRECTORY.length)}`)
    // On the state branch a work branch that carried the state could conflict with it when the two
    // are merged or stacked; in the local mode no commit carries it.
    return Effect.fail(
      new Usage({
        message:
          mode === "local"
            ? `"${path}" is Intent state, which this clone keeps out of git (state mode local)`
            : `"${path}" is Intent state, which is committed on the state branch by the holyagent commands`,
        hint:
          mode === "local"
            ? "Commit only work files with `vcs commit`; `holyagent state mode work` would put the state in the work commits."
            : "Commit only work files with `vcs commit`; Intent state never goes on a work branch in the branch mode.",
      }),
    )
  })

/** The state mode of this clone, from git config; an unknown value is a usage failure. */
const stateMode = gitMaybe(["config", "--get", STATE_MODE_KEY]).pipe(
  Effect.flatMap(parseStateMode),
  Effect.mapError(
    (error) =>
      new Usage({
        message: error.message,
        hint: `Set git config ${STATE_MODE_KEY} to branch, work or local, or unset it.`,
      }),
  ),
)

/**
 * The state files git sees changed (an ignored file is not one) and the project's settings are not:
 * the work mode stages the former with the work, and the settings only when the caller names them.
 */
const changedState = Effect.gen(function* () {
  const args = [
    "status",
    "--porcelain",
    "-z",
    "--no-renames",
    "--untracked-files=all",
    "--",
    ...TRACKED_STATE_PATHSPEC,
  ]
  // Not through `git()`, which trims the leading space of the first status code.
  const ran = yield* Git.use((service) => service.run(args))
  if (ran.code !== 0)
    return yield* new GitFailed({ args, code: ran.code, output: ran.stderr.trim() })
  return ran.stdout
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
})

/**
 * In the local mode, refuses a commit that stages state files, which the exclude entry cannot keep
 * out once git tracks them (or once they were added by force). A commit that stages none of them is
 * not affected by state git tracks. The project's settings are not state.
 */
const requireNoStagedState = (staged: ReadonlyArray<string>) => {
  const state = staged.filter((path) => inStateFolder(path, true) && !isConfigFile(path))
  return state.length === 0
    ? Effect.void
    : Effect.fail(
        new Usage({
          message: `files under ${STATE_DIRECTORY}/ are staged (${state.join(", ")}), which state mode local cannot keep out of a commit`,
          hint: "Unstage them with `git restore --staged`. The repository tracks state; see `holyagent state mode` and docs/usage.md before changing the mode or untracking files.",
        }),
      )
}

/**
 * Commits exactly the named paths with the configured git identity (an agent's is refused). In a
 * claude.ai cloud session the author is checked instead and the committer is the platform's. In the
 * default `branch` mode Intent state is not part of it: it is committed on the state branch as it
 * changes, and a path under `.holyagent/` is refused (as in `local`, which commits it nowhere). In
 * the `work` mode the changed state files (not the project's settings) are staged with the work. In
 * the `local` mode a commit that stages state files git tracks is refused. Changes staged
 * beforehand outside the named paths refuse the commit, so the commit is never wider than the
 * request. The repository's own hooks run, the commit-msg hook among them.
 */
export const commit = (request: CommitRequest) =>
  Effect.gen(function* () {
    const { message } = request
    yield* request.cloud ? requireOwnAuthor : requireOwnIdentity
    const mode = yield* stateMode
    const ignoreCase = yield* ignoresCase
    const real = yield* realEntries(shortNames(request.paths, sep))
    const named = yield* commitScope(request.paths, sep, mode, ignoreCase, real)
    // In the work mode the state rides the work commit: the changed state files join the scope.
    const scope =
      mode === "work" && !named.includes(STATE_DIRECTORY)
        ? [...named, ...(yield* changedState)]
        : named

    const alreadyStaged = yield* stagedPaths
    if (mode === "local") yield* requireNoStagedState(alreadyStaged)
    const outside = alreadyStaged.filter((path) => !inScope(scope, path, ignoreCase))
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
