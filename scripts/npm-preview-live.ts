import { $ } from "bun"
import { Console, Effect, Schema } from "effect"

import { comparePreviewControls, packPreview } from "./npm-preview-archive.ts"
import {
  parsePreviewEvidence,
  planPreview,
  PreviewBlocked,
  type PreviewEvidence,
} from "./npm-preview.ts"

const repo = "davidbasilefilho/holyagent"
const github = `https://api.github.com/repos/${repo}/`
const npm = "https://registry.npmjs.org/"
const open = <F extends Schema.Struct.Fields>(fields: F) =>
  Schema.StructWithRest(Schema.Struct(fields), [Schema.Record(Schema.String, Schema.Unknown)])
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))
const Branch = open({
  name: Schema.Literal("dev"),
  protected: Schema.Boolean,
  commit: open({ sha: Sha }),
})
const User = open({ login: Schema.String })
const Remote = open({ ref: Schema.String, sha: Sha, repo: Schema.NullOr(open({ id: Schema.Int })) })
const Pull = open({
  number: Schema.Int,
  state: Schema.Literal("open"),
  draft: Schema.Boolean,
  user: User,
  head: Remote,
  base: Remote,
})
const Review = open({
  user: Schema.NullOr(User),
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"]),
  commit_id: Schema.NullOr(Sha),
})
const GitCommit = open({ sha: Sha, committer: open({ date: Schema.String }) })
const Run = open({
  id: Schema.Int,
  run_attempt: Schema.Int,
  path: Schema.String,
  event: Schema.String,
  head_branch: Schema.String,
  head_sha: Sha,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  pull_requests: Schema.Array(
    open({ number: Schema.Int, head: open({ sha: Sha }), base: open({ sha: Sha }) }),
  ),
})
const Runs = open({ total_count: Schema.Int, workflow_runs: Schema.Array(Run) })
const Jobs = open({
  total_count: Schema.Int,
  jobs: Schema.Array(
    open({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
      head_sha: Sha,
    }),
  ),
})
const RegistryVersion = open({
  name: Schema.Literal("holyagent"),
  version: Schema.String,
  dist: open({ integrity: Schema.String }),
})
const Tags = Schema.Record(Schema.String, Schema.String)
const denied = (detail: string) => new PreviewBlocked({ detail })
const decode = <A, I>(schema: Schema.Codec<A, I>, raw: unknown) =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(raw)

const observedPRs = (rows: readonly (typeof Pull.Type)[]) =>
  rows
    .map((p) => [
      p.number,
      p.draft,
      p.user.login,
      p.head.sha,
      p.head.ref,
      p.head.repo?.id,
      p.base.sha,
      p.base.ref,
      p.base.repo?.id,
    ])
    .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])))

const approved = (
  reviews: readonly (typeof Review.Type)[],
  author: string,
  head: string,
  trusted: ReadonlySet<string>,
) => {
  const effective = new Map<string, typeof Review.Type>()
  for (const review of reviews) {
    const login = review.user?.login.toLowerCase()
    if (
      login &&
      login !== author.toLowerCase() &&
      trusted.has(login) &&
      review.state !== "COMMENTED" &&
      review.state !== "PENDING"
    )
      effective.set(login, review)
  }
  const rows = [...effective.values()]
  return (
    !rows.some(({ state }) => state === "CHANGES_REQUESTED") &&
    rows.some(({ state, commit_id }) => state === "APPROVED" && commit_id === head)
  )
}

/** Recheck the chosen operation after the full read; no caller-supplied approval. */
export type PreviewConfirmation = (
  number: number,
  head: string,
  global: boolean,
) => Effect.Effect<void, PreviewBlocked>

/**
 * Read only public npm and GitHub metadata and local exact Git objects; never fetch or execute
 * candidate source.
 */
