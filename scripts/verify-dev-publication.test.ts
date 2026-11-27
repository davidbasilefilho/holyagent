import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, truncate } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { type DevPublicationDependencies, verifyDevPublication } from "./verify-dev-publication.ts"

const repository = "davidbasilefilho/holyagent"
const commit = "a371bbd57ba307651d2fbf2bc85c777345cad4ae"
const version = "0.4.0-dev.2026-11-27.20-54-33.ga371bbd"
const expected = { repository, commit, version }
const registry = "https://registry.npmjs.org"
const source = `https://github.com/${repository}`
const tarball = `${registry}/holyagent/-/holyagent-${version}.tgz`
const packageUrl = `${registry}/holyagent/${version}`
const slsaType = "https://slsa.dev/provenance/v1"
const publishType = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1"
const invocationId = `${source}/actions/runs/46066785389/attempts/1`

// Public Fulcio leaf certificate from the official npm provenance bundle for this version.
// These fixtures stub npm's cryptographic verdict; they test the verifier's policy on its output.
const certificate =
  "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"

let dir: string
let archive: string
let bytes: Uint8Array<ArrayBuffer>
let sha512: string
let integrity: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "holyagent-verify-dev-test-"))
  archive = join(dir, "holyagent.tgz")
  bytes = new Uint8Array(
    Bun.gzipSync(
      new Uint8Array(
        await new Bun.Archive({
          "package/package.json": JSON.stringify({ name: "holyagent", version }),
          "package/index.js": "throw new Error('must not run the package')",
        }).bytes(),
      ),
    ),
  )
  await Bun.write(archive, bytes)
  sha512 = new Bun.CryptoHasher("sha512").update(bytes).digest("hex")
  integrity = `sha512-${Buffer.from(sha512, "hex").toString("base64")}`
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const metadata = () => ({
  name: "holyagent",
  version,
  dist: {
    tarball,
    integrity,
    signatures: [{ keyid: "test-key", sig: "test-signature" }],
    attestations: {
      url: `${registry}/-/npm/v1/attestations/holyagent@${version}`,
      provenance: { predicateType: slsaType },
    },
  },
})
const subject = () => [{ name: `pkg:npm/holyagent@${version}`, digest: { sha512 } }]
const slsa = () => ({
  _type: "https://in-toto.io/Statement/v1",
  predicateType: slsaType,
  subject: subject(),
  predicate: {
    buildDefinition: {
      buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
      externalParameters: {
        workflow: {
          ref: "refs/heads/dev",
          repository: source,
          path: ".github/workflows/publish.yml",
        },
      },
      internalParameters: { github: { event_name: "push" } },
      resolvedDependencies: [
        { uri: `git+${source}@refs/heads/dev`, digest: { gitCommit: commit } },
      ],
    },
    runDetails: {
      builder: { id: "https://github.com/actions/runner/github-hosted" },
      metadata: { invocationId },
    },
  },
})
const published = () => ({
  _type: "https://in-toto.io/Statement/v0.1",
  predicateType: publishType,
  subject: subject(),
  predicate: { name: "holyagent", version, registry },
})
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64")
const envelope = (value: unknown) => ({
  payloadType: "application/vnd.in-toto+json",
  payload: encode(value),
  signatures: [{ keyid: "", sig: "test-signature" }],
})
const auditEvidence = (provenance = slsa(), publish = published(), rawBytes = certificate) => ({
  invalid: [],
  missing: [],
  verified: [
    {
      name: "holyagent",
      version,
      location: "node_modules/holyagent",
      registry: `${registry}/`,
      attestationBundles: [
        {
          predicateType: publishType,
          bundle: { verificationMaterial: {}, dsseEnvelope: envelope(publish) },
        },
        {
          predicateType: slsaType,
          bundle: {
            verificationMaterial: { certificate: { rawBytes } },
            dsseEnvelope: envelope(provenance),
          },
        },
      ],
    },
  ],
})

const request =
  (
    packument: () => Response = () => Response.json(metadata()),
    packed: () => Response = () => new Response(bytes),
    calls: string[] = [],
  ): NonNullable<DevPublicationDependencies["request"]> =>
  async (url, init) => {
    expect(init.credentials).toBe("omit")
    expect(init.redirect).toBe("error")
    expect(new Headers(init.headers).has("Authorization")).toBe(false)
    calls.push(url)
    if (url === packageUrl) return packument()
    if (url === tarball) return packed()
    throw Error("Unexpected registry request")
  }

const output = (result: unknown = auditEvidence(), exitCode = 0) =>
  Effect.succeed({ exitCode, stdout: JSON.stringify(result) })

