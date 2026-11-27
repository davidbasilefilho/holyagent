import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"
import { Console, Data, Effect, Schema } from "effect"

import { readDevChannel } from "./npm-publishing.ts"
import { type DevPublicationEvidence, verifyDevPublication } from "./verify-dev-publication.ts"

const repository = "davidbasilefilho/holyagent"
const shaPattern = /^[a-f0-9]{40}$/
const open = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])
const object = open({ sha: Schema.String, type: Schema.String })
const GitRef = open({ object })
const GitTag = open({ object })
const Dev = open({ protected: Schema.Literal(true), commit: open({ sha: Schema.String }) })
const Release = open({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
  assets: Schema.Array(open({ name: Schema.String, digest: Schema.NullOr(Schema.String) })),
})
const Run = open({
  id: Schema.Int,
  run_attempt: Schema.Int,
  head_sha: Schema.String,
  head_branch: Schema.String,
  path: Schema.String,
  event: Schema.String,
  status: Schema.String,
  conclusion: Schema.String,
  repository: open({ full_name: Schema.String }),
  head_repository: open({ full_name: Schema.String }),
})
const Jobs = open({
  total_count: Schema.Int,
  jobs: Schema.Array(
    open({
      name: Schema.String,
      head_sha: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
})
const ManifestVersion = open({ version: Schema.String })

/** The dev prerelease cannot be reconciled without verified source and asset evidence. */
export class RecoveryError extends Data.TaggedError("RecoveryError")<{ readonly detail: string }> {}
const fail = (detail: string) => Effect.fail(new RecoveryError({ detail }))

/** Expected immutable identity of a protected dev release. */
export interface DevReleaseTarget {
  readonly commit: string
  readonly version: string
  readonly sha256: string
}

/** One repository observation. Undefined means an authenticated 404, not a network error. */
export interface DevReleaseState {
  readonly tagCommit?: string
  readonly release?: typeof Release.Type
}

/** A recovery advances exactly one state and never updates an existing tag or asset. */
export type DevReleaseStep = "tag" | "release" | "asset" | "done"

/** Refuse mismatched resources before choosing the next idempotent write. */
export const planDevRelease = (
  expected: DevReleaseTarget,
  state: DevReleaseState,
): Effect.Effect<DevReleaseStep, RecoveryError> =>
  Effect.gen(function* () {
    if (state.tagCommit !== undefined && state.tagCommit !== expected.commit)
      return yield* fail("The dev tag belongs to a different commit")
    if (state.release === undefined) return state.tagCommit === undefined ? "tag" : "release"
    if (
      state.tagCommit === undefined ||
      state.release.tag_name !== `holyagent-${expected.version}` ||
      state.release.draft ||
      !state.release.prerelease
    )
      return yield* fail("The existing release is not the expected dev prerelease")
    const entries = state.release.assets
    if (entries.length === 0) return "asset"
    if (
      entries.length !== 1 ||
      entries[0]?.name !== `holyagent-${expected.version}.tgz` ||
      entries[0]?.digest !== `sha256:${expected.sha256}`
    )
      return yield* fail("The existing dev prerelease asset differs from the verified archive")
    return "done"
  })

/** Require the official protected-push run and its original validation, even after readback failed. */
export const verifyOriginalDevRun = (
  commit: string,
  identity: Pick<DevPublicationEvidence, "runId" | "attempt">,
  run: typeof Run.Type,
  jobs: typeof Jobs.Type,
): Effect.Effect<void, RecoveryError> =>
  Effect.gen(function* () {
    if (
      run.id !== identity.runId ||
      run.run_attempt !== identity.attempt ||
      run.head_sha !== commit ||
      run.head_branch !== "dev" ||
      run.path !== ".github/workflows/publish.yml" ||
      run.event !== "push" ||
      run.repository.full_name !== repository ||
      run.head_repository.full_name !== repository ||
      run.status !== "completed" ||
      !["success", "failure"].includes(run.conclusion) ||
      jobs.total_count !== jobs.jobs.length
    )
      return yield* fail("The signed attempt does not match the official dev push and its jobs")
    for (const [name, allowed] of [
      ["validation / check", ["success"]],
      ["validation / windows", ["success"]],
      ["validation / macos", ["success"]],
      ["validation / installers", ["success"]],
      ["dev / publish", ["success", "failure"]],
    ] as const) {
      const matching = jobs.jobs.filter((job) => job.name === name)
      const job = matching[0]
      if (
        matching.length !== 1 ||
        job?.head_sha !== commit ||
        job.status !== "completed" ||
        !allowed.some((result) => result === job.conclusion)
      )
        return yield* fail(`Original dev attempt lacks an exact completed result for ${name}`)
    }
  })

/** Read-only release observations and narrowly scoped GitHub write steps. */
export interface DevReleaseIO {
  readonly observe: Effect.Effect<DevReleaseState, RecoveryError>
  readonly confirmCurrentDev: Effect.Effect<void, RecoveryError>
  readonly write: (step: Exclude<DevReleaseStep, "done">) => Effect.Effect<void, RecoveryError>
}

/** Verify again after every write. An accepted concurrent write must have advanced exact state. */
export const reconcileDevRelease = (expected: DevReleaseTarget, io: DevReleaseIO) =>
  Effect.gen(function* () {
    let step = yield* io.observe.pipe(Effect.flatMap((state) => planDevRelease(expected, state)))
    for (let remaining = 3; step !== "done" && remaining > 0; remaining--) {
      yield* io.confirmCurrentDev
      const confirmed = yield* io.observe.pipe(
        Effect.flatMap((state) => planDevRelease(expected, state)),
      )
      if (confirmed !== step) {
        step = confirmed
        continue
      }
      const attempted = yield* Effect.result(io.write(step))
      const observed = yield* io.observe.pipe(
        Effect.flatMap((state) => planDevRelease(expected, state)),
      )
      if (observed === step) {
        if (attempted._tag === "Failure") return yield* attempted.failure
        return yield* fail("The GitHub write did not advance the verified dev release state")
      }
      step = observed
    }
    if (step !== "done")
      return yield* fail("The dev prerelease did not reach its verified final state")
    yield* io.confirmCurrentDev
  })

const local = (command: Bun.$.ShellPromise, detail: string) =>
  Effect.tryPromise({
    try: () => command.quiet().text(),
    catch: () => new RecoveryError({ detail }),
  })

const github = (token: string) => {
  const get = (path: string, missing = false) =>
    Effect.tryPromise({
      try: async (): Promise<unknown> => {
        const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
          cache: "no-store",
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        })
        if (missing && response.status === 404) return undefined
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      },
      catch: () => new RecoveryError({ detail: `Could not read GitHub evidence at ${path}` }),
    })
  const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
      Effect.mapError(() => new RecoveryError({ detail: "Invalid GitHub evidence" })),
    )
  const read = <S extends Schema.Top>(path: string, schema: S) =>
    get(path).pipe(Effect.flatMap((input) => decode(schema, input)))
  const optional = <S extends Schema.Top>(path: string, schema: S) =>
    get(path, true).pipe(
      Effect.flatMap((input) =>
        input === undefined ? Effect.succeed(undefined) : decode(schema, input),
      ),
    )
  const observe = (tag: string) =>
    Effect.gen(function* () {
      const ref = yield* optional(`git/ref/tags/${tag}`, GitRef)
      const release = yield* optional(`releases/tags/${tag}`, Release)
      const state = release === undefined ? {} : { release }
      if (ref === undefined) return state
      if (!shaPattern.test(ref.object.sha)) return yield* fail("Invalid dev tag object SHA")
      const resolved =
        ref.object.type === "tag"
          ? (yield* read(`git/tags/${ref.object.sha}`, GitTag)).object
          : ref.object
      if (resolved.type !== "commit" || !shaPattern.test(resolved.sha))
        return yield* fail("The dev tag does not resolve to exactly one commit")
      return { ...state, tagCommit: resolved.sha }
    })
  return { read, observe }
}

