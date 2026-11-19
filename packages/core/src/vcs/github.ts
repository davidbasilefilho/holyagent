import { Context, Effect, Layer, Schema } from "effect"

import { GitHubFailed } from "./errors.ts"
import { type Env, spawn } from "./process.ts"

/** One REST call to the GitHub API. */
export interface RestRequest {
  readonly method: "GET" | "POST" | "PUT" | "PATCH"
  /** The path below the API root, such as `repos/o/r/pulls`; a query string may follow. */
  readonly path: string
  readonly body?: unknown
}

/** The GitHub REST API as the credential of `gh` sees it. Answers are untyped JSON until decoded. */
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly rest: (request: RestRequest) => Effect.Effect<unknown, GitHubFailed>
  }
>()("holyagent/vcs/GitHub") {}

/** A path below the API root with each segment escaped, so `a/b c` stays two segments. */
export const apiPath = (path: string): string => path.split("/").map(encodeURIComponent).join("/")

const ErrorBody = Schema.fromJsonString(Schema.Struct({ message: Schema.String }))
const Json = Schema.fromJsonString(Schema.Unknown)

const gh = (cwd: string, env: Env, what: string, args: ReadonlyArray<string>, stdin?: string) =>
  spawn("gh", args, {
    cwd,
    env: { ...process.env, ...env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    stdin,
  }).pipe(
    Effect.flatMap(({ code, stdout, stderr }) => {
      const text = new TextDecoder().decode(stdout)
      if (code === 0) return Effect.succeed(text)
      const status = /HTTP (\d{3})/.exec(stderr)?.[1]
      return Schema.decodeUnknownEffect(ErrorBody)(text).pipe(
        Effect.map((body) => body.message),
        Effect.orElseSucceed(() => stderr.trim() || text.trim() || `gh exited ${code}`),
        Effect.flatMap((reason) =>
          Effect.fail(
            new GitHubFailed({
              what,
              status: status === undefined ? undefined : Number(status),
              reason,
            }),
          ),
        ),
      )
    }),
  )

const parse = (what: string, text: string) =>
  text.trim() === ""
    ? Effect.succeed(null)
    : Schema.decodeUnknownEffect(Json)(text).pipe(
        Effect.mapError(
          () => new GitHubFailed({ what, status: undefined, reason: "the answer is not JSON" }),
        ),
      )

/** GitHub through the `gh` CLI, which brings the credential; payloads travel on stdin. */
export const githubLive = (cwd: string, env: Env) =>
  Layer.succeed(GitHub, {
    rest: ({ method, path, body }) => {
      const what = `${method} ${path.split("?")[0]}`
      return gh(
        cwd,
        env,
        what,
        ["api", "-X", method, path, ...(body === undefined ? [] : ["--input", "-"])],
        body === undefined ? undefined : JSON.stringify(body),
      ).pipe(Effect.flatMap((text) => parse(what, text)))
    },
  })

/** Decodes an answer of the API, reporting a shape that does not match as a GitHubFailed. */
export const decodeAnswer = <S extends Schema.Decoder<unknown>>(
  schema: S,
  what: string,
  answer: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(answer).pipe(
    Effect.mapError(
      (error) =>
        new GitHubFailed({
          what,
          status: undefined,
          reason: `unexpected answer: ${error.message}`,
        }),
    ),
  )
