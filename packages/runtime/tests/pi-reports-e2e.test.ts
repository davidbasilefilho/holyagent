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

  test("prints the Pi route model and thinking under pi, and the Claude route under claude", async () => {
    await cli(["intent", "create"], { objective: "Parse" })
    const under = async (host: string, roleTask: string, id: string) => {
      const out = await cli(["assignment", "dispatch"], draft(id, roleTask), {
        HOLYAGENT_HOST: host,
      })
      return decode(`${out.stdout.split("\nprompt:\n")[0]}\n`) as Record<string, string>
    }
    const pi = await under("pi", "Worker.implementation", "a")
    expect(pi.model).toBe("kimi-coding/kimi-for-coding")
    expect(pi.effort).toBe("max")
    const visual = await under("pi", "Reviewer.visual", "b")
    expect(visual.model).toBe("kimi-coding/k3.1-pro")
    expect(visual.effort).toBe("low")
    const claude = await under("claude", "Worker.implementation", "c")
    expect(claude.model).toBe("sonnet")
    expect(claude.effort).toBe("high")
  })

  test("takes the model and thinking from the user and project config, and omits them with pi off", async () => {
    await cli(["intent", "create"], { objective: "Parse" })
    await Bun.write(
      join(home, ".holyagent", "config.json"),
      JSON.stringify({ pi: { routes: { "Worker.implementation": { thinking: "high" } } } }),
    )
    await Bun.write(
      join(project, ".holyagent", "config.json"),
      JSON.stringify({ pi: { routes: { "Worker.implementation": { model: "k3.1-pro" } } } }),
    )
    const tuned = await dispatch(draft("tuned"))
    expect(tuned.model).toBe("kimi-coding/k3.1-pro")
    expect(tuned.effort).toBe("high")
    await Bun.write(
      join(project, ".holyagent", "config.json"),
      JSON.stringify({ pi: { enable: false } }),
    )
    const off = await dispatch(draft("off"))
    expect(off.agent).toBe("worker-implementation")
    expect(off).not.toHaveProperty("model")
    expect(off).not.toHaveProperty("effort")
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
    // The model and thinking are the Pi route table's, in the form the package takes.
    expect([a.model, a.effort]).toEqual(["kimi-coding/kimi-for-coding", "max"])
    expect([b.model, b.effort]).toEqual(["kimi-coding/kimi-for-coding", "max"])
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

  test("a workflow journal still matches when the config sets other routes or pi is off", async () => {
    await cli(["intent", "create"], { objective: "Parse" })
    await Bun.write(
      join(project, ".holyagent", "config.json"),
      JSON.stringify({ pi: { routes: { "Worker.implementation": { thinking: "high" } } } }),
    )
    const tuned = await dispatch(draft("tuned"))
    const off = await (async () => {
      await Bun.write(
        join(project, ".holyagent", "config.json"),
        JSON.stringify({ pi: { enable: false } }),
      )
      return dispatch(draft("off"))
    })()
    const keyOfCall = (d: Record<string, string>) =>
      keyOf([
        d.prompt ?? "",
        d.id ?? "",
        d.model ?? null,
        d.agent ?? "",
        d.effort ?? null,
        null,
        null,
        null,
      ])
    const journal = [
      { index: 0, key: keyOfCall(tuned), ok: true, text: "tuned report" },
      { index: 1, key: keyOfCall(off), ok: true, text: "off report" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")
    await Bun.write(join(project, "wf_cfg.workflow.jsonl"), `${journal}\n`)
    // Pi is off now, so only the entry dispatched with it off still matches its call.
    const done = await cli(["assignment", "reports", "wf_cfg.workflow.jsonl"])
    const rows = decode(done.stdout) as {
      reports: Array<{ id: string }>
      notAssignmentIds: unknown
    }
    expect(rows.reports.map(({ id }) => id)).toEqual([String(off.id)])
    expect(rows.notAssignmentIds).toEqual([{ label: "", agentId: "wf_cfg#0 unmatched" }])
    await Bun.write(
      join(project, ".holyagent", "config.json"),
      JSON.stringify({ pi: { routes: { "Worker.implementation": { thinking: "high" } } } }),
    )
    const again = await cli(["assignment", "reports", "wf_cfg.workflow.jsonl"])
    expect(
      (decode(again.stdout) as { reports: Array<{ id: string }> }).reports.map(({ id }) => id),
    ).toEqual([String(tuned.id)])
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

  test("a session file lists an Assignment recorded as a pi-workflow agent", async () => {
    await cli(["intent", "create"], { objective: "Parse" })
    const a = await dispatch(draft("one"))
    const recorded = await cli([
      "assignment",
      "record",
      String(a.id),
      "--agent",
      `pi-workflow:run-1/${String(a.id)}`,
    ])
    expect(recorded.code).toBe(0)
    await Bun.write(join(project, "session.jsonl"), `${JSON.stringify({ type: "session" })}\n`)
    const done = await cli(["assignment", "reports", "session.jsonl"])
    expect(done.stderr).toBe("")
    const rows = decode(done.stdout) as {
      reports: unknown
      notAssignmentIds: unknown
    }
    expect(rows.reports).toEqual([])
    expect(rows.notAssignmentIds).toEqual([
      { label: String(a.id), agentId: `pi-workflow:run-1/${String(a.id)} not in a session file` },
    ])
  })
})
