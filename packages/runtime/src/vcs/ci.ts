import { Clock, Effect, Schema } from "effect"

import { Usage } from "../cli/errors.ts"
import { decodeAnswer, GitHub } from "./github.ts"

const Pull = Schema.Struct({
  head: Schema.Struct({ sha: Schema.String }),
  mergeable: Schema.NullOr(Schema.Boolean),
  mergeable_state: Schema.String,
})
const CheckRuns = Schema.Struct({
  total_count: Schema.Int,
  check_runs: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      status: Schema.String,
      conclusion: Schema.NullOr(Schema.String),
    }),
  ),
})
const Statuses = Schema.Struct({
  statuses: Schema.Array(Schema.Struct({ context: Schema.String, state: Schema.String })),
})

/** The CI picture of one commit at one moment. */
export interface CiSummary {
  readonly sha: string
  readonly failed: ReadonlyArray<string>
  readonly pending: number
  readonly passed: number
  readonly mergeable: string
  readonly state: string
}

/** The one-line form: counts, mergeability, and the failing names when there are any. */
export const ciLine = (summary: CiSummary): string => {
  const line = `sha=${summary.sha.slice(0, 7)} failed=${summary.failed.length} pending=${summary.pending} passed=${summary.passed} mergeable=${summary.mergeable} state=${summary.state}`
  return summary.failed.length === 0 ? line : `${line} failing: ${summary.failed.join(",")}`
}

const PAGE = 100
const PASSING = new Set(["success", "neutral", "skipped"])

type Verdict = "failed" | "pending" | "passed"

const checkVerdict = (run: { status: string; conclusion: string | null }): Verdict =>
  run.status !== "completed" ? "pending" : PASSING.has(run.conclusion ?? "") ? "passed" : "failed"

const statusVerdict = (state: string): Verdict =>
  state === "success" ? "passed" : state === "pending" ? "pending" : "failed"

const allCheckRuns = (repo: string, sha: string) =>
  Effect.gen(function* () {
    const runs: Array<Schema.Schema.Type<typeof CheckRuns>["check_runs"][number]> = []
    for (let page = 1; ; page += 1) {
      const answer = yield* GitHub.use((github) =>
        github.rest({
          method: "GET",
          path: `repos/${repo}/commits/${sha}/check-runs?per_page=${PAGE}&page=${page}`,
        }),
      )
      const decoded = yield* decodeAnswer(CheckRuns, "GET check-runs", answer)
      runs.push(...decoded.check_runs)
      if (decoded.check_runs.length < PAGE || runs.length >= decoded.total_count) return runs
    }
  })

/** Where to look: a pull request number (its head commit, its mergeability) or a commit. */
export const parseTarget = (target: string) => {
  if (/^\d{1,6}$/.test(target)) return Effect.succeed({ pull: Number(target) } as const)
  if (/^[0-9a-f]{7,40}$/i.test(target)) return Effect.succeed({ sha: target } as const)
  return Effect.fail(
    new Usage({
      message: `"${target}" is neither a pull request number nor a commit id`,
      hint: "Usage: holyagent-runtime vcs ci <pr-number|sha> [--watch [--timeout <s>]]",
    }),
  )
}

/** Reads the check runs and commit statuses of the target and counts them. */
export const summarize = (repo: string, target: { pull: number } | { sha: string }) =>
  Effect.gen(function* () {
    const pull =
      "pull" in target
        ? yield* GitHub.use((github) =>
            github.rest({ method: "GET", path: `repos/${repo}/pulls/${target.pull}` }),
          ).pipe(Effect.flatMap((answer) => decodeAnswer(Pull, "GET pull request", answer)))
        : undefined
    const sha = pull?.head.sha ?? ("sha" in target ? target.sha : "")
    const runs = yield* allCheckRuns(repo, sha)
    const statuses = yield* GitHub.use((github) =>
      github.rest({ method: "GET", path: `repos/${repo}/commits/${sha}/status` }),
    ).pipe(Effect.flatMap((answer) => decodeAnswer(Statuses, "GET status", answer)))

    const verdicts = [
      ...runs.map((run) => ({ name: run.name, verdict: checkVerdict(run) })),
      ...statuses.statuses.map((status) => ({
        name: status.context,
        verdict: statusVerdict(status.state),
      })),
    ]
    const count = (verdict: Verdict) => verdicts.filter((row) => row.verdict === verdict).length
    return {
      sha,
      failed: verdicts.filter((row) => row.verdict === "failed").map((row) => row.name),
      pending: count("pending"),
      passed: count("passed"),
      mergeable:
        pull === undefined ? "-" : pull.mergeable === null ? "unknown" : String(pull.mergeable),
      state: pull?.mergeable_state ?? "-",
    } satisfies CiSummary
  })

/** How `--watch` polls and when it gives up. */
export interface WatchOptions {
  readonly timeoutMillis: number
  readonly intervalMillis: number
  /** How long a commit without any check yet still counts as waiting, since CI starts late. */
  readonly graceMillis: number
  readonly emit: (text: string) => Effect.Effect<void>
}

/** The exit code of a watch that ran out of time, as `timeout(1)` uses. */
export const TIMEOUT_EXIT = 124

/**
 * Polls the target, printing a line whenever it changes, until no check is pending (exit 0 when
 * nothing failed, else 1) or the timeout passes (exit 124).
 */
export const watchCi = (
  repo: string,
  target: { pull: number } | { sha: string },
  options: WatchOptions,
) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const step = (last: string | undefined): Effect.Effect<number, unknown, GitHub> =>
      Effect.gen(function* () {
        const summary = yield* summarize(repo, target)
        const line = ciLine(summary)
        if (line !== last) yield* options.emit(`${line}\n`)
        const elapsed = (yield* Clock.currentTimeMillis) - started
        const checks = summary.failed.length + summary.pending + summary.passed
        if (summary.pending === 0 && (checks > 0 || elapsed >= options.graceMillis))
          return summary.failed.length > 0 ? 1 : 0
        if (elapsed >= options.timeoutMillis) {
          yield* options.emit(`timeout after ${Math.round(elapsed / 1000)}s\n`)
          return TIMEOUT_EXIT
        }
        yield* Effect.sleep(options.intervalMillis)
        return yield* step(line)
      })
    return yield* step(undefined)
  })
