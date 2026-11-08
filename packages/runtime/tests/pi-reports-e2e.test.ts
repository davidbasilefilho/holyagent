import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect } from "effect"

import { StdinMissing } from "../src/cli/errors.ts"
import { run } from "../src/cli/program.ts"

setDefaultTimeout(30_000)
let project: string
let home: string
beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "holyagent-pie-")))
  home = await realpath(await mkdtemp(join(tmpdir(), "holyagent-pieh-")))
  await $`git init -q -b main`.cwd(project).quiet()
  await $`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.cwd(project).quiet()
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]),
)

const cli = (argv: ReadonlyArray<string>, stdin?: unknown, env: Record<string, string> = {}) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: home, HOLYAGENT_HOST: "pi", ...env },
      stdin:
        stdin === undefined
          ? Effect.fail(new StdinMissing({ reason: "none" }))
          : Effect.succeed(typeof stdin === "string" ? stdin : JSON.stringify(stdin)),
    }),
  )

const draft = (objective: string, roleTask = "Worker.implementation") => ({
  roleTask,
  objective,
  criteria: [{ text: "parses", blocking: true, dimension: "behavior" }],
  ...(roleTask.startsWith("Worker") ? { ownershipPaths: [`src/${objective}.ts`] } : {}),
})

const dispatch = async (body: object): Promise<Record<string, string>> => {
  const out = await cli(["assignment", "dispatch"], body)
  expect(out.stderr).toBe("")
  const [head, prompt = ""] = out.stdout.split("\nprompt:\n")
  return { ...(decode(`${head}\n`) as Record<string, string>), prompt: prompt.replace(/\n$/, "") }
}

const keyOf = (fields: ReadonlyArray<string | null>) =>
  createHash("sha256").update(JSON.stringify(fields)).digest("hex").slice(0, 32)

describe("assignment dispatch under each host", () => {
  test("prints the Claude namespaced agent under claude, and the Pi agent name under pi", async () => {
    await cli(["intent", "create"], { objective: "Parse" })
    const under = async (host: string) => {
      const out = await cli(["assignment", "dispatch"], draft(`x${host}`), { HOLYAGENT_HOST: host })
      return out.stdout.split("\nprompt:\n")[0] ?? ""
    }
    expect(await under("claude")).toContain("holyagent:worker-implementation")
    const pi = await under("pi")
    expect(pi).toContain("worker-implementation")
    expect(pi).not.toContain("holyagent:")
  })
})

describe("assignment reports under pi", () => {
  test("a workflow journal", async () => {
    await cli(["intent", "create"], { objective: "Parse" })
    const a = await dispatch(draft("one"))
    const b = await dispatch(draft("two", "Reviewer.code"))
    const key = (d: Record<string, string>) =>
      keyOf([
        d.prompt ?? "",
        d.id ?? "",
        d.model ?? "",
        String(d.agent),
        d.effort ?? "",
        null,
        null,
        null,
      ])
    // The Pi root passes the printed agent as `agentType`, and the package ships the bare name.
    expect(a.agent).toBe("worker-implementation")
    expect(b.agent).toBe("reviewer-code")
    expect(a.prompt).toContain("(worker-implementation)")
    const journal = [
      { index: 0, key: key(a), ok: true, text: "first report" },
      { index: 1, key: key(b), ok: false },
      { index: 2, key: "0".repeat(32), ok: true, text: "stray" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    await Bun.write(join(project, "wf_abc.workflow.jsonl"), `${journal}\n`)
    const done = await cli(["assignment", "reports", "wf_abc.workflow.jsonl"])
    expect(done.stderr).toBe("")
    const rows = decode(done.stdout) as {
      reports: Array<{ id: string; words: number }>
      notAssignmentIds: unknown
    }
    expect(rows.reports.map(({ id, words }) => ({ id, words }))).toEqual([
      { id: String(a.id), words: 2 },
    ])
    expect(rows.notAssignmentIds).toEqual([
      { label: String(b.id), agentId: "wf_abc#1 failed" },
      { label: "", agentId: "wf_abc#2 unmatched" },
    ])
    expect(await readdir(join(project, ".git", "holyagent", "reports"))).toEqual([
      `${String(a.id)}.md`,
    ])
  })

  test("a session file", async () => {
    await cli(["intent", "create"], { objective: "Parse" })
    const a = await dispatch(draft("one"))
    const recorded = await cli(["assignment", "record", String(a.id), "--agent", "pi:agent-1"])
    expect(recorded.code).toBe(0)
    const entry = {
      type: "custom",
      customType: "subagents:record",
      id: "e1",
      parentId: null,
      timestamp: "t",
      data: {
        id: "agent-1",
        type: "worker-implementation",
        description: "d",
        status: "completed",
        result: "full result",
        startedAt: 1,
      },
    }
    await Bun.write(
      join(project, "session.jsonl"),
      `${JSON.stringify({ type: "session" })}\n${JSON.stringify(entry)}\n`,
    )
    const done = await cli(["assignment", "reports", "session.jsonl"])
    expect(done.stderr).toBe("")
    expect(
      (decode(done.stdout) as { reports: Array<{ id: string }> }).reports.map((r) => r.id),
    ).toEqual([String(a.id)])
  })
})
