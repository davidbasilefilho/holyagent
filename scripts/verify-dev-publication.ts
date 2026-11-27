import { X509Certificate } from "node:crypto"
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"

import { $ } from "bun"
import { Data, Effect, Schema } from "effect"

const REGISTRY = "https://registry.npmjs.org"
const PACKAGE = "holyagent"
const DEV_REF = "refs/heads/dev"
const SHA = /^[a-f0-9]{40}$/
const DEV_VERSION =
  /^0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev\.\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])\.([01][0-9]|2[0-3])-[0-5][0-9]-[0-5][0-9]\.g[a-f0-9]{7}$/
const SLSA = "https://slsa.dev/provenance/v1"
const PUBLISH = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1"
const IN_TOTO = "application/vnd.in-toto+json"
const BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1"
const ARCHIVE_LIMIT = 16 * 1024 * 1024
const UNPACKED_LIMIT = 32 * 1024 * 1024
const JSON_LIMIT = 256 * 1024

const rest = Schema.Record(Schema.String, Schema.Unknown)
const open = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [rest])
const manifest = open({ name: Schema.Literal(PACKAGE), version: Schema.String })
const signature = open({ keyid: Schema.String, sig: Schema.String })
const registryVersion = open({
  name: Schema.Literal(PACKAGE),
  version: Schema.String,
  dist: open({
    integrity: Schema.String,
    tarball: Schema.String,
    signatures: Schema.Array(signature),
    attestations: open({
      url: Schema.String,
      provenance: open({ predicateType: Schema.Literal(SLSA) }),
    }),
  }),
})
const auditReport = open({
  invalid: Schema.Array(Schema.Unknown),
  missing: Schema.Array(Schema.Unknown),
  verified: Schema.Array(
    open({
      name: Schema.Literal(PACKAGE),
      version: Schema.String,
      location: Schema.Literal("node_modules/holyagent"),
      registry: Schema.Literal(`${REGISTRY}/`),
      attestationBundles: Schema.Array(
        open({
          predicateType: Schema.Literals([SLSA, PUBLISH]),
          bundle: open({
            verificationMaterial: open({
              certificate: Schema.optional(open({ rawBytes: Schema.String })),
            }),
            dsseEnvelope: open({
              payload: Schema.String,
              payloadType: Schema.Literal(IN_TOTO),
              signatures: Schema.Array(signature),
            }),
          }),
        }),
      ),
    }),
  ),
})
const subject = Schema.Struct({
  name: Schema.String,
  digest: Schema.Struct({ sha512: Schema.String }),
})
const statement = {
  subject: Schema.Array(subject),
}
const publishStatement = Schema.Struct({
  ...statement,
  _type: Schema.Literal("https://in-toto.io/Statement/v0.1"),
  predicateType: Schema.Literal(PUBLISH),
  predicate: Schema.Struct({
    name: Schema.Literal(PACKAGE),
    version: Schema.String,
    registry: Schema.Literal(REGISTRY),
  }),
})
const provenanceStatement = Schema.Struct({
  ...statement,
  _type: Schema.Literal("https://in-toto.io/Statement/v1"),
  predicateType: Schema.Literal(SLSA),
  predicate: Schema.Struct({
    buildDefinition: Schema.Struct({
      buildType: Schema.Literal(BUILD_TYPE),
      externalParameters: Schema.Struct({
        workflow: Schema.Struct({
          ref: Schema.Literal(DEV_REF),
          repository: Schema.String,
          path: Schema.Literal(".github/workflows/publish.yml"),
        }),
      }),
      internalParameters: rest,
      resolvedDependencies: Schema.Array(
        Schema.Struct({ uri: Schema.String, digest: Schema.Struct({ gitCommit: Schema.String }) }),
      ),
    }),
    runDetails: Schema.Struct({
      builder: open({ id: Schema.String }),
      metadata: open({ invocationId: Schema.String }),
    }),
  }),
})

/** A missing exact registry version is pending. All other evidence failures are hard. */
export class DevPublicationError extends Data.TaggedError("DevPublicationError")<{
  readonly detail: string
  readonly pending: boolean
}> {}

/** The source and package version that must match the signed dev provenance. */
export interface ExpectedDevPublication {
  readonly repository: string
  readonly commit: string
  readonly version: string
}

/** A verified publication's historical GitHub run and exact compressed tarball digest. */
export interface DevPublicationEvidence {
  readonly runId: number
  readonly attempt: number
  readonly sha256: string
}