const assertHardFailure = async (dependencies: DevPublicationDependencies, detail: string) => {
  const result = await Effect.runPromise(
    Effect.result(verifyDevPublication(archive, expected, dependencies)),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw Error("Unexpected successful proof")
  expect(result.failure).toMatchObject({ _tag: "DevPublicationError", pending: false })
  expect(result.failure.detail).toContain(detail)
}

test("binds archive bytes, native audit inputs, publisher certificate and invocation", async () => {
  const calls: string[] = []
  let auditDir: string | undefined
  const verified = await Effect.runPromise(
    verifyDevPublication(archive, expected, {
      request: request(undefined, undefined, calls),
      audit: (cwd, args, env) =>
        Effect.promise(async () => {
          auditDir = cwd
          expect(args.slice(0, 4)).toEqual([
            "audit",
            "signatures",
            "--json",
            "--include-attestations",
          ])
          expect(args).toContain("--ignore-scripts")
          expect(args).toContain(`--registry=${registry}/`)
          expect(args).toContain(`--userconfig=${join(cwd, "empty-user.npmrc")}`)
          expect(args).toContain(`--globalconfig=${join(cwd, "empty-global.npmrc")}`)
          expect(await Bun.file(join(cwd, "empty-user.npmrc")).text()).toBe("")
          expect(await Bun.file(join(cwd, "empty-global.npmrc")).text()).toBe("")
          expect(env["HOME"]).toBe(join(cwd, "home"))
          expect(env["NODE_AUTH_TOKEN"]).toBeUndefined()
          expect(env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]).toBeUndefined()
          expect(env["NODE_OPTIONS"]).toBeUndefined()
          expect(env["GH_TOKEN"]).toBeUndefined()
          expect(env["NODE_EXTRA_CA_CERTS"]).toBeUndefined()
          expect(env["NODE_TLS_REJECT_UNAUTHORIZED"]).toBeUndefined()
          expect(await Bun.file(join(cwd, "package-lock.json")).json()).toMatchObject({
            packages: { "node_modules/holyagent": { version, resolved: tarball, integrity } },
          })
          const packageDir = join(cwd, "node_modules", "holyagent")
          expect(await readdir(packageDir)).toEqual(["package.json"])
          expect(await Bun.file(join(packageDir, "package.json")).json()).toEqual({
            name: "holyagent",
            version,
          })
          return { exitCode: 0, stdout: JSON.stringify(auditEvidence()) }
        }),
    }),
  )
  expect(calls).toEqual([packageUrl, tarball])
  expect(verified).toEqual({
    runId: 46066785389,
    attempt: 1,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  })
  expect(auditDir).toBeDefined()
  expect(await Bun.file(join(auditDir ?? "", "package-lock.json")).exists()).toBe(false)
})

