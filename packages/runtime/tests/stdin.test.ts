import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"

const MAIN = join(import.meta.dir, "../src/cli/main.ts")

let project: string
let home: string

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), "holyagent-stdin-"))
  home = await mkdtemp(join(tmpdir(), "holyagent-stdin-home-"))
  await $`git init -q -b main`.cwd(project).quiet()
  await $`git -c user.name=Octo -c user.email=octo@example.com commit -q --allow-empty -m seed`
    .cwd(project)
    .quiet()
})
afterAll(() =>
  Promise.all([
    rm(project, { recursive: true, force: true, maxRetries: 5 }),
    rm(home, { recursive: true, force: true, maxRetries: 5 }),
  ]),
)

/** Runs the entry point as a process with `stdin` piped in, the way a shell redirect does. */
const holy = async (argv: ReadonlyArray<string>, stdin?: string) => {
  const shell =
    stdin === undefined
      ? $`${process.execPath} ${MAIN} ${argv}`
      : $`${process.execPath} ${MAIN} ${argv} < ${new Response(stdin)}`
  const result = await shell
    .cwd(project)
    .env({ ...process.env, HOME: home, USERPROFILE: home })
    .quiet()
    .nothrow()
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

const fields = (stdout: string) =>
  decode(stdout.split("\nprompt:\n")[0] ?? "") as Record<string, unknown>

describe("the CLI entry point with stdin piped", () => {
  // Each case starts several processes, and the first one creates the state worktree.
  setDefaultTimeout(60_000)

  test("finishes a command that waits on stdin and prints its result", async () => {
    const created = await holy(["intent", "create"], '{"objective":"Read stdin"}')
    expect(created.stderr).toBe("")
    expect(created.code).toBe(0)
    expect(fields(created.stdout)).toMatchObject({ state: "Open", objective: "Read stdin" })

    const draft = {
      roleTask: "Worker.implementation",
      objective: "Build it",
      criteria: [{ text: "builds", blocking: true, dimension: "behavior" }],
      evidence: ["tests"],
      ownershipPaths: ["src/a.ts"],
    }
    const dispatched = await holy(["assignment", "dispatch"], JSON.stringify(draft))
    expect(dispatched.code).toBe(0)
    const id = String(fields(dispatched.stdout).id)
    expect((await holy(["assignment", "record", id, "--agent", `workflow:run-1/${id}`])).code).toBe(
      0,
    )

    const closed = await holy(["assignment", "close", id, "--outcome", "success"], "Built it.\n")
    expect(closed.stderr).toBe("")
    expect(closed.code).toBe(0)
    expect(fields(closed.stdout)).toMatchObject({ id, state: "Succeeded" })

    const shown = await holy(["assignment", "show", id, "--full"])
    expect(fields(shown.stdout)).toMatchObject({ state: "Succeeded" })
  })

  test("a command that fails after reading stdin exits non-zero with its error on stderr", async () => {
    const refused = await holy(["intent", "create"], '{"objective":"x","extra":true}')
    expect(refused.code).toBe(2)
    expect(refused.stdout).toBe("")
    expect(refused.stderr).toStartWith("error: InvalidDraft:")

    const blank = await holy(["intent", "create"], "\n")
    expect(blank.code).toBe(2)
    expect(blank.stderr).toStartWith("error: StdinMissing:")
  })

  test("dispatch tells how to dispatch an existing Assignment when the input names it otherwise", async () => {
    const refused = await holy(["assignment", "dispatch"], '{"assignmentId":"assignment-x"}')
    expect(refused.code).toBe(2)
    expect(refused.stderr).toContain('send {"id": "<id>"}')
  })
})