export const readPreviewEvidence = (
  root: string,
  reviewers: readonly string[],
  token: string | undefined,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
  obtain?: (number: number, head: string) => Effect.Effect<void, PreviewBlocked>,
  setConfirmation?: (confirm: PreviewConfirmation) => void,
) =>
  Effect.tryPromise({
    try: async () => {
      if (!reviewers.length || reviewers.some((reviewer) => !/^[A-Za-z0-9-]+$/.test(reviewer)))
        throw denied("Supply only independently authorized GitHub reviewer logins")
      const trusted = new Set(reviewers.map((reviewer) => reviewer.toLowerCase()))
      const git = async <A, I>(endpoint: string, schema: Schema.Codec<A, I>) => {
        const response = await request(github + endpoint, {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        })
        if (!response.ok)
          throw denied(`Could not read complete GitHub preview evidence (HTTP ${response.status})`)
        return decode(schema, await response.json())
      }
      const registry = (endpoint: string) =>
        request(npm + endpoint, {
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
        })
      const paginate = async <A, I>(endpoint: string, schema: Schema.Codec<A, I>) => {
        const found: A[] = []
        for (let page = 1; page <= 10; page++) {
          const result = await git(`${endpoint}&per_page=100&page=${page}`, Schema.Array(schema))
          found.push(...result)
          if (result.length < 100) return found
        }
        throw denied("GitHub evidence exceeded the bounded pagination limit")
      }
      const openPRs = () => paginate("pulls?state=open", Pull)
      const [source, all] = await Promise.all([git("branches/dev", Branch), openPRs()])
      const checkout = (await $`git --no-replace-objects rev-parse HEAD`.cwd(root).quiet())
        .text()
        .trim()
      if (!source.protected || source.commit.sha !== checkout)
        throw denied("Use a trusted checkout of the current protected dev SHA")
      const validationOf = async (p: typeof Pull.Type) => {
        const runs = await git(
          `actions/workflows/validation.yml/runs?event=pull_request&head_sha=${p.head.sha}&per_page=100`,
          Runs,
        )
        if (runs.total_count !== runs.workflow_runs.length)
          throw denied("Validation run evidence was incomplete")
        const run = runs.workflow_runs
          .filter(
            (r) =>
              r.path === ".github/workflows/validation.yml" &&
              r.event === "pull_request" &&
              r.head_sha === p.head.sha &&
              r.head_branch === p.head.ref &&
              r.pull_requests.some(
                (row) =>
                  row.number === p.number &&
                  row.head.sha === p.head.sha &&
                  row.base.sha === p.base.sha,
              ),
          )
          .toSorted((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)[0]
        let state: "pending" | "success" | "failure" = "pending"
        if (run?.status === "completed") {
          const jobs = await git(
            `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
            Jobs,
          )
          const required = [
            "branch-model",
            "check",
            "windows",
            "installers",
            ...(p.base.ref === "main" ? ["version"] : []),
          ]
          state =
            run.conclusion === "success" &&
            jobs.total_count === jobs.jobs.length &&
            required.every((name) => {
              const matches = jobs.jobs.filter((row) => row.name === name)
              return (
                matches.length === 1 &&
                matches[0]?.head_sha === p.head.sha &&
                matches[0].status === "completed" &&
                matches[0].conclusion === "success"
              )
            })
              ? "success"
              : "failure"
        }
        return { state, attempt: run ? `${run.id}:${run.run_attempt}` : null }
      }
      const confirmed = new Map<number, Awaited<ReturnType<typeof validationOf>>>()
      const candidates: PreviewEvidence["candidates"][number][] = []
      for (const p of all) {
        const commit = await git(`git/commits/${p.head.sha}`, GitCommit)
        if (commit.sha !== p.head.sha) throw denied("GitHub returned a different PR HEAD")
        const sameRepository = p.head.repo !== null && p.head.repo.id === p.base.repo?.id
        const reviews =
          !p.draft && sameRepository && (p.base.ref === "main" || p.base.ref === "dev")
            ? await paginate(`pulls/${p.number}/reviews?`, Review)
            : []
        const candidate: PreviewEvidence["candidates"][number] = {
          number: p.number,
          open: true,
          draft: p.draft,
          base: p.base.ref,
          head: p.head.ref,
          sameRepository,
          author: p.user.login,
          sha: p.head.sha,
          committerUtc: commit.committer.date,
          reviews: reviews.flatMap((review) =>
            review.user && review.commit_id
              ? [{ reviewer: review.user.login, state: review.state, sha: review.commit_id }]
              : [],
          ),
          validation: { sha: p.head.sha, state: "pending" },
        }
        if (!approved(reviews, p.user.login, p.head.sha, trusted)) {
          candidates.push(candidate)
          continue
        }
        if (obtain) await Effect.runPromise(obtain(p.number, p.head.sha))
        const controls = await Effect.runPromise(comparePreviewControls(root, checkout, p.head.sha))
        if (!controls.unchanged) {
          candidates.push({ ...candidate, controls })
          continue
        }
        const validation = await validationOf(p)
        const { state } = validation
        confirmed.set(p.number, validation)
        const packed = await Effect.runPromise(
          packPreview(root, p.number, p.head.sha, commit.committer.date),
        )
        let registryIntegrity: string | null = null
        if (state === "success") {
          const response = await registry(`holyagent/${encodeURIComponent(packed.version)}`)
          if (response.ok) {
            const released = decode(RegistryVersion, await response.json())
            if (released.version !== packed.version)
              throw denied("Registry returned a different immutable version")
            registryIntegrity = released.dist.integrity
          } else if (response.status !== 404)
            throw denied("Registry version evidence was unavailable")
        }
        candidates.push({
          ...candidate,
          controls,
          baseVersion: packed.version.slice(0, packed.version.indexOf("-pr.")),
          validation: { sha: p.head.sha, state },
          artifact: { sha: p.head.sha, expectedIntegrity: packed.integrity, registryIntegrity },
        })
      }
      const [current, after, tags] = await Promise.all([
        git("branches/dev", Branch),
        openPRs(),
        registry("-/package/holyagent/dist-tags"),
      ])
      if (
        !current.protected ||
        current.commit.sha !== checkout ||
        JSON.stringify(observedPRs(all)) !== JSON.stringify(observedPRs(after))
      )
        throw denied("Protected dev or the open PR set moved during the evidence read")
      if (!tags.ok) throw denied("The public npm dist-tags could not be read")
      if (setConfirmation)
        setConfirmation((number, head, global) =>
          Effect.tryPromise({
            try: async () => {
              const selected = all.find((p) => p.number === number && p.head.sha === head)
              const observed = confirmed.get(number)
              if (!selected || observed?.state !== "success")
                throw denied("The target lacks exact reviewed validation")
              if (global) {
                const before = await Effect.runPromise(
                  planPreview({
                    repository: repo,
                    source: { sha: current.commit.sha, checkout, protected: true },
                    trustedReviewers: reviewers,
                    complete: true,
                    candidates,
                    tags: {},
                  }),
                )
                if (before.selected !== number)
                  throw denied("The chosen head is not the global winner")
              }
              const [protectedDev, exact, newest] = await Promise.all([
                git("branches/dev", Branch),
                git(`pulls/${number}`, Pull),
                global ? openPRs() : Promise.resolve(all),
              ])
              if (
                !protectedDev.protected ||
                protectedDev.commit.sha !== checkout ||
                JSON.stringify(observedPRs([exact])) !== JSON.stringify(observedPRs([selected])) ||
                JSON.stringify(observedPRs(newest)) !== JSON.stringify(observedPRs(all))
              )
                throw denied(
                  "The protected source, selected PR, or global winner moved before the write",
                )
              const reviews = await paginate(`pulls/${number}/reviews?`, Review)
              if (!approved(reviews, exact.user.login, head, trusted))
                throw denied("The exact HEAD no longer has independent approval")
              const now = await validationOf(exact)
              if (now.state !== "success" || now.attempt !== observed.attempt)
                throw denied("The approved validation attempt changed before the write")
            },
            catch: (cause) =>
              cause instanceof PreviewBlocked
                ? cause
                : denied("Could not recheck the chosen preview immediately before the write"),
          }),
        )
      return {
        repository: repo,
        source: { sha: current.commit.sha, checkout, protected: current.protected },
        trustedReviewers: reviewers,
        complete: true,
        candidates,
        tags: decode(Tags, await tags.json()),
      }
    },
    catch: (cause) =>
      cause instanceof PreviewBlocked ? cause : denied("Could not collect exact preview evidence"),
  }).pipe(Effect.flatMap(parsePreviewEvidence))

/** Collect and plan against the live sources without performing any mutations. */
export const readPreviewPlan = (
  root: string,
  reviewers: readonly string[],
  token: string | undefined,
  request: (url: string, init: RequestInit) => Promise<Response> = fetch,
) => readPreviewEvidence(root, reviewers, token, request).pipe(Effect.flatMap(planPreview))

if (import.meta.main) {
  await Effect.runPromise(
    readPreviewPlan(process.cwd(), Bun.argv.slice(2), Bun.env["GH_TOKEN"]).pipe(
      Effect.andThen((plan) => Console.log(JSON.stringify(plan, null, 2))),
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
