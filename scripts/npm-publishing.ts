import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

import { verifyDevPublication } from "./verify-dev-publication.ts"

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
const DevTag = open({ dev: Schema.optionalKey(Schema.String) })
const readbackAttempts = 17

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

/** Read the public dev channel without permitting a registry write. */
export const readDevChannel = (
  name: string,
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
      if (response.status === 404) return {}
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    },
    catch: (cause) =>
      new PublishError({ detail: `npm dev channel readback failed: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((input) => decode(DevTag, input)),
    Effect.map(({ dev }) => dev),
  )

const isDevArtifact = (name: string, version: string, tag: string, context: TagContext) =>
  tag === "dev" &&
  name === "holyagent" &&
  context.repository === "davidbasilefilho/holyagent" &&
  context.tag === `holyagent-${version}` &&
  /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.([01]\d|2[0-3])-[0-5]\d-[0-5]\d\.g[a-f0-9]{7}$/.test(
    version,
  ) &&
  version.endsWith(`.g${context.commit.slice(0, 7)}`)

const exactStagedConflict = (result: NpmResult, version: string) => {
  const lines = result.stderr.split(/\r?\n/)
  return (
    lines.includes("npm error code E409") &&
    lines.includes(
      `npm error 409 Conflict - PUT https://registry.npmjs.org/holyagent - Cannot publish over previously staged version "${version}".`,
    )
  )
}

const confirmExistingPackage = (
  path: string,
  name: string,
  version: string,
  found: typeof RegistryVersion.Type,
) =>
  Effect.gen(function* () {
    if (found.name !== name || found.version !== version)
      return yield* new PublishError({
        detail: `Registry lookup did not return exact package ${name}@${version}`,
      })
    const integrity = yield* Effect.tryPromise({
      try: async () =>
        `sha512-${new Bun.CryptoHasher("sha512").update(await Bun.file(path).arrayBuffer()).digest("base64")}`,
      catch: (cause) =>
        new PublishError({
          detail: `Cannot read tarball for integrity verification: ${String(cause)}`,
        }),
    })
    if (found.dist.integrity !== integrity)
      return yield* new PublishError({
        detail: `Existing ${name}@${version} has different npm integrity from the packed artifact`,
      })
  })

const observeDevPublication = (
  path: string,
  version: string,
  context: TagContext,
  request: (url: string, init: RequestInit) => Promise<Response>,
  waitForReadback: Effect.Effect<void>,
  verify: typeof verifyDevPublication,
) =>
  Effect.gen(function* () {
    const expected = { repository: context.repository, commit: context.commit, version }
    for (let attempt = 0; attempt < readbackAttempts; attempt++) {
      if (attempt > 0) yield* waitForReadback
      yield* currentProtectedDev(context, request)
      if ((yield* readDevChannel("holyagent", request)) !== version) continue
      const confirmed = yield* verify(path, expected).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          error.pending
            ? Effect.succeed(false)
            : Effect.fail(
                new PublishError({ detail: `Cannot reuse holyagent@${version}: ${error.detail}` }),
              ),
        ),
      )
      if (!confirmed) continue
      yield* preflightTag(context, (url, init) =>
        request(url, {
          ...init,
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        }),
      )
      if ((yield* readDevChannel("holyagent", request)) !== version)
        return yield* new PublishError({
          detail: `The npm dev channel moved during verification of ${version}`,
        })
      yield* currentProtectedDev(context, request)
      return
    }
    return yield* new PublishError({
      detail: `Existing holyagent@${version} was not confirmed on the npm dev channel with trusted provenance within the readback window`,
    })
  })

/** Publishes a fresh packed artifact or verifies an immutable publication on the current dev head. */
export const publishArtifact = (
  path: string,
  tag: string,
  context: TagContext,
  run: NpmRunner = npm,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  waitForReadback: Effect.Effect<void> = Effect.sleep("15 seconds"),
  verify: typeof verifyDevPublication = verifyDevPublication,
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
    const canResume = isDevArtifact(manifest.name, manifest.version, tag, context)
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
      if (published.exitCode !== 0) {
        if (canResume && exactStagedConflict(published, manifest.version))
          return yield* observeDevPublication(
            path,
            manifest.version,
            context,
            request,
            waitForReadback,
            verify,
          )
        return yield* new PublishError({
          detail: `npm publish failed: ${published.stderr || published.stdout}`,
        })
      }
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
        for (let attempt = 0; attempt < readbackAttempts; attempt++) {
          if (attempt > 0) {
            yield* waitForReadback
            yield* postcheck
          }
          const visible = yield* readDevChannel(manifest.name, request).pipe(Effect.option)
          if (visible._tag === "Some" && visible.value === manifest.version) {
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
    const found = yield* decode(Schema.fromJsonString(RegistryVersion), lookup.stdout)
    if (canResume) {
      yield* confirmExistingPackage(path, manifest.name, manifest.version, found)
      return yield* observeDevPublication(
        path,
        manifest.version,
        context,
        request,
        waitForReadback,
        verify,
      )
    }
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
