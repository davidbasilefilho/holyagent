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

/** The GitHub API as the credential owner sees it. Answers are untyped JSON until decoded. */
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly rest: (request: RestRequest) => Effect.Effect<unknown, GitHubFailed>
    /** Runs a GraphQL document and returns its `data`. */
    readonly graphql: (
      query: string,
      variables: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<unknown, GitHubFailed>
  }
>()("holyagent/vcs/GitHub") {}

const ErrorBody = Schema.fromJsonString(Schema.Struct({ message: Schema.String }))
const Json = Schema.fromJsonString(Schema.Unknown)
const GraphqlBody = Schema.Struct({
  data: Schema.optionalKey(Schema.Unknown),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
})

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

const decodeGraphql = (json: unknown) =>
  Schema.decodeUnknownEffect(GraphqlBody)(json).pipe(
    Effect.mapError(
      () =>
        new GitHubFailed({
          what: "GraphQL request",
          status: undefined,
          reason: "unexpected answer",
        }),
    ),
    Effect.flatMap(({ data, errors }) =>
      errors === undefined || errors.length === 0
        ? Effect.succeed(data)
        : Effect.fail(
            new GitHubFailed({
              what: "GraphQL request",
              status: undefined,
              reason: errors.map((error) => error.message).join("; "),
            }),
          ),
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
    graphql: (query, variables) =>
      gh(
        cwd,
        env,
        "GraphQL request",
        ["api", "graphql", "--input", "-"],
        JSON.stringify({ query, variables }),
      ).pipe(
        Effect.flatMap((text) => parse("GraphQL request", text)),
        Effect.flatMap((json) => decodeGraphql(json)),
      ),
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
