import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

const RecordOfUnknown = Schema.Record(Schema.String, Schema.Unknown)
const open = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [RecordOfUnknown])
const strict = { onExcessProperty: "error" } as const
const Manifest = open({
  name: Schema.String,
  version: Schema.String,
  repository: Schema.optional(
    open({ type: Schema.String, url: Schema.String, directory: Schema.String }),
  ),
})
const RegistryVersion = open({
  name: Schema.String,
  version: Schema.String,
  dist: open({ integrity: Schema.String }),
})
const RegistryError = open({ error: open({ code: Schema.Literal("E404") }) })
const GitObject = open({ object: open({ type: Schema.String, sha: Schema.String }) })
const DevHead = open({
  name: Schema.Literal("dev"),
  protected: Schema.Literal(true),
  commit: open({ sha: Schema.String }),
})
const DevTag = open({ dev: Schema.String })

/** A publication cannot safely proceed. */
export class PublishError extends Data.TaggedError("PublishError")<{ readonly detail: string }> {}

/** The result of an npm invocation. */
export interface NpmResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** An injectable npm command runner. */
export type NpmRunner = (args: ReadonlyArray<string>) => Effect.Effect<NpmResult, PublishError>

const npm: NpmRunner = (args) =>
  Effect.tryPromise({
    try: async () => {
      const result = await $`npm ${args}`.quiet().nothrow()
      return {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      }
    },
    catch: (cause) => new PublishError({ detail: `npm failed to start: ${String(cause)}` }),
  })

const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown) =>
  Schema.decodeUnknownEffect(schema, strict)(input)

/** GitHub context for the tag that the subsequent release job will create. */
export interface TagContext {
  readonly repository: string
  readonly tag: string
  readonly commit: string
  readonly token: string
}

/** Check the exact release tag using authenticated read-only GitHub API requests. */
export const preflightTag = (
  context: TagContext,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) =>
  Effect.gen(function* () {
    const { repository, tag, commit, token } = context
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
      !/^holyagent-[\w.-]+$/.test(tag) ||
      !/^[a-f0-9]{40}$/.test(commit) ||
      !token
    )
      return yield* new PublishError({ detail: "Invalid GitHub tag preflight context" })
    const base = `https://api.github.com/repos/${repository}`
    const get = (url: string) =>
      Effect.tryPromise({
        try: () =>
          request(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          }),
        catch: (cause) =>
          new PublishError({ detail: `GitHub tag lookup failed: ${String(cause)}` }),
      })
    // A ref 404 is meaningful only after confirming the repository is accessible.
    const repo = yield* get(base)
    if (!repo.ok)
      return yield* new PublishError({
        detail: `GitHub repository lookup failed: HTTP ${repo.status}`,
      })
    let response = yield* get(`${base}/git/ref/tags/${encodeURIComponent(tag)}`)
    if (response.status === 404) return
    for (let depth = 0; depth < 2; depth++) {
      if (!response.ok)
        return yield* new PublishError({
          detail: `GitHub tag lookup failed: HTTP ${response.status}`,
        })
      const body = yield* Effect.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: (cause) =>
          new PublishError({ detail: `Invalid GitHub tag response: ${String(cause)}` }),
      })
      const parsed = yield* decode(GitObject, body).pipe(
        Effect.mapError(() => new PublishError({ detail: "Invalid GitHub tag response" })),
      )
      const object = parsed.object
      if (!/^[a-f0-9]{40}$/.test(object.sha))
        return yield* new PublishError({ detail: "Invalid GitHub tag object SHA" })
      if (object.type === "commit") {
        if (object.sha !== commit)
          return yield* new PublishError({
            detail: `GitHub tag ${tag} conflicts with expected commit ${commit}`,
          })
        return
      }
      if (object.type !== "tag")
        return yield* new PublishError({ detail: "GitHub tag does not resolve to a commit" })
      if (depth === 1)
        return yield* new PublishError({
          detail: "Nested annotated GitHub tags are not supported by the release postcheck",
        })
      response = yield* get(`${base}/git/tags/${object.sha}`)
    }
  })

const currentProtectedDev = (
  context: TagContext,
  request: (url: string, init: RequestInit) => Promise<Response>,
) =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => {
      const response = await request(
        `https://api.github.com/repos/${context.repository}/branches/dev`,
        {
          headers: {
            Authorization: `Bearer ${context.token}`,
            Accept: "application/vnd.github+json",
          },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      )
      if (!response.ok) throw new Error("Branch lookup failed")
      return response.json()
    },
    catch: () => new PublishError({ detail: "Could not confirm the current protected dev head" }),
  }).pipe(
    Effect.flatMap((input) => decode(DevHead, input)),
    Effect.flatMap(({ commit }) =>
      commit.sha === context.commit
        ? Effect.void
        : Effect.fail(
            new PublishError({
              detail: "The dev head moved; this build may not set the dev channel",
            }),
          ),
    ),
  )