/** Transport overrides for fixture tests. The production audit must verify signatures with npm. */
export interface DevPublicationDependencies {
  readonly request?: (url: string, init: RequestInit) => Promise<Response>
  readonly audit?: (
    cwd: string,
    args: ReadonlyArray<string>,
    env: Readonly<Record<string, string>>,
  ) => Effect.Effect<{ readonly exitCode: number; readonly stdout: string }, DevPublicationError>
}

const denied = (detail: string) => new DevPublicationError({ detail, pending: false })
const fromPromise = <A>(detail: string, operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: () => denied(detail) })
const decode = <A, I>(schema: Schema.Codec<A, I>, input: unknown, detail: string) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => denied(detail)),
  )
const json = (bytes: Buffer | string, detail: string) =>
  Effect.try({
    try: (): unknown => {
      if (Buffer.byteLength(bytes) > JSON_LIMIT) throw Error("JSON limit exceeded")
      return JSON.parse(
        typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      )
    },
    catch: () => denied(detail),
  })
const parseBase64 = (encoded: string) => {
  const bytes = Buffer.from(encoded, "base64")
  return bytes.length && bytes.toString("base64") === encoded ? bytes : undefined
}
const registryAttestation = (version: string) =>
  `${REGISTRY}/-/npm/v1/attestations/${PACKAGE}@${version}`

const readLimited = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> => {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) return Buffer.concat(chunks, size)
      size += next.value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw Error("Evidence exceeded its byte limit")
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
}

const readArchive = Effect.fn("readLocalDevArchive")(function* (path: string) {
  const info = yield* fromPromise("Could not inspect the packed dev archive", () => lstat(path))
  if (!info.isFile() || info.size === 0 || info.size > ARCHIVE_LIMIT)
    return yield* denied("The packed dev archive must be a regular file within the size limit")
  const bytes = yield* fromPromise(
    "Could not read the packed dev archive within its size limit",
    () => readLimited(Bun.file(path).stream(), ARCHIVE_LIMIT),
  )
  if (bytes.length !== info.size)
    return yield* denied("The packed dev archive changed while reading")
  return bytes
})

const readManifest = Effect.fn("readDevArchiveManifest")(function* (
  bytes: Buffer,
  version: string,
) {
  const text = yield* fromPromise(
    "Invalid manifest or oversized unpacked dev archive",
    async () => {
      const archive = gunzipSync(bytes, { maxOutputLength: UNPACKED_LIMIT })
      const files = await new Bun.Archive(archive).files("package/package.json")
      const file = files.get("package/package.json")
      if (files.size !== 1 || !file || file.size > JSON_LIMIT)
        throw Error("Invalid archive manifest")
      return new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer())
    },
  )
  const identity = yield* decode(
    manifest,
    yield* json(text, "Malformed dev archive manifest"),
    "Invalid dev archive manifest identity",
  )
  if (identity.version !== version)
    return yield* denied("Dev archive manifest version does not match")
  return text
})

const defaultAudit: NonNullable<DevPublicationDependencies["audit"]> = (cwd, args, env) =>
  fromPromise("Could not run the isolated npm signature audit", async () => {
    const result = await $`npm ${args}`.cwd(cwd).env(env).quiet().nothrow()
    return { exitCode: result.exitCode, stdout: result.stdout.toString() }
  })

// Keep credential-free network routing on proxied hosts such as Codex Cloud. Let Node
// read system trust, not arbitrary CA or TLS overrides inherited from the caller.
const proxyEnvironment = () => {
  const env: Record<string, string> = {}
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) {
    const value = process.env[key]
    const url = value ? URL.parse(value) : null
    if (
      value &&
      url &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      env[key] = url.origin
  }
  for (const key of ["NO_PROXY", "no_proxy"]) {
    const value = process.env[key]
    if (value && /^[A-Za-z0-9.,:*_ /[\]-]+$/.test(value)) env[key] = value
  }
  return env
}