test("pending applies only to the exact version's missing registry metadata", async () => {
  const calls: string[] = []
  const audit = () => Effect.die("Should not audit unavailable input")
  const result = await Effect.runPromise(
    Effect.result(
      verifyDevPublication(archive, expected, {
        audit,
        request: request(() => new Response(null, { status: 404 }), undefined, calls),
      }),
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw Error("Unexpected successful proof")
  expect(result.failure.pending).toBe(true)
  expect(calls).toEqual([packageUrl])
  await assertHardFailure(
    { audit, request: request(() => new Response(null, { status: 503 })) },
    "HTTP 503",
  )
  await assertHardFailure(
    { audit, request: request(undefined, () => new Response(null, { status: 404 })) },
    "tarball lookup failed",
  )
})

test("checks official package identity, tarball URL, SRI and exact downloaded bytes", async () => {
  const audit = () => Effect.die("Should not audit mismatched tarballs")
  for (const patch of [
    { tarball: tarball.replace("registry.npmjs.org", "example.invalid") },
    { integrity: "sha512-invalid" },
    { signatures: [] },
  ]) {
    const good = metadata()
    await assertHardFailure(
      {
        audit,
        request: request(() => Response.json({ ...good, dist: { ...good.dist, ...patch } })),
      },
      "does not match",
    )
  }
  await assertHardFailure(
    { audit, request: request(() => Response.json({ ...metadata(), name: "other" })) },
    "Invalid npm version metadata",
  )
  const changed = new Uint8Array(bytes)
  changed[changed.length - 1] = 42
  await assertHardFailure(
    { audit, request: request(undefined, () => new Response(changed)) },
    "differs from the exact packed",
  )
})

test("bounds local and remote archives even when HTTP lacks a truthful length", async () => {
  const audit = () => Effect.die("Should not audit oversized input")
  const large = 16 * 1024 * 1024 + 1
  await assertHardFailure(
    {
      audit,
      request: request(
        undefined,
        () => new Response(new Uint8Array(large), { headers: { "Content-Length": "1" } }),
      ),
    },
    "exceeded the evidence limit",
  )
  await truncate(archive, large)
  await assertHardFailure(
    { audit, request: () => Promise.reject(new Error("Must reject large archive before HTTP")) },
    "regular file within the size limit",
  )
})

test("does not treat a malformed or mismatched local archive as a missing publication", async () => {
  const audit = () => Effect.die("Should not audit an invalid archive")
  const registryCalls: string[] = []
  const absent = request(() => new Response(null, { status: 404 }), undefined, registryCalls)
  await Bun.write(archive, "not a gzip-compressed tar archive")
  await assertHardFailure({ audit, request: absent }, "Invalid manifest")
  const wrong = new Bun.Archive({
    "package/package.json": JSON.stringify({ name: "holyagent", version: "0.4.0" }),
  })
  await Bun.write(archive, Bun.gzipSync(await wrong.bytes()))
  await assertHardFailure({ audit, request: absent }, "Dev archive manifest version does not match")
  expect(registryCalls).toEqual([])
})

test("refuses failed npm audits, missing attestations and malformed provenances", async () => {
  const justPublish = auditEvidence()
  justPublish.verified[0]?.attestationBundles.pop()
  for (const [audit, detail] of [
    [() => output(auditEvidence(), 1), "npm rejected"],
    [() => output(justPublish), "Both verified npm publish and SLSA"],
    [() => output(auditEvidence(slsa(), published(), "!bad certificate")), "Missing or malformed"],
    [() => output({ ...auditEvidence(), invalid: [{ name: "holyagent" }] }), "did not verify"],
  ] as const)
    await assertHardFailure({ request: request(), audit }, detail)
})

test("pins verified source, workflow, branch, certificate, both subjects and run location", async () => {
  const cases: ReadonlyArray<readonly [(payload: ReturnType<typeof slsa>) => void, string]> = [
    [
      (p) => {
        p.predicate.buildDefinition.externalParameters.workflow.ref = "refs/heads/main"
      },
      "unexpected workflow/ref",
    ],
    [
      (p) => {
        p.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/dev.yml"
      },
      "unexpected workflow/ref",
    ],
    [
      (p) => {
        p.predicate.buildDefinition.externalParameters.workflow.repository =
          "https://github.com/other/holyagent"
      },
      "repository, dev ref or commit",
    ],
    [
      (p) => {
        p.predicate.buildDefinition.resolvedDependencies = [
          { uri: `git+${source}@refs/heads/main`, digest: { gitCommit: commit } },
        ]
      },
      "repository, dev ref or commit",
    ],
    [
      (p) => {
        p.predicate.buildDefinition.resolvedDependencies = [
          { uri: `git+${source}@refs/heads/dev`, digest: { gitCommit: "f".repeat(40) } },
        ]
      },
      "repository, dev ref or commit",
    ],
    [
      (p) => {
        p.subject = [{ name: "pkg:npm/another@1", digest: { sha512 } }]
      },
      "attestation subject",
    ],
    [
      (p) => {
        p.subject = [{ name: subject()[0]?.name ?? "", digest: { sha512: "0".repeat(128) } }]
      },
      "attestation subject",
    ],
    [
      (p) => {
        p.predicate.runDetails.metadata.invocationId = `${source}/actions/runs/46066785389/attempts/0`
      },
      "exact GitHub run",
    ],
    [
      (p) => {
        p.predicate.runDetails.metadata.invocationId = `${source}/actions/runs/9007199254740992/attempts/1`
      },
      "exact GitHub run",
    ],
    [
      (p) => {
        p.predicate.runDetails.metadata.invocationId = invocationId.replace(
          repository,
          "other/holyagent",
        )
      },
      "exact GitHub run",
    ],
  ]
  for (const [change, detail] of cases) {
    const payload = slsa()
    change(payload)
    await assertHardFailure(
      { request: request(), audit: () => output(auditEvidence(payload)) },
      detail,
    )
  }
  const wrongPackage = published()
  wrongPackage.subject = [{ name: "wrong", digest: { sha512 } }]
  await assertHardFailure(
    { request: request(), audit: () => output(auditEvidence(slsa(), wrongPackage)) },
    "attestation subject",
  )
  const result = await Effect.runPromise(
    Effect.result(
      verifyDevPublication(
        archive,
        { ...expected, repository: "other/holyagent" },
        {
          request: request(),
          audit: () => output(),
        },
      ),
    ),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag !== "Failure") throw Error("Unexpected certificate trust")
  expect(result.failure.detail).toContain("certificate is not for")
})