const checkDevReadback = (
  name: string,
  version: string,
  request: (url: string, init: RequestInit) => Promise<Response>,
) =>
  Effect.tryPromise({
    try: async (): Promise<unknown> => {
      const response = await request(
        `https://registry.npmjs.org/-/package/${encodeURIComponent(name)}/dist-tags`,
        {
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      )
      if (!response.ok) throw new Error("Dist-tag lookup failed")
      return response.json()
    },
    catch: () =>
      new PublishError({
        detail:
          "npm publish returned success but dev channel readback failed; inspect registry state before any retry",
      }),
  }).pipe(
    Effect.flatMap((input) => decode(DevTag, input)),
    Effect.flatMap(({ dev }) =>
      dev === version
        ? Effect.void
        : Effect.fail(
            new PublishError({
              detail:
                "npm publish returned success but dev resolves to a different version; inspect registry state before any retry",
            }),
          ),
    ),
  )

/** Publishes a fresh packed artifact after checking the intended GitHub tag. */
export const publishArtifact = (
  path: string,
  tag: string,
  context: TagContext,
  run: NpmRunner = npm,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  waitForReadback: Effect.Effect<void> = Effect.sleep("15 seconds"),
) =>
  Effect.gen(function* () {
    if (!path || !/^[a-z][a-z0-9-]*$/.test(tag))
      return yield* new PublishError({ detail: "Expected a tarball path and a dist-tag" })
    const tar = yield* Effect.tryPromise({
      try: () => $`tar -xOzf ${path} package/package.json`.quiet(),
      catch: (cause) =>
        new PublishError({ detail: `Cannot read tarball manifest: ${String(cause)}` }),
    })
    const manifest = yield* decode(Schema.fromJsonString(Manifest), tar.stdout.toString())
    if (!manifest.name || !manifest.version)
      return yield* new PublishError({ detail: "Empty package identity" })
    if (
      manifest.repository?.type !== "git" ||
      manifest.repository.url !== `https://github.com/${context.repository}` ||
      manifest.repository.directory !== "packages/integrations/pi/dist"
    )
      return yield* new PublishError({
        detail:
          "Package repository metadata does not match the provenance repository and package directory",
      })
    yield* preflightTag(context, request)
    const spec = `${manifest.name}@${manifest.version}`
    const lookup = yield* run(["view", spec, "--json"])
    if (lookup.exitCode !== 0) {
      const missing = yield* Effect.option(
        decode(Schema.fromJsonString(RegistryError), lookup.stdout),
      )
      if (missing._tag !== "Some")
        return yield* new PublishError({
          detail: `Registry lookup failed: ${lookup.stderr || lookup.stdout}`,
        })
      if (tag === "dev") yield* currentProtectedDev(context, request)
      const published = yield* run([
        "publish",
        path,
        "--tag",
        tag,
        "--provenance",
        ...(tag === "dev" ? ["--ignore-scripts"] : []),
      ])
      if (published.exitCode !== 0)
        return yield* new PublishError({
          detail: `npm publish failed: ${published.stderr || published.stdout}`,
        })
      if (tag === "dev") {
        const postcheck = currentProtectedDev(context, request).pipe(
          Effect.mapError(
            () =>
              new PublishError({
                detail:
                  "npm publish already succeeded but the protected dev head could not be reconfirmed; inspect before retrying",
              }),
          ),
        )
        for (let attempt = 0; attempt < 17; attempt++) {
          if (attempt > 0) {
            yield* waitForReadback
            yield* postcheck
          }
          const visible = yield* checkDevReadback(manifest.name, manifest.version, request).pipe(
            Effect.option,
          )
          if (visible._tag === "Some") {
            yield* postcheck
            return
          }
        }
        return yield* new PublishError({
          detail:
            "npm publish already succeeded but dev was not confirmed within the readback window; inspect before retrying",
        })
      }
      return
    }
    yield* decode(Schema.fromJsonString(RegistryVersion), lookup.stdout)
    return yield* new PublishError({
      detail: `Cannot reuse existing ${spec}: trusted provenance cannot currently be established. Investigate the registry and release state before proceeding; no tag changes were made.`,
    })
  })

if (import.meta.main) {
  const [path = "", tag = "", releaseTag = ""] = Bun.argv.slice(2)
  const context = {
    repository: process.env["GITHUB_REPOSITORY"] ?? "",
    commit: process.env["GITHUB_SHA"] ?? "",
    token: process.env["GH_TOKEN"] ?? "",
    tag: releaseTag,
  }
  await Effect.runPromise(
    publishArtifact(path, tag, context).pipe(
      Effect.catch((error) =>
        Console.error(
          `npm publication failed: ${error instanceof PublishError ? error.detail : String(error)}`,
        ).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1
            }),
          ),
        ),
      ),
    ),
  )
}
