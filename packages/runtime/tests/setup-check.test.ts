import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { Effect } from "effect"

import { run } from "../src/cli/program.ts"
import { CONTEXT_BUDGET, SESSION_REMINDER } from "../src/cli/sessioncontext.ts"
import { setupNotice } from "../src/setup/check.ts"
import { completeSetup, installPrograms, scratch, writeCompleteSettings } from "./setup-fixture.ts"

let home: string
let project: string
let removeAll: () => Promise<void>

beforeEach(async () => {
  const homeDir = await scratch("holyagent-notice-home-")
  const projectDir = await scratch("holyagent-notice-project-")
  home = homeDir.directory
  project = projectDir.directory
  removeAll = async () => {
    await homeDir.remove()
    await projectDir.remove()
  }
})
afterEach(() => removeAll())

/** An environment whose search path holds nothing, so only the home's Bun bin directory counts. */
const env = (extra: Record<string, string> = {}) => ({ HOME: home, PATH: project, ...extra })

const files = (directory: string) => readdir(directory, { recursive: true })

describe("the setup check of the SessionStart hook", () => {
  test("names /holyagent:setup in one line when bili, ctx7 and the settings keys are missing", async () => {
    const notice = await Effect.runPromise(setupNotice(env()))
    expect(notice).toContain("/holyagent:setup")
    expect(notice).toContain("bili, ctx7, user settings keys")
    expect(notice).not.toContain("\n")
  })

  test("names only what is missing", async () => {
    await installPrograms(home)
    expect(await Effect.runPromise(setupNotice(env()))).toContain("(missing user settings keys)")
    await writeCompleteSettings(join(home, ".claude"))
    expect(await Effect.runPromise(setupNotice(env()))).toBeUndefined()
  })

  test("a missing key of the user settings is enough", async () => {
    await installPrograms(home)
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude", "settings.json"), '{"includeGitInstructions":false}')
    expect(await Effect.runPromise(setupNotice(env()))).toContain("(missing user settings keys)")
  })

  test("says nothing when everything is in place", async () => {
    await completeSetup(home)
    expect(await Effect.runPromise(setupNotice(env()))).toBeUndefined()
  })

  test("says nothing in a claude.ai cloud session, whatever is missing", async () => {
    expect(
      await Effect.runPromise(setupNotice(env({ CLAUDE_CODE_REMOTE: "true" }))),
    ).toBeUndefined()
  })

  test("leaves a settings file that is not a JSON object to setup, which reports it", async () => {
    await installPrograms(home)
    await mkdir(join(home, ".claude"), { recursive: true })
    await writeFile(join(home, ".claude", "settings.json"), "[1]")
    expect(await Effect.runPromise(setupNotice(env()))).toBeUndefined()
  })

  test("writes nothing and, with no requirements in its type, can spawn nothing", async () => {
    const before = [...(await files(home)), ...(await files(project))]
    // runPromise accepts only an effect that needs no service, so no Shell can be in the type.
    await Effect.runPromise(setupNotice(env()))
    expect([...(await files(home)), ...(await files(project))]).toEqual(before)
  })
})

describe("hook session-start with the setup check", () => {
  const sessionStart = (extra: Record<string, string>, agent = "holyagent", directory = project) =>
    Effect.runPromise(
      run(["hook", "session-start"], {
        cwd: directory,
        env: env(extra),
        stdin: Effect.succeed(
          JSON.stringify({ hook_event_name: "SessionStart", source: "startup", agent_type: agent }),
        ),
      }),
    )
  const context = (stdout: string) =>
    (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
      .additionalContext

  test("adds exactly one line naming /holyagent:setup when the root has nothing else to say", async () => {
    const result = await sessionStart({})
    expect(result.code).toBe(0)
    const text = context(result.stdout)
    expect(text.split("\n")).toHaveLength(1)
    expect(text).toContain("/holyagent:setup")
  })

  test("prints nothing when everything is in place", async () => {
    await completeSetup(home)
    expect(await sessionStart({})).toEqual({ stdout: "", stderr: "", code: 0 })
  })

  test("prints nothing in a cloud session, and writes no file", async () => {
    const before = [...(await files(home)), ...(await files(project))]
    expect(await sessionStart({ CLAUDE_CODE_REMOTE: "true" })).toEqual({
      stdout: "",
      stderr: "",
      code: 0,
    })
    expect(await sessionStart({})).toMatchObject({ code: 0 })
    expect([...(await files(home)), ...(await files(project))]).toEqual(before)
  })

  test("sits between the root rules and the reminder for another main thread, once", async () => {
    const text = context((await sessionStart({}, "general-purpose")).stdout)
    expect(text.split("/holyagent:setup")).toHaveLength(2)
    expect(text.indexOf("/holyagent:setup")).toBeLessThan(text.lastIndexOf(SESSION_REMINDER))
    expect(text.endsWith(`\n\n${SESSION_REMINDER}`)).toBe(true)
  })

  test("is part of the context of a project with state and stays within the budget", async () => {
    const created = await Effect.runPromise(
      run(["intent", "create"], {
        cwd: project,
        env: env(),
        stdin: Effect.succeed('{"objective":"Ship it"}'),
      }),
    )
    expect(created.code).toBe(0)
    for (const agent of ["holyagent", "general-purpose"]) {
      const text = context((await sessionStart({}, agent)).stdout)
      expect(text).toContain("/holyagent:setup")
      expect(text).toContain("Ship it")
      expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
    }
    await completeSetup(home)
    expect(context((await sessionStart({})).stdout)).not.toContain("/holyagent:setup")
  })
})
