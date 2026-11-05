import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"

// Tests that run git processes: process creation on Windows is slow enough on the CI runner to pass
// Bun's 5 second default, and a slow test there is not a hung one. Linux and macOS keep the default.
if (process.platform === "win32") setDefaultTimeout(60_000)
afterAll(() => setDefaultTimeout(5_000))

let project: string

beforeEach(async () => {
  // The real path: on Windows the temporary folder is named by its 8.3 short form (`RUNNER~1`), and
  // the CLI reports the long form.
  project = await realpath(await mkdtemp(join(tmpdir(), "holyagent-reports-")))
})
afterEach(() => rm(project, { recursive: true, force: true }))

const cli = (argv: ReadonlyArray<string>) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: project, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdin: Effect.fail(new StdinMissing({ reason: "no stdin in this test" })),
    }),
  )

const FIRST = "assignment-0mvzlcjd8-cyp6"
const SECOND = "assignment-0mvzlcjd9-abcd"

/** A journal as a Workflow run writes it: entries carry fields beyond the ones the command reads. */
const journal = (...lines: ReadonlyArray<unknown>) => lines.map((l) => JSON.stringify(l)).join("\n")

const started = (key: string, label: string) => ({
  type: "started",
  key,
  agentId: `agent-${key}`,
  label,
  at: "2026-11-02T18:00:00Z",
})
const result = (key: string, value: unknown) => ({
  type: "result",
  key,
  agentId: `agent-${key}`,
  result: value,
  durationMs: 1200,
})

const writeJournal = async (...lines: ReadonlyArray<unknown>) => {
  await Bun.write(join(project, "journal.jsonl"), `${journal(...lines)}\n`)
  return "journal.jsonl"
}