const auditPackage = (
  version: string,
  url: string,
  integrity: string,
  packageJson: string,
  audit: NonNullable<DevPublicationDependencies["audit"]>,
) =>
  Effect.acquireUseRelease(
    fromPromise("Could not create an isolated npm audit directory", () =>
      mkdtemp(join(tmpdir(), "holyagent-dev-audit-")),
    ),
    (cwd) =>
      Effect.gen(function* () {
        const userConfig = join(cwd, "empty-user.npmrc")
        const globalConfig = join(cwd, "empty-global.npmrc")
        const home = join(cwd, "home")
        yield* fromPromise("Could not prepare the isolated npm signature audit", async () => {
          const packageDir = join(cwd, "node_modules", PACKAGE)
          await mkdir(packageDir, { recursive: true })
          await mkdir(home)
          const root = {
            name: "holyagent-dev-audit",
            version: "0.0.0",
            private: true,
            dependencies: { [PACKAGE]: version },
          }
          const lock = {
            ...root,
            lockfileVersion: 3,
            requires: true,
            packages: {
              "": root,
              [`node_modules/${PACKAGE}`]: { version, resolved: url, integrity },
            },
          }
          await Bun.write(userConfig, "")
          await Bun.write(globalConfig, "")
          await Bun.write(join(cwd, "package.json"), JSON.stringify(root))
          await Bun.write(join(cwd, "package-lock.json"), JSON.stringify(lock))
          // Arborist needs the manifest, not the package contents, and no install is run.
          await Bun.write(join(packageDir, "package.json"), packageJson)
        })
        const result = yield* audit(
          cwd,
          [
            "audit",
            "signatures",
            "--json",
            "--include-attestations",
            "--ignore-scripts",
            "--no-update-notifier",
            `--registry=${REGISTRY}/`,
            `--cache=${join(cwd, "cache")}`,
            `--userconfig=${userConfig}`,
            `--globalconfig=${globalConfig}`,
            "--fetch-timeout=30000",
            "--fetch-retries=1",
          ],
          {
            // An allowlist keeps npm auth, NODE_OPTIONS and CI credentials out of the child.
            PATH: process.env["PATH"] ?? "",
            HOME: home,
            USERPROFILE: home,
            TMPDIR: cwd,
            TMP: cwd,
            TEMP: cwd,
            NODE_USE_SYSTEM_CA: "1",
            ...proxyEnvironment(),
            ...(process.platform === "win32" && process.env["SYSTEMROOT"]
              ? { SYSTEMROOT: process.env["SYSTEMROOT"] }
              : {}),
          },
        )
        if (result.exitCode !== 0)
          return yield* denied("npm rejected the package signatures or provenance")
        return yield* json(result.stdout, "Malformed npm signature audit output")
      }),
    (cwd) =>
      fromPromise("Could not clean the isolated npm audit directory", () =>
        rm(cwd, { recursive: true, force: true }),
      ).pipe(Effect.orDie),
  )

const pinnedProof = Effect.fn("matchVerifiedDevProvenance")(function* (
  audit: unknown,
  expected: ExpectedDevPublication,
  sha512: string,
) {
  const { repository, commit, version } = expected
  const report = yield* decode(auditReport, audit, "Malformed npm signature audit evidence")
  const [record] = report.verified
  if (
    report.invalid.length ||
    report.missing.length ||
    report.verified.length !== 1 ||
    !record ||
    record.version !== version
  )
    return yield* denied("npm did not verify the exact published dev package")
  const provenance = record.attestationBundles.find((item) => item.predicateType === SLSA)?.bundle
  const published = record.attestationBundles.find((item) => item.predicateType === PUBLISH)?.bundle
  if (record.attestationBundles.length !== 2 || !provenance || !published)
    return yield* denied("Both verified npm publish and SLSA provenance attestations are required")

  const source = `https://github.com/${repository}`
  const certBytes = parseBase64(provenance.verificationMaterial.certificate?.rawBytes ?? "")
  if (!certBytes) return yield* denied("Missing or malformed dev provenance signing certificate")
  const identity = yield* Effect.try({
    try: () => new X509Certificate(certBytes).subjectAltName,
    catch: () => denied("Malformed dev provenance signing certificate"),
  })
  if (identity !== `URI:${source}/.github/workflows/dev.yml@${DEV_REF}`)
    return yield* denied("The dev provenance certificate is not for the protected dev workflow")

  const payload = (bundle: typeof provenance) => {
    const [signature] = bundle.dsseEnvelope.signatures
    const bytes = parseBase64(bundle.dsseEnvelope.payload)
    return bundle.dsseEnvelope.signatures.length === 1 && signature?.sig && bytes
      ? json(bytes, "Malformed signed publication statement")
      : Effect.fail(denied("Malformed signed publication statement"))
  }
  const release = yield* decode(
    publishStatement,
    yield* payload(published),
    "Malformed signed npm publish statement",
  )
  const slsa = yield* decode(
    provenanceStatement,
    yield* payload(provenance),
    "Malformed signed SLSA provenance or unexpected workflow/ref",
  )
  const sameArchive = (items: typeof slsa.subject) =>
    items.length === 1 &&
    items[0]?.name === `pkg:npm/${PACKAGE}@${version}` &&
    items[0].digest.sha512 === sha512
  if (
    release.predicate.version !== version ||
    !sameArchive(release.subject) ||
    !sameArchive(slsa.subject)
  )
    return yield* denied("Signed attestation subject does not match the exact dev archive")
  const { buildDefinition, runDetails } = slsa.predicate
  const [sourceDependency] = buildDefinition.resolvedDependencies
  if (
    buildDefinition.externalParameters.workflow.repository !== source ||
    buildDefinition.resolvedDependencies.length !== 1 ||
    sourceDependency?.uri !== `git+${source}@${DEV_REF}` ||
    sourceDependency.digest.gitCommit !== commit
  )
    return yield* denied("Signed source repository, dev ref or commit does not match")
  const invocationPrefix = `${source}/actions/runs/`
  const id = runDetails.metadata.invocationId
  const [match, run, attempt] =
    /^([1-9][0-9]*)\/attempts\/([1-9][0-9]*)$/.exec(id.slice(invocationPrefix.length)) ?? []
  const runId = Number(run)
  const runAttempt = Number(attempt)
  if (
    !id.startsWith(invocationPrefix) ||
    !match ||
    !Number.isSafeInteger(runId) ||
    !Number.isSafeInteger(runAttempt)
  )
    return yield* denied("Signed dev invocation is not an exact GitHub run and attempt")
  return { runId, attempt: runAttempt }
})

