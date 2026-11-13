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
    expect(help.stdout).toContain("current PR and CI status are unknown")
    expect(help.stdout).not.toContain("unknown unless")
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

test("branch-mode handoff refuses pending state and an unavailable state branch without writing", async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-handoff-git-"))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: root,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    })
    expect(result.exitCode).toBe(0)
    return result.stdout.toString()
  }
  git("init", "-b", "main")
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  )
  const cli = (host: string) =>
    Effect.runPromise(
      run(["handoff"], {
        cwd: root,
        env: { HOLYAGENT_HOST: host, GIT_OPTIONAL_LOCKS: "0" },
        stdin: Effect.fail(new StdinMissing({ reason: "no input" })),
      }),
    )
  expect((await cli("pi")).code).toBe(0)
  const record = intentFile(join(root, ".holyagent"), intent())
  await mkdir(dirname(record), { recursive: true })
  await Bun.write(record, JSON.stringify(intent()))
  const before = git("status", "--porcelain=v1", "--untracked-files=all")
  for (const host of ["pi", "claude"]) {
    const pending = await cli(host)
    expect(pending.code).not.toBe(0)
    expect(pending.stderr).toContain("migrat")
  }
  expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe(before)
  expect(await Bun.file(record).text()).toBe(JSON.stringify(intent()))
  git("branch", "holyagent/state")
  await rm(join(root, ".holyagent"), { recursive: true })
  const missing = await cli("pi")
  expect(missing.code).not.toBe(0)
  expect(missing.stderr).toContain("state")
  const shared = join(root, "shared")
  const other = join(root, "other")
  git("worktree", "add", shared, "holyagent/state")
  git("worktree", "add", "-b", "other", other)
  const sharedRecord = intentFile(join(shared, ".holyagent"), intent())
  const otherRecord = intentFile(join(other, ".holyagent"), intent({ id: "intent-b" }))
  await mkdir(dirname(sharedRecord), { recursive: true })
  await mkdir(dirname(otherRecord), { recursive: true })
  await Bun.write(sharedRecord, JSON.stringify(intent()))
  await Bun.write(otherRecord, "{corrupt")
  const worktrees = git("worktree", "list", "--porcelain")
  const mixed = await cli("claude")
  expect(mixed.code).not.toBe(0)
  expect(mixed.stderr).toContain("migrat")
  expect(await Bun.file(otherRecord).text()).toBe("{corrupt")
  expect(await Bun.file(sharedRecord).text()).toBe(JSON.stringify(intent()))
  expect(git("worktree", "list", "--porcelain")).toBe(worktrees)
  await rm(join(other, ".holyagent"), { recursive: true })
  const complete = await cli("pi")
  expect(complete.code).toBe(0)
  expect(complete.stdout).toContain(intent().id)
})

test("handoff does not create a lock for an unfinished standard state checkout", async () => {
  root = await mkdtemp(join(tmpdir(), "holyagent-handoff-pending-"))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root })
    expect(result.exitCode).toBe(0)
  }
  git("init", "-b", "main")
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  )
  const common = join(root, ".git", "holyagent")
  await mkdir(common, { recursive: true })
  const hash = new Bun.CryptoHasher("sha1").update("holyagent/state").digest("hex").slice(0, 10)
  git("worktree", "add", "-b", "holyagent/state", join(common, `holyagent-state-${hash}`))
  const before = (await readdir(common)).toSorted()
  const result = await Effect.runPromise(
    run(["handoff"], {
      cwd: root,
      env: { HOLYAGENT_HOST: "pi" },
      stdin: Effect.fail(new StdinMissing({ reason: "no input" })),
    }),
  )
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain("not ready")
  expect((await readdir(common)).toSorted()).toEqual(before)
})