const exactVersion = (commit: string) =>
  Effect.gen(function* () {
    const raw = yield* local(
      $`git show ${`${commit}:package.json`}`,
      "Cannot read the exact source manifest",
    )
    const manifest = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ManifestVersion), {
      onExcessProperty: "error",
    })(raw).pipe(Effect.mapError(() => new RecoveryError({ detail: "Invalid source version" })))
    const parts = /^(0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))(?:-[1-9][0-9]*)?$/.exec(
      manifest.version,
    )
    if (parts?.[1] === undefined) return yield* fail("Invalid source version")
    const sourceDate = yield* local(
      $`TZ=UTC0 git show -s --format=%cd --date=format-local:%Y-%m-%d.%H-%M-%S ${commit}`,
      "Cannot read source date",
    )
    const stamp = sourceDate.trim()
    if (!/^\d{4}-\d{2}-\d{2}\.\d{2}-\d{2}-\d{2}$/.test(stamp))
      return yield* fail("Invalid source date")
    return `${parts[1]}-dev.${stamp}.g${commit.slice(0, 7)}`
  })

const rebuild = (directory: string, commit: string, version: string) =>
  Effect.gen(function* () {
    const staging = join(directory, "pack")
    const tree = `${commit}:packages/integrations/pi/dist`
    const modes = (yield* local(
      $`git ls-tree -r ${"--format=%(objectmode)"} ${tree}`,
      "Cannot read the committed Pi tree",
    ))
      .trim()
      .split("\n")
    if (modes.length > 1000 || modes.some((mode) => mode !== "100644" && mode !== "100755"))
      return yield* fail("The committed Pi tree contains an unsupported file mode")
    yield* local($`mkdir ${staging}`, "Cannot create a scratch package directory")
    // Packing the immutable Git tree executes no historical scripts. Ubuntu's 022 modes are part of
    // the released tarball. Git archive does not use the checkout's file permissions by default.
    const extract =
      'set -euo pipefail; umask 022; git -c tar.umask=0022 archive "$1" | tar -x --no-same-permissions -C "$2"'
    yield* local(
      $`bash --noprofile --norc -c ${extract} bash ${tree} ${staging}`,
      "Cannot reconstruct the exact committed Pi distribution",
    )
    const manifest = join(staging, "package.json")
    const stamped = join(directory, "package.json")
    yield* local(
      $`jq --arg version ${version} '.version = $version' ${manifest} > ${stamped}`,
      "Cannot stamp the exact archived version",
    )
    yield* local($`cp ${stamped} ${manifest}`, "Cannot write scratch package manifest")
    yield* local(
      $`bun pm pack --destination ${directory}`.cwd(staging),
      "Cannot reproduce the archived dev package",
    )
    return join(directory, `holyagent-${version}.tgz`)
  })