/** Proves the exact local dev tarball is published with matching npm and GitHub signatures. */
export const verifyDevPublication = (
  path: string,
  expected: ExpectedDevPublication,
  { request = fetch, audit = defaultAudit }: DevPublicationDependencies = {},
): Effect.Effect<DevPublicationEvidence, DevPublicationError> =>
  Effect.gen(function* () {
    const { repository, commit, version } = expected
    if (
      !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(repository) ||
      !SHA.test(commit) ||
      !DEV_VERSION.test(version) ||
      !version.endsWith(`.g${commit.slice(0, 7)}`)
    )
      return yield* denied("Invalid exact dev publication context")
    const local = yield* readArchive(path)
    const packageJson = yield* readManifest(local, version)
    const sha512 = new Bun.CryptoHasher("sha512").update(local).digest("hex")
    const integrity = `sha512-${Buffer.from(sha512, "hex").toString("base64")}`
    const url = `${REGISTRY}/${PACKAGE}/-/${PACKAGE}-${version}.tgz`
    const get = (target: string) =>
      fromPromise("Official npm registry lookup failed", () =>
        request(target, {
          headers: { Accept: "application/json, application/octet-stream" },
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }),
      )
    const body = (response: Response, limit: number) =>
      fromPromise(
        "Official npm registry response was unreadable or exceeded the evidence limit",
        () => {
          if (!response.body) throw Error("Missing response body")
          return readLimited(response.body, limit)
        },
      )
    const meta = yield* get(`${REGISTRY}/${PACKAGE}/${version}`)
    if (meta.status === 404)
      return yield* new DevPublicationError({
        detail: "Exact dev version is not published in npm",
        pending: true,
      })
    if (meta.status !== 200)
      return yield* denied(`Exact npm version lookup failed: HTTP ${meta.status}`)
    const metadata = yield* decode(
      registryVersion,
      yield* json(yield* body(meta, JSON_LIMIT), "Malformed npm version metadata"),
      "Invalid npm version metadata or missing signatures",
    )
    const { dist } = metadata
    if (
      metadata.version !== version ||
      dist.tarball !== url ||
      dist.integrity !== integrity ||
      dist.signatures.length === 0 ||
      dist.attestations.url !== registryAttestation(version)
    )
      return yield* denied(
        "Exact npm version, tarball URL, integrity, or attestation metadata does not match",
      )
    const tarball = yield* get(url)
    if (tarball.status !== 200)
      return yield* denied(`Exact npm tarball lookup failed: HTTP ${tarball.status}`)
    const fetched = yield* body(tarball, ARCHIVE_LIMIT)
    if (!local.equals(fetched))
      return yield* denied("Published npm tarball differs from the exact packed dev archive")
    const npmEvidence = yield* auditPackage(version, url, integrity, packageJson, audit)
    const proof = yield* pinnedProof(npmEvidence, expected, sha512)
    return { ...proof, sha256: new Bun.CryptoHasher("sha256").update(local).digest("hex") }
  })
