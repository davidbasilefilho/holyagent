import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { decode } from "@toon-format/toon"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"
import {
  assignmentFile,
  branchFile,
  intentFile,
  intentFolder,
  pullFile,
} from "../src/state/layout.ts"
import { assignment, intent, NOW } from "./fixtures.ts"

let root = ""
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true, maxRetries: 5 })
})

test("handoff dispatches a complete recorded summary, filters it, and leaves state untouched on both hosts", async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-handoff-"))
  const directory = join(root, ".holyagent")
  const first = intent({
    requirements: ["first requirement", "Status and open items: CI unknown", "last requirement"],
  })
  const second = intent({ id: "intent-b", slug: "another", objective: "Other work" })
  const failed = assignment({ state: "Failed", result: "Tests failed; retry is pending" })
  const pending = assignment({ id: "assignment-b", intentId: second.id })
  const branch = {
    id: "branch-a",
    intentId: first.id,
    branch: "feature/a",
    commit: "abc",
    committedAt: NOW,
  }
  const pull = {
    id: "pull-a",
    intentId: first.id,
    number: 4,
    url: "https://example.test/pr/4",
    branch: "feature/a",
    created: true,
    recordedAt: NOW,
  }
  const files = [
    [intentFile(directory, first), first],
    [intentFile(directory, second), second],
    [assignmentFile(intentFolder(directory, first), failed), failed],
    [assignmentFile(intentFolder(directory, second), pending), pending],
    [branchFile(intentFolder(directory, first), branch), branch],
    [pullFile(intentFolder(directory, first), pull), pull],
  ] as const
  for (const [path, value] of files) {
    await mkdir(dirname(path), { recursive: true })
    await Bun.write(path, JSON.stringify(value))
  }
  const before = await Promise.all(files.map(([path]) => Bun.file(path).text()))
  const listing = (await readdir(directory, { recursive: true })).toSorted()
  const cli = (argv: string[], host: string) =>
    Effect.runPromise(
      run(argv, {
        cwd: root,
        env: { HOLYAGENT_HOST: host },
        stdin: Effect.fail(new StdinMissing({ reason: "no input" })),
      }),
    )
  for (const host of ["claude", "pi"]) {
    expect((await cli(["--help"], host)).stdout).toContain("handoff [--intent <id>]")
    const help = await cli(["handoff", "--help"], host)
    expect(help.stdout).toContain("--intent")
    const all = await cli(["handoff"], host)
    expect(all.code).toBe(0)
    const result = decode(all.stdout) as { source: string; intents: Array<Record<string, unknown>> }
    expect(result.source).toContain("live PR and CI status unknown")
    expect(result.intents).toHaveLength(2)
    expect(result.intents[0]).toMatchObject({
      id: first.id,
      requirements: first.requirements,
      assignments: [{ id: failed.id, state: "Failed", outcome: failed.result }],
      recordedBranches: [branch],
      recordedPullRequests: [pull],
    })
    const filtered = await cli(["handoff", "--intent", second.id], host)
    expect(filtered.code).toBe(0)
    expect(
      (decode(filtered.stdout) as { intents: Array<{ id: string }> }).intents.map((row) => row.id),
    ).toEqual([second.id])
    expect((await cli(["handoff", "--intent", "intent-missing"], host)).code).not.toBe(0)
  }
  expect(await Promise.all(files.map(([path]) => Bun.file(path).text()))).toEqual(before)
  expect((await readdir(directory, { recursive: true })).toSorted()).toEqual(listing)
  const corrupt = assignmentFile(intentFolder(directory, first), failed)
  await Bun.write(corrupt, '{"unexpected":true}')
  const failure = await cli(["handoff"], "pi")
  expect(failure.code).not.toBe(0)
  expect(failure.stderr).toContain("error:")
  expect(await Bun.file(corrupt).text()).toBe('{"unexpected":true}')
})
