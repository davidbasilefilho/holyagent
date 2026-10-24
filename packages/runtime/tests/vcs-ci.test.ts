import { afterEach, describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { ciLine, summarize, TIMEOUT_EXIT, watchCi } from "../src/vcs/ci.ts"
import { cleanup, failure, fakeGitHub, initRepo, seed, sh, vcs } from "./vcs-fixtures.ts"

afterEach(cleanup)

const SHA = "0123456789abcdef0123456789abcdef01234567"

const run = (name: string, conclusion: string | null, status = "completed") => ({
  name,
  status: conclusion === null ? "in_progress" : status,
  conclusion,
})

/**
 * A GitHub whose checks come from `polls`: each poll of the check-runs endpoint takes the next
 * entry (the last repeats).
 */
const ciGithub = (
  polls: ReadonlyArray<{
    runs?: ReadonlyArray<ReturnType<typeof run>>
    statuses?: ReadonlyArray<{ context: string; state: string }>
    mergeable?: boolean | null
    state?: string
  }>,
) => {
  let poll = 0
  const at = () => polls[Math.min(poll, polls.length - 1)] ?? {}
  return fakeGitHub({
    rest: (request) => {
      if (/\/pulls\/\d+$/.test(request.path))
        return {
          head: { sha: SHA },
          mergeable: at().mergeable === undefined ? true : at().mergeable,
          mergeable_state: at().state ?? "clean",
        }
      if (request.path.includes("/check-runs")) {
        const runs = at().runs ?? []
        poll += 1
        return { total_count: runs.length, check_runs: runs }
      }
      if (request.path.includes("/status")) return { statuses: at().statuses ?? [] }
      return undefined
    },
  })
}

const REPO = "octo/project"
const target = { pull: 7 } as const
const fast = (emit: (text: string) => Effect.Effect<void>, over = {}) => ({
  timeoutMillis: 5000,
  intervalMillis: 1,
  graceMillis: 0,
  emit,
  ...over,
})

describe("the ci line", () => {
  test("counts checks and statuses and names what failed", async () => {
    const gh = ciGithub([
      {
        runs: [
          run("build", "success"),
          run("lint", "failure"),
          run("docs", "skipped"),
          run("deploy", null),
          run("test", "timed_out"),
        ],
        statuses: [
          { context: "legacy/ci", state: "success" },
          { context: "legacy/slow", state: "pending" },
          { context: "legacy/bad", state: "error" },
        ],
        state: "blocked",
      },
    ])

    const summary = await Effect.runPromise(summarize(REPO, target).pipe(Effect.provide(gh.layer)))

    expect(ciLine(summary)).toBe(
      "sha=0123456 failed=3 pending=2 passed=3 mergeable=true state=blocked failing: lint,test,legacy/bad",
    )
  })

  test("check names are printed without control characters and are capped", async () => {
    const gh = ciGithub([
      { runs: [run("evil\u001b[2J\nname", "failure"), run("x".repeat(500), "failure")] },
    ])
    const summary = await Effect.runPromise(summarize(REPO, target).pipe(Effect.provide(gh.layer)))
    const line = ciLine(summary)
    expect(line).not.toMatch(/\p{Cc}/u)
    expect(summary.failed[0]).toBe("evil [2J name")
    expect(summary.failed[1]).toHaveLength(80)
  })

  test("statuses are asked for 100 at a time", async () => {
    const gh = ciGithub([{ runs: [run("a", "success")] }])
    await Effect.runPromise(summarize(REPO, target).pipe(Effect.provide(gh.layer)))
    expect(gh.routes().some((route) => route.endsWith("/status?per_page=100"))).toBe(true)
  })

  test("an all-green pull request prints no failing list; mergeability still computing reads unknown", async () => {
    const gh = ciGithub([{ runs: [run("build", "success")], mergeable: null, state: "unknown" }])
    const summary = await Effect.runPromise(summarize(REPO, target).pipe(Effect.provide(gh.layer)))
    expect(ciLine(summary)).toBe(
      "sha=0123456 failed=0 pending=0 passed=1 mergeable=unknown state=unknown",
    )
  })

  test("a commit has no mergeability to report", async () => {
    const gh = ciGithub([{ runs: [run("build", "success")] }])
    const summary = await Effect.runPromise(
      summarize(REPO, { sha: SHA }).pipe(Effect.provide(gh.layer)),
    )
    expect(ciLine(summary)).toBe("sha=0123456 failed=0 pending=0 passed=1 mergeable=- state=-")
    expect(gh.routes().some((route) => route.includes("/pulls/"))).toBe(false)
  })

  test("every page of check runs is counted", async () => {
    const page = (names: ReadonlyArray<string>, total: number) => ({
      total_count: total,
      check_runs: names.map((name) => run(name, "success")),
    })
    const first = Array.from({ length: 100 }, (_, i) => `a${i}`)
    const gh = fakeGitHub({
      rest: (request) =>
        request.path.endsWith("&page=1")
          ? page(first, 101)
          : request.path.endsWith("&page=2")
            ? page(["last"], 101)
            : request.path.includes("/status")
              ? { statuses: [] }
              : undefined,
    })
    const summary = await Effect.runPromise(
      summarize(REPO, { sha: SHA }).pipe(Effect.provide(gh.layer)),
    )
    expect(summary.passed).toBe(101)
  })
})

describe("watching", () => {
  test("prints a line only when the line changes and exits 0 once nothing is pending", async () => {
    const gh = ciGithub([
      { runs: [run("a", null), run("b", null)] },
      { runs: [run("a", null), run("b", null)] },
      { runs: [run("a", "success"), run("b", null)] },
      { runs: [run("a", "success"), run("b", "success")] },
    ])
    const lines: Array<string> = []

    const code = await Effect.runPromise(
      watchCi(
        REPO,
        target,
        fast((text) => Effect.sync(() => void lines.push(text))),
      ).pipe(Effect.provide(gh.layer)),
    )

    expect(code).toBe(0)
    expect(lines).toEqual([
      "sha=0123456 failed=0 pending=2 passed=0 mergeable=true state=clean\n",
      "sha=0123456 failed=0 pending=1 passed=1 mergeable=true state=clean\n",
      "sha=0123456 failed=0 pending=0 passed=2 mergeable=true state=clean\n",
    ])
  })

  test("exits 1 when a check failed, even while others passed", async () => {
    const gh = ciGithub([{ runs: [run("a", "success"), run("b", "failure")] }])
    const lines: Array<string> = []
    const code = await Effect.runPromise(
      watchCi(
        REPO,
        target,
        fast((text) => Effect.sync(() => void lines.push(text))),
      ).pipe(Effect.provide(gh.layer)),
    )
    expect(code).toBe(1)
    expect(lines.at(-1)).toContain("failing: b")
  })

  test("keeps waiting while a check is still pending and gives up at the timeout with 124", async () => {
    const gh = ciGithub([{ runs: [run("a", null)] }])
    const lines: Array<string> = []
    const code = await Effect.runPromise(
      watchCi(
        REPO,
        target,
        fast((text) => Effect.sync(() => void lines.push(text)), { timeoutMillis: 30 }),
      ).pipe(Effect.provide(gh.layer)),
    )
    expect(code).toBe(TIMEOUT_EXIT)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain("pending=1")
    expect(lines[1]).toMatch(/^timeout after \d+s\n$/)
  })

  test("transient GitHub failures are waited out, others end the watch", async () => {
    let calls = 0
    const flaky = (status: number, failures: number) =>
      fakeGitHub({
        rest: (request) => {
          if (request.path.includes("/check-runs")) {
            calls += 1
            return calls <= failures
              ? failure(status, "Bad Gateway")
              : { total_count: 1, check_runs: [run("a", "success")] }
          }
          return request.path.includes("/status") ? { statuses: [] } : undefined
        },
      })
    const lines: Array<string> = []
    const emit = (text: string) => Effect.sync(() => void lines.push(text))

    calls = 0
    const recovered = await Effect.runPromise(
      watchCi(REPO, { sha: SHA }, fast(emit)).pipe(Effect.provide(flaky(502, 2).layer)),
    )
    expect(recovered).toBe(0)
    expect(lines.filter((line) => line.startsWith("github error"))).toHaveLength(1)

    calls = 0
    const gaveUp = await Effect.runPromise(
      watchCi(REPO, { sha: SHA }, fast(emit, { timeoutMillis: 20 })).pipe(
        Effect.provide(flaky(502, 1000).layer),
      ),
    )
    expect(gaveUp).toBe(TIMEOUT_EXIT)

    calls = 0
    const failed = await Effect.runPromise(
      Effect.flip(
        watchCi(REPO, { sha: SHA }, fast(emit)).pipe(Effect.provide(flaky(404, 1000).layer)),
      ),
    )
    expect(failed.message).toContain("404")
  })

  test("a commit without any check is waited for during the grace period, then counts as green", async () => {
    const gh = ciGithub([{ runs: [] }, { runs: [] }, { runs: [run("late", "success")] }])
    const early = await Effect.runPromise(
      watchCi(
        REPO,
        target,
        fast(() => Effect.void, { graceMillis: 60_000, timeoutMillis: 5000 }),
      ).pipe(Effect.provide(gh.layer)),
    )
    expect(early).toBe(0)
    expect(gh.routes().filter((route) => route.includes("/check-runs"))).toHaveLength(3)

    const none = ciGithub([{ runs: [] }])
    expect(
      await Effect.runPromise(
        watchCi(
          REPO,
          target,
          fast(() => Effect.void, { graceMillis: 10 }),
        ).pipe(Effect.provide(none.layer)),
      ),
    ).toBe(0)
  })
})

describe("vcs ci on the command line", () => {
  const origin = async () => {
    const dir = await initRepo()
    await sh(dir, ["git", "remote", "add", "origin", "https://github.com/octo/project.git"])
    await seed(dir, { "a.txt": "a\n" })
    return dir
  }

  test("prints one line for a pull request and exits 0", async () => {
    const dir = await origin()
    const result = await vcs(
      dir,
      ["vcs", "ci", "7"],
      ciGithub([{ runs: [run("a", "failure")] }]).layer,
    )
    expect(result).toMatchObject({
      code: 0,
      stdout: "sha=0123456 failed=1 pending=0 passed=0 mergeable=true state=clean failing: a\n",
    })
  })

  test("--watch ends with the watch's exit code", async () => {
    const dir = await origin()
    const result = await vcs(
      dir,
      ["vcs", "ci", "7", "--watch"],
      ciGithub([{ runs: [run("a", "failure")] }]).layer,
    )
    expect(result.code).toBe(1)
    expect(result.stdout).toContain("failed=1")
  })

  test("--timeout 0 ends a pending watch at once with 124", async () => {
    const dir = await origin()
    const result = await vcs(
      dir,
      ["vcs", "ci", SHA.slice(0, 10), "--watch", "--timeout", "0"],
      ciGithub([{ runs: [run("a", null)] }]).layer,
    )
    expect(result.code).toBe(124)
  })

  test("a target that is neither a number nor a commit is a usage error", async () => {
    const dir = await origin()
    expect((await vcs(dir, ["vcs", "ci", "main"], ciGithub([{}]).layer)).code).toBe(2)
  })
})
