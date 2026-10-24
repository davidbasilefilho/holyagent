import { resolve } from "node:path"

import { Effect, Schema } from "effect"

import { Usage } from "../cli/errors.ts"
import { readText } from "../state/files.ts"
import { detect, saveVcs } from "./detect.ts"
import { RemoteMismatch } from "./errors.ts"
import { currentBranch, repoSlug } from "./git.ts"
import { decodeAnswer, GitHub } from "./github.ts"
import { checkedText } from "./message.ts"
import { apiPath } from "./repo.ts"

const Created = Schema.Struct({ number: Schema.Int, html_url: Schema.String })

/** What `vcs pr` was asked to do. */
export interface PullRequestRequest {
  readonly directory: string
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
}

/**
 * Creates a pull request from the current branch, or updates the one named by `update`, through the
 * REST API. Title and body are cleaned and checked like a commit message.
 */
export const pullRequest = (request: PullRequestRequest) =>
  Effect.gen(function* () {
    const { detection } = yield* detect(request.directory, request.root, false)
    const repo = repoSlug(detection.remote)
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
        : yield* readText(resolve(request.root, request.bodyFile))
    if (request.bodyFile !== undefined && text === undefined)
      return yield* new Usage({
        message: `--body-file ${request.bodyFile} does not exist`,
        hint: "Write the body to a file first.",
      })
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
    yield* saveVcs(request.directory, (current) => ({
      ...current,
      branch,
      pullRequest: String(pull.number),
      ...(request.base === undefined ? {} : { base: request.base }),
    }))
    return {
      number: pull.number,
      url: pull.html_url,
      created: request.update === undefined,
    } satisfies PullRequested
  })
