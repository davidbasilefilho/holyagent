import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"
import { Effect } from "effect"

import { briefText } from "../../src/cli/brief.ts"
import { StdinMissing } from "../../src/cli/errors.ts"
import { run } from "../../src/cli/program.ts"
import { renderPrompt } from "../../src/cli/report.ts"
import { ROUTES } from "../../src/domain/route.ts"
import { firstPassPrompt } from "../../src/prompts/index.ts"
import { assignment } from "../fixtures.ts"

setDefaultTimeout(30_000)

const AGENT = "reviewer-code"

describe("briefText", () => {
  test("starts a Pi Reviewer.code or Reviewer.security brief with its first-pass prompt, then the Assignment", () => {
    for (const [roleTask, name] of [
      ["Reviewer.code", "code-review"],
      ["Reviewer.security", "security-review"],
    ] as const) {
      const review = assignment({ roleTask, objective: "Review <base>...<head>" })
      const text = briefText(review, AGENT, "pi")
      expect(text).toStartWith(`First pass: ${name}.`)
      expect(text).toBe(
        `${firstPassPrompt(roleTask)}\n\n## Assignment\n\n${renderPrompt(review, AGENT)}`,
      )
      // The range comes from the Assignment below the prompt, and no Pi placeholder is left.
      expect(text).toContain("the refs the Assignment below names")
      expect(text).not.toContain("${")
      expect(text.indexOf("First pass:")).toBeLessThan(text.indexOf("Role: "))
    }
  })

  test("leaves the brief of every other role on Pi, and of every role on Claude, as the Assignment alone", () => {
    for (const route of ROUTES) {
      const task = assignment({ roleTask: route.roleTask })
      expect(briefText(task, route.agent, "claude")).toBe(renderPrompt(task, route.agent))
      if (route.roleTask !== "Reviewer.code" && route.roleTask !== "Reviewer.security")
        expect(briefText(task, route.agent, "pi")).toBe(renderPrompt(task, route.agent))
    }
  })
})

let project: string
let home: string
beforeEach(async () => {
  project = await realpath(await mkdtemp(join(tmpdir(), "holyagent-brief-")))
  home = await realpath(await mkdtemp(join(tmpdir(), "holyagent-briefh-")))
  await $`git init -q -b main`.cwd(project).quiet()
  await $`git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init`.cwd(project).quiet()
})
afterEach(() =>
  Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(home, { recursive: true, force: true }),
  ]),
)

const cli = (argv: ReadonlyArray<string>, stdin: unknown, host: string) =>
  Effect.runPromise(
    run(argv, {
      cwd: project,
      env: { HOME: home, HOLYAGENT_HOST: host },
      stdin:
        stdin === undefined
          ? Effect.fail(new StdinMissing({ reason: "none" }))
          : Effect.succeed(JSON.stringify(stdin)),
    }),
  )

/**
 * Dispatches an Assignment of the role under a host; returns the prompt the root sends and the
 * brief file's text.
 */
const dispatched = async (roleTask: string, host: string) => {
  await cli(["intent", "create"], { objective: "Review the parser" }, host)
  const out = await cli(
    ["assignment", "dispatch"],
    {
      roleTask,
      objective: "Review the range abc...def",
      criteria: [{ text: "sound", blocking: true, dimension: "behavior" }],
      ...(roleTask.startsWith("Worker") ? { ownershipPaths: ["src/a.ts"] } : {}),
    },
    host,
  )
  expect(out.stderr).toBe("")
  const [head = "", prompt = ""] = out.stdout.split("\nprompt:\n")
  const id = String((decode(`${head}\n`) as Record<string, unknown>)["id"])
  const path = /at (\S+\.md) with/.exec(prompt)?.[1] ?? ""
  return { id, prompt: prompt.replace(/\n$/, ""), brief: await Bun.file(path).text() }
}

describe("assignment dispatch", () => {
  test("under Pi writes the first-pass prompt at the start of a code or security reviewer's brief", async () => {
    const code = await dispatched("Reviewer.code", "pi")
    expect(code.brief).toStartWith("First pass: code-review.")
    expect(code.brief).toContain(
      `## Assignment\n\nRole: Reviewer.code (reviewer-code). Assignment: ${code.id}.`,
    )
    expect(code.brief).toContain("Objective: Review the range abc...def")
  })

  test("under Pi writes the security reviewer's brief the same way", async () => {
    const security = await dispatched("Reviewer.security", "pi")
    expect(security.brief).toStartWith("First pass: security-review.")
    expect(security.brief).toContain("Objective: Review the range abc...def")
  })

  test("keeps the printed prompt, and the briefs of other roles and of Claude, as before", async () => {
    const reviewer = await dispatched("Reviewer.code", "pi")
    // The prompt is the journal key's input, so it names the brief and carries no review text.
    expect(reviewer.prompt.split("\n")).toHaveLength(2)
    expect(reviewer.prompt).toStartWith(
      `Role: Reviewer.code (reviewer-code). Assignment: ${reviewer.id}.`,
    )
    expect(reviewer.prompt).not.toContain("First pass")
    const testing = await dispatched("Reviewer.testing", "pi")
    expect(testing.brief).toStartWith(
      `Role: Reviewer.testing (reviewer-testing). Assignment: ${testing.id}.`,
    )
    const worker = await dispatched("Worker.implementation", "pi")
    expect(worker.brief).toStartWith("Role: Worker.implementation (worker-implementation).")
    const claude = await dispatched("Reviewer.code", "claude")
    expect(claude.brief).toStartWith(
      `Role: Reviewer.code (holyagent:reviewer-code). Assignment: ${claude.id}.`,
    )
    expect(claude.brief).not.toContain("First pass")
  })
})
