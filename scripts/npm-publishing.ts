import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

const RecordOfUnknown = Schema.Record(Schema.String, Schema.Unknown)
const open = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [RecordOfUnknown])
const strict = { onExcessProperty: "error" } as const
const Manifest = open({ name: Schema.String, version: Schema.String })
const RegistryVersion = open({
  name: Schema.String,
  version: Schema.String,
  dist: open({ integrity: Schema.String }),
})
const RegistryError = open({ error: open({ code: Schema.Literal("E404") }) })
const Tags = Schema.Record(Schema.String, Schema.String)
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const devVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev-[a-f0-9]{7}$/

const timestamp = (value: string | undefined) => {
  if (!value || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return NaN
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z")
    ? parsed
    : NaN
}

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

/** Publishes a packed artifact or verifies an identical existing version without changing tags. */
export const publishArtifact = (path: string, tag: string, run: NpmRunner = npm) =>
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
    const bytes = yield* Effect.tryPromise({
      try: () => Bun.file(path).arrayBuffer(),
      catch: (cause) => new PublishError({ detail: `Cannot read tarball: ${String(cause)}` }),
    })
    const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`
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
      const published = yield* run(["publish", path, "--tag", tag, "--provenance"])
      if (published.exitCode !== 0)
        return yield* new PublishError({
          detail: `npm publish failed: ${published.stderr || published.stdout}`,
        })
      return
    }
    const existing = yield* decode(Schema.fromJsonString(RegistryVersion), lookup.stdout)
    if (
      existing.name !== manifest.name ||
      existing.version !== manifest.version ||
      existing.dist.integrity !== integrity
    )
      return yield* new PublishError({ detail: `Registry content conflicts with ${spec}` })
    const tags = yield* run(["dist-tag", "ls", manifest.name, "--json"])
    if (tags.exitCode !== 0)
      return yield* new PublishError({
        detail: `Dist-tag lookup failed: ${tags.stderr || tags.stdout}`,
      })
    const current = yield* decode(Schema.fromJsonString(Tags), tags.stdout).pipe(
      Effect.mapError(
        () =>
          new PublishError({
            detail:
              "Invalid dist-tag data; investigate registry state before retrying. OIDC cannot repair tags.",
          }),
      ),
    )
    if (current[tag] !== manifest.version) {
      const tagged = current[tag]
      const sameChannel =
        tag === "dev"
          ? devVersion.test(manifest.version) && devVersion.test(tagged ?? "")
          : tag === "latest" &&
            stableVersion.test(manifest.version) &&
            stableVersion.test(tagged ?? "") &&
            Bun.semver.order(tagged ?? "", manifest.version) > 0
      if (!sameChannel)
        return yield* new PublishError({
          detail: `Dist-tag ${tag} is missing or points outside the expected channel for ${spec}; OIDC cannot repair this tag. Investigate registry state before retrying.`,
        })
      const times = yield* run(["view", manifest.name, "time", "--json"])
      if (times.exitCode !== 0)
        return yield* new PublishError({
          detail: `Publication time lookup failed: ${times.stderr || times.stdout}`,
        })
      const dates = yield* decode(Schema.fromJsonString(Tags), times.stdout).pipe(
        Effect.mapError(
          () =>
            new PublishError({
              detail:
                "Invalid publication time data; investigate registry state before retrying. OIDC cannot repair tags.",
            }),
        ),
      )
      const ours = timestamp(dates[manifest.version])
      const theirs = timestamp(dates[tagged ?? ""])
      if (!Number.isFinite(ours) || !Number.isFinite(theirs) || theirs <= ours)
        return yield* new PublishError({
          detail: `Dist-tag ${tag} does not point to ${spec} or a newer published version; OIDC cannot repair this tag. Investigate registry state before retrying.`,
        })
    }
  })

if (import.meta.main) {
  const [path = "", tag = ""] = Bun.argv.slice(2)
  await Effect.runPromise(
    publishArtifact(path, tag).pipe(
      Effect.catch((error) =>
        Console.error(`npm publication failed: ${String(error)}`).pipe(
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