const main = (kind: string, input: string, dryRun: boolean) =>
  Effect.gen(function* () {
    const current = process.env.GITHUB_SHA ?? ""
    const token = process.env.GH_TOKEN ?? ""
    if (
      process.env.GITHUB_REPOSITORY !== repository ||
      process.env.GITHUB_REF !== "refs/heads/dev" ||
      !shaPattern.test(current) ||
      !token ||
      (kind !== "previous" && kind !== "current")
    )
      return yield* fail("Recovery runs only in the official protected dev workflow")
    const gh = github(token)
    const confirmCurrentDev = gh
      .read("branches/dev", Dev)
      .pipe(
        Effect.flatMap(({ commit }) =>
          commit.sha === current ? Effect.void : fail("The protected dev head moved"),
        ),
      )
    yield* confirmCurrentDev
    const seen = yield* local($`git rev-parse HEAD`, "Cannot read the checked-out SHA")
    if (seen.trim() !== current)
      return yield* fail("The checked-out code is not the current dev workflow")
    if (kind === "previous" && input === "0".repeat(40)) return
    const commit = kind === "previous" ? input : current
    if (!shaPattern.test(commit)) return yield* fail("Invalid dev predecessor")
    if (kind === "previous") {
      const parent = yield* local(
        $`git rev-parse ${`${current}^`}`,
        "Cannot read the previous protected dev commit",
      )
      if (parent.trim() !== commit)
        return yield* fail("The push before SHA is not the current first parent")
    }
    const version = yield* exactVersion(commit)
    const scratch = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "holyagent-dev-recovery-")),
        catch: () => new RecoveryError({ detail: "Cannot allocate recovery scratch" }),
      }),
      (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
    )
    const path = kind === "previous" ? yield* rebuild(scratch, commit, version) : input
    const archive = Bun.file(path)
    const sha256 = yield* Effect.tryPromise({
      try: async () => {
        if (!archive.size || archive.size > 24 * 1024 * 1024)
          throw new Error("Unexpected archive size")
        return new Bun.CryptoHasher("sha256").update(await archive.arrayBuffer()).digest("hex")
      },
      catch: () => new RecoveryError({ detail: "Cannot hash the expected dev archive" }),
    })
    const expected = { commit, version, sha256 }
    const tag = `holyagent-${version}`
    const observe = gh.observe(tag)
    const confirmReleaseTarget =
      kind === "current"
        ? confirmCurrentDev.pipe(
            Effect.andThen(readDevChannel("holyagent", fetch)),
            Effect.mapError(
              () => new RecoveryError({ detail: "Cannot confirm the current npm dev channel" }),
            ),
            Effect.flatMap((visible) =>
              visible === version
                ? Effect.void
                : fail("The current npm dev channel points at another version"),
            ),
          )
        : confirmCurrentDev
    const initial = yield* observe.pipe(Effect.flatMap((state) => planDevRelease(expected, state)))
    if (initial === "done") {
      yield* confirmReleaseTarget
      return yield* Console.log(`${tag} already has its exact asset`)
    }
    const verified = yield* Effect.result(
      verifyDevPublication(path, { repository, commit, version }),
    )
    if (verified._tag === "Failure") {
      if (kind === "previous" && verified.failure.pending && initial === "tag")
        return yield* Console.log(
          `Previous dev package ${version} is not public; no recovery write`,
        )
      return yield* fail(verified.failure.detail)
    }
    const evidence = verified.success
    if (evidence.sha256 !== sha256)
      return yield* fail("The verified archive changed before release")
    if (kind === "previous" || dryRun) {
      const attemptPath = `actions/runs/${evidence.runId}/attempts/${evidence.attempt}`
      const [run, jobs] = yield* Effect.all(
        [gh.read(attemptPath, Run), gh.read(`${attemptPath}/jobs?per_page=100`, Jobs)],
        { concurrency: 2 },
      )
      yield* verifyOriginalDevRun(commit, evidence, run, jobs)
    }
    if (dryRun) {
      yield* confirmReleaseTarget
      return yield* Console.log(`Verified ${tag} at ${commit}; next step ${initial}; no writes`)
    }
    yield* reconcileDevRelease(expected, {
      observe,
      confirmCurrentDev: confirmReleaseTarget,
      write: (step) => {
        if (step === "tag")
          return local(
            $`gh api --method POST ${`repos/${repository}/git/refs`} -f ${`ref=refs/tags/${tag}`} -f ${`sha=${commit}`}`,
            "Cannot create the exact immutable dev tag",
          ).pipe(Effect.asVoid)
        if (step === "release")
          return local(
            $`gh release create ${tag} --repo ${repository} --verify-tag --prerelease --latest=false --title ${`HolyAgent ${version}`} --notes ${`Development build at ${commit}.`}`,
            "Cannot create the dev prerelease",
          ).pipe(Effect.asVoid)
        return local(
          $`gh release upload ${tag} ${path} --repo ${repository}`,
          "Cannot attach the verified dev archive",
        ).pipe(Effect.asVoid)
      },
    })
    yield* Console.log(`Verified dev prerelease ${tag}`)
  })

if (import.meta.main) {
  const [kind = "", input = "", mode, ...extra] = Bun.argv.slice(2)
  await Effect.runPromise(
    (extra.length > 0 || (mode !== undefined && mode !== "--dry-run")
      ? fail("Expected previous <SHA> or current <archive>, with optional --dry-run")
      : main(kind, input, mode === "--dry-run")
    ).pipe(
      Effect.scoped,
      Effect.catch((error) =>
        Console.error(error.detail).pipe(
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