describe("assignment reports", () => {
  test("writes each result to a file named by its Assignment id and prints id, path and word count", async () => {
    await $`git init -q -b main`.cwd(project).quiet()
    const path = await writeJournal(
      started("k1", FIRST),
      started("k2", SECOND),
      { type: "progress", key: "k1", note: "halfway" },
      result("k2", "Second report.\nevidence:\n- tests: passed"),
      result("k1", "First report with seven words in it."),
    )

    const done = await cli(["assignment", "reports", path])

    expect(done.stderr).toBe("")
    expect(done.code).toBe(0)
    const folder = join(project, ".git", "holyagent", "reports")
    expect(decode(done.stdout)).toEqual({
      reports: [
        { id: SECOND, path: join(folder, `${SECOND}.md`), words: 6 },
        { id: FIRST, path: join(folder, `${FIRST}.md`), words: 7 },
      ],
      notAssignmentIds: [],
    })
    expect(await Bun.file(join(folder, `${FIRST}.md`)).text()).toBe(
      "First report with seven words in it.\n",
    )
    expect(await Bun.file(join(folder, `${SECOND}.md`)).text()).toContain("- tests: passed")
    // Only the journal is in the work tree.
    expect((await $`git status --porcelain`.cwd(project).quiet().text()).trim()).toBe(
      "?? journal.jsonl",
    )
  })

  test("outside a repository the reports go to local/reports of the state folder", async () => {
    const path = await writeJournal(started("k1", FIRST), result("k1", "Done."))

    const done = await cli(["assignment", "reports", path])

    expect(done.code).toBe(0)
    expect(await readdir(join(project, ".holyagent", "local", "reports"))).toEqual([`${FIRST}.md`])
  })

  test("a label that is not an Assignment id is listed and never becomes a path", async () => {
    const path = await writeJournal(
      started("k1", "../../escape"),
      started("k2", "review the parser"),
      started("k3", FIRST),
      result("k1", "Out."),
      result("k2", "Reviewed."),
      result("k3", "In."),
      result("k4", "No start entry."),
    )

    const done = await cli(["assignment", "reports", path])

    expect(done.code).toBe(0)
    const rows = decode(done.stdout) as {
      reports: Array<{ id: string }>
      notAssignmentIds: unknown
    }
    expect(rows.reports.map((row) => row.id)).toEqual([FIRST])
    expect(rows.notAssignmentIds).toEqual([
      { label: "../../escape", agentId: "agent-k1" },
      { label: "review the parser", agentId: "agent-k2" },
      { label: "", agentId: "agent-k4" },
    ])
    expect(await readdir(join(project, ".holyagent", "local", "reports"))).toEqual([`${FIRST}.md`])
    expect(await Bun.file(join(project, "escape.md")).exists()).toBe(false)
  })

  test("a result that is a JSON report is written as the text of a plain report", async () => {
    const path = await writeJournal(
      started("k1", FIRST),
      result("k1", {
        status: "done",
        changed_paths: ["src/a.ts"],
        checks: [{ command: "bun test", exit: 0 }],
        blockers: [],
        notes: [],
        evidence: [{ key: "tests", support: "bun test passed" }],
      }),
    )

    const done = await cli(["assignment", "reports", path])

    expect(done.code).toBe(0)
    const text = await Bun.file(
      join(project, ".holyagent", "local", "reports", `${FIRST}.md`),
    ).text()
    expect(text).toContain("status: done")
    expect(text).toContain("evidence:\n- tests: bun test passed")
  })

  test("a null result is no result: it is not listed and writes no file", async () => {
    const path = await writeJournal(
      started("k1", FIRST),
      started("k2", SECOND),
      result("k1", null),
      result("k2", "Done."),
    )

    const done = await cli(["assignment", "reports", path])

    expect(done.code).toBe(0)
    const rows = decode(done.stdout) as { reports: Array<{ id: string }> }
    expect(rows.reports.map((row) => row.id)).toEqual([SECOND])
    expect(await readdir(join(project, ".holyagent", "local", "reports"))).toEqual([`${SECOND}.md`])
  })

  test("an empty or whitespace result is no result: it is not listed and writes no file", async () => {
    const path = await writeJournal(
      started("k1", FIRST),
      started("k2", SECOND),
      started("k3", "assignment-0mvzlcjda-wxyz"),
      result("k1", ""),
      result("k3", " \n\t "),
      result("k2", "Done."),
    )

    const done = await cli(["assignment", "reports", path])

    expect(done.code).toBe(0)
    const rows = decode(done.stdout) as { reports: Array<{ id: string }> }
    expect(rows.reports.map((row) => row.id)).toEqual([SECOND])
    expect(await readdir(join(project, ".holyagent", "local", "reports"))).toEqual([`${SECOND}.md`])
  })

  test("a malformed journal is refused with a tagged error and writes nothing", async () => {
    const path = join(project, "journal.jsonl")
    for (const bad of [
      `${journal(started("k1", FIRST), result("k1", "Fine."))}\nnot json\n`,
      `${journal(started("k1", FIRST), { type: "started", key: "k2", agentId: "a" })}\n`,
      `${journal({ type: "result", key: "k1", agentId: "a" })}\n`,
    ]) {
      await Bun.write(path, bad)

      const refused = await cli(["assignment", "reports", "journal.jsonl"])

      expect(refused.code).toBe(2)
      expect(refused.stderr).toStartWith("error: Usage: Line ")
      expect(refused.stderr).toContain("hint:")
      expect(
        await Bun.file(join(project, ".holyagent", "local", "reports", `${FIRST}.md`)).exists(),
      ).toBe(false)
    }
  })

  test("a journal that cannot be read is a state error, and the command is in the help", async () => {
    const missing = await cli(["assignment", "reports", "nowhere.jsonl"])
    expect(missing.code).toBe(4)
    expect(missing.stderr).toStartWith("error: StateIo:")

    expect((await cli(["help"])).stdout).toContain("assignment reports <journal.jsonl>")
    expect((await cli(["help", "assignment", "reports"])).stdout).toContain("label")
  })
})
