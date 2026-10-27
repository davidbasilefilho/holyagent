import { constants } from "node:fs"
import { open, realpath } from "node:fs/promises"
import { join, relative, sep } from "node:path"

import { Effect, Schema } from "effect"

import { Usage } from "../cli/errors.ts"
import type { Call } from "../cli/types.ts"
import { pathProblem } from "../domain/paths.ts"
import { hasCode, io } from "../state/files.ts"
import { GitFailed, RemoteMismatch } from "./errors.ts"
import { currentBranch, Git, originUrl, repoSlug } from "./git.ts"
import { apiPath, decodeAnswer, GitHub } from "./github.ts"
import { checkedText } from "./message.ts"
import { recordPull } from "./record.ts"

const Created = Schema.Struct({ number: Schema.Int, html_url: Schema.String })

/** The most a pull request body file may hold. */
export const MAX_BODY_BYTES = 256 * 1024

const hasGitSegment = (path: string) =>
  path.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git")

/**
 * Reads the body file of a pull request, which gets published. It must be a regular file inside the
 * project (after resolving symlinks), outside `.git`, not ignored by git (so `.env` and the like
 * stay private) and no larger than {@link MAX_BODY_BYTES}. The file is opened once, without
 * following a final symlink, and the size and content come from that descriptor, so the checks and
 * the read cannot be split by swapping the path.
 */
const readBodyFile = (root: string, file: string) => {
  const refuse = (why: string) =>
    new Usage({
      message: `--body-file ${file} ${why}`,
      hint: "Write the body to a small, unignored file inside the project and name it relative to the project root.",
    })
  return Effect.gen(function* () {
    const problem = pathProblem(file)
    if (problem !== undefined) return yield* refuse(`is not a project path (${problem})`)
    if (hasGitSegment(file)) return yield* refuse("is inside .git")
    const path = join(root, file)
    const resolve = io(path, () => realpath(path))
    const real = yield* resolve.pipe(
      Effect.catchIf(
        (error) => hasCode(error.cause, "ENOENT"),
        () => Effect.fail(refuse("does not exist")),
      ),
    )
    const base = yield* io(root, () => realpath(root))
    if (real !== base && !real.startsWith(`${base}${sep}`))
      return yield* refuse("resolves to a path outside the project")
    const inside = relative(base, real)
    if (hasGitSegment(inside)) return yield* refuse("is inside .git")
    const ignored = yield* Git.use((service) =>
      service.run(["check-ignore", "-q", "--no-index", "--", inside]),
    )
    if (ignored.code === 0) return yield* refuse("is ignored by git")
    if (ignored.code !== 1)
      return yield* new GitFailed({
        args: ["check-ignore", inside],
        code: ignored.code,
        output: ignored.stderr.trim(),
      })

    const text = yield* Effect.acquireUseRelease(
      io(real, () => open(real, constants.O_RDONLY | constants.O_NOFOLLOW)),
      (handle) =>
        Effect.gen(function* () {
          const info = yield* io(real, () => handle.stat())
          if (!info.isFile()) return yield* refuse("is not a regular file")
          if (info.size > MAX_BODY_BYTES)
            return yield* refuse(`is larger than ${MAX_BODY_BYTES / 1024} KiB`)
          const buffer = Buffer.alloc(MAX_BODY_BYTES + 1)
          const { bytesRead } = yield* io(real, () => handle.read(buffer, 0, buffer.length, 0))
          if (bytesRead > MAX_BODY_BYTES)
            return yield* refuse(`is larger than ${MAX_BODY_BYTES / 1024} KiB`)
          return buffer.subarray(0, bytesRead).toString("utf8")
        }),
      (handle) => io(real, () => handle.close()).pipe(Effect.ignore),
    )
    if ((yield* resolve) !== real) return yield* refuse("changed while it was read")
    return text
  })
}

/** What `vcs pr` was asked to do. */
export interface PullRequestRequest {
  readonly state: Pick<Call, "directory" | "update">
  readonly root: string
  readonly base: string | undefined
  readonly title: string | undefined
  readonly bodyFile: string | undefined
  readonly update: number | undefined
  readonly allowWords: ReadonlyArray<string>
}

/** The outcome of `vcs pr`. */
export interface PullRequested {
  readonly number: number
  readonly url: string
  readonly created: boolean
  /** The Intent that recorded the pull request, when one was in use. */
  readonly intent?: string
  /** Why the pull request could not be recorded on the Intent; it exists on GitHub regardless. */
  readonly unrecorded?: string
}

/**
 * Creates a pull request from the current branch, or updates the one named by `update`, through the
 * REST API. Title and body are cleaned and checked like a commit message. The pull request, its
 * branch and base are then recorded on the Intent in use, as a record of their own in the state.
 */
export const pullRequest = (request: PullRequestRequest) =>
  Effect.gen(function* () {
    const repo = repoSlug(yield* originUrl)
    if (repo === undefined)
      return yield* new RemoteMismatch({ reason: "origin does not name a GitHub repository" })

    const title =
      request.title === undefined
        ? undefined
        : yield* checkedText(request.title, request.allowWords)
    if (title?.includes("\n"))
      return yield* new Usage({
        message: "The title must be one line",
        hint: "Put the detail in --body-file.",
      })
    const text =
      request.bodyFile === undefined
        ? undefined
        : yield* readBodyFile(request.root, request.bodyFile)
    const body = text === undefined ? undefined : yield* checkedText(text, request.allowWords)
    const branch = yield* currentBranch
    const fields = {
      ...(title === undefined ? {} : { title }),
      ...(body === undefined ? {} : { body }),
      ...(request.base === undefined ? {} : { base: request.base }),
    }

    const answer = yield* GitHub.use((github) =>
      request.update === undefined
        ? github.rest({
            method: "POST",
            path: `repos/${repo}/pulls`,
            body: { ...fields, head: branch },
          })
        : github.rest({
            method: "PATCH",
            path: `repos/${repo}/pulls/${apiPath(String(request.update))}`,
            body: fields,
          }),
    )
    const pull = yield* decodeAnswer(Created, "pull request", answer)
    const recorded = yield* recordPull(request.state, {
      number: pull.number,
      url: pull.html_url,
      branch,
      base: request.base,
      created: request.update === undefined,
    })
    return {
      number: pull.number,
      url: pull.html_url,
      created: request.update === undefined,
      ...recorded,
    } satisfies PullRequested
  })
