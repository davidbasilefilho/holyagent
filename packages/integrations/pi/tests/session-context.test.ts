import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { Effect } from "effect"

import { CONTEXT_BUDGET, SESSION_REMINDER } from "../../../runtime/src/cli/sessioncontext.ts"
import {
  OutputUnreadable,
  parseOutput,
  PI_ROOT_CORE,
  PI_ROOT_PLACEHOLDER,
  PI_SESSION_REMINDER,
  piContext,
  piRootCore,
} from "../../../runtime/src/hooks/pi-context.ts"
import { configResult, enterProject } from "../../../runtime/src/hooks/pi-entry.ts"
import { PI_PROJECT_FLAG, projectOf } from "../../../runtime/src/hooks/pi-project.ts"
import { ROOT_CORE_FILES } from "../../../runtime/src/instructions/claude-5.5/root-core.ts"
import { instructionsDirectory, stripCitations } from "../../../runtime/src/instructions/skills.ts"
import { PROCESS_TIMEOUT_MS } from "../../../runtime/tests/fixtures.ts"
import { REPOSITORY } from "../src/files.ts"

const kimi = (file: string) =>
  readFileSync(join(REPOSITORY, instructionsDirectory("kimi-k3.1"), "root", file), "utf8")

/**
 * The time a spawned entry gets to end by itself: the test runs two in a row, so each gets 45% of
 * the test's timeout and a stalled one is reported before the test itself times out.
 */
const CHILD_DEADLINE_MS = Math.floor(PROCESS_TIMEOUT_MS * 0.45)

/** The time the pipes of an ended entry get to close, when a process it started holds them open. */
const PIPE_GRACE_MS = 2_000

const status = { intents: [{ id: "intent-a", revision: 1, objective: "Ship the thing" }] }

describe("the core of the root rules for Pi", () => {
  test("is the Kimi files of the Claude core list, in its order, with the maintainers' notes removed", () => {
    expect(PI_ROOT_CORE).toBe(
      ROOT_CORE_FILES.map((file) => stripCitations(kimi(file)).trim()).join("\n\n"),
    )
    expect(PI_ROOT_CORE).not.toContain("<!--")
    expect(PI_ROOT_CORE.startsWith("# HolyAgent root")).toBe(true)
  })

  test("names no Claude tool and holds the package-root placeholder, which piRootCore fills", () => {
    expect(PI_ROOT_CORE).not.toContain("CLAUDE_PLUGIN_ROOT")
    expect(PI_ROOT_CORE).toContain(PI_ROOT_PLACEHOLDER)
    const filled = piRootCore("/pkg")
    expect(filled).not.toContain(PI_ROOT_PLACEHOLDER)
    expect(filled).toContain("/pkg/scripts/holyagent status")
  })
})

describe("piContext", () => {
  test("a session role is the core, the status and the Pi reminder, within the budget", () => {
    const text = piContext("session", "/pkg", { status }) ?? ""
    expect(text.startsWith(piRootCore("/pkg"))).toBe(true)
    expect(text).toContain("Ship the thing")
    expect(text.endsWith(PI_SESSION_REMINDER)).toBe(true)
    expect(text).not.toContain(SESSION_REMINDER)
    expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
  })

  test("the root gets no core and the specialist no reminder either", () => {
    const root = piContext("root", "/pkg", { status }) ?? ""
    const specialist = piContext("specialist", "/pkg", { status }) ?? ""
    expect(root).not.toContain("# HolyAgent root")
    expect(root.endsWith(PI_SESSION_REMINDER)).toBe(true)
    expect(specialist).not.toContain("# HolyAgent root")
    expect(specialist).not.toContain(PI_SESSION_REMINDER)
    expect(specialist).not.toContain(SESSION_REMINDER)
    expect(specialist).toContain("Ship the thing")
  })

  test("adds the Running rows of a reconcile result", () => {
    const reconcile = { running: [{ id: "assignment-1", role: "Worker.implementation" }] }
    expect(piContext("root", "/pkg", { status, reconcile })).toContain("assignment-1")
  })

  test("without a state folder only a session role gets anything", () => {
    expect(piContext("root", "/pkg", undefined)).toBeUndefined()
    expect(piContext("specialist", "/pkg", undefined)).toBeUndefined()
    const bare = piContext("session", "/pkg", undefined) ?? ""
    expect(bare.startsWith(piRootCore("/pkg"))).toBe(true)
    expect(bare.endsWith(PI_SESSION_REMINDER)).toBe(true)
    expect(bare).not.toContain("holyagent status:")
  })

  test("a status that cannot fit is narrowed until the whole fits", () => {
    const big = {
      intents: Array.from({ length: 300 }, (_, at) => ({
        id: `intent-${at}`,
        revision: at,
        objective: "x".repeat(500),
      })),
    }
    for (const role of ["root", "specialist", "session"] as const) {
      const text = piContext(role, "/some/long/package/folder/for/pi", { status: big }) ?? ""
      expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET)
    }
  })
})

describe("parseOutput", () => {
  test("decodes the fields of TOON output", async () => {
    const fields = await Effect.runPromise(parseOutput("status", "intents: []\n"))
    expect(fields).toEqual({ intents: [] })
  })

  test("fails with OutputUnreadable that names the command, for text that is not an object", async () => {
    for (const text of ["[unclosed", "just a string", "[2]: a,b\n"]) {
      const error = await Effect.runPromise(Effect.flip(parseOutput("reconcile", text)))
      expect(error).toBeInstanceOf(OutputUnreadable)
      expect(error.message).toContain("`holyagent reconcile`")
    }
  })
})

describe("the config command of the runtime bundle", () => {
  const scratch = async () => {
    const root = await mkdtemp(join(tmpdir(), "holyagent-pi-config-"))
    return {
      root,
      env: { HOLYAGENT_HOME: join(root, "home") },
      done: () => rm(root, { recursive: true, force: true }),
    }
  }

  test("prints the loaded config, defaults filled in", async () => {
    const { root, env, done } = await scratch()
    const result = await Effect.runPromise(configResult([join(root, ".holyagent")], env))
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      pi: { enable: true, codemode: { mode: "only" } },
    })
    await done()
  })

  test("the project file wins over the user file", async () => {
    const { root, env, done } = await scratch()
    await mkdir(join(root, "home", ".holyagent"), { recursive: true })
    await Bun.write(join(root, "home", ".holyagent", "config.json"), '{"pi":{"enable":true}}')
    await mkdir(join(root, ".holyagent"), { recursive: true })
    await Bun.write(join(root, ".holyagent", "config.json"), '{"pi":{"enable":false}}')
    const result = await Effect.runPromise(configResult([join(root, ".holyagent")], env))
    expect(JSON.parse(result.stdout)).toMatchObject({ pi: { enable: false } })
    await done()
  })

  test("an invalid file fails as the CLI fails, naming the file and the field", async () => {
    const { root, env, done } = await scratch()
    await mkdir(join(root, ".holyagent"), { recursive: true })
    await Bun.write(join(root, ".holyagent", "config.json"), '{"pi":{"enabel":true}}')
    const result = await Effect.runPromise(configResult([join(root, ".holyagent")], env))
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toStartWith("error: ConfigInvalid: ")
    expect(result.stderr).toContain(join(root, ".holyagent", "config.json"))
    expect(result.stderr).toContain("enabel")
    await done()
  })
})

describe("the project flag of the runtime bundle", () => {
  test("splits a leading flag and its folder off the command line", () => {
    expect(projectOf([PI_PROJECT_FLAG, "/work/p", "status"])).toEqual({
      directory: "/work/p",
      rest: ["status"],
    })
    expect(projectOf(["status", PI_PROJECT_FLAG, "/work/p"])).toEqual({
      directory: undefined,
      rest: ["status", PI_PROJECT_FLAG, "/work/p"],
    })
    expect(projectOf([PI_PROJECT_FLAG])).toEqual({ directory: undefined, rest: [PI_PROJECT_FLAG] })
  })

  test("a folder that does not exist fails as a state error that names it", async () => {
    const missing = join(tmpdir(), "holyagent-pi-no-such-folder")
    const error = await Effect.runPromise(Effect.flip(enterProject(missing)))
    expect(error._tag).toBe("StateIo")
    expect(error.message).toContain(missing)
  })

  // The entry enters the project and hands the CLI the arguments after the flag through `Bun.argv`,
  // before `cli/main.ts` reads them as it is imported.
  test(
    "the entry runs the CLI command after the flag, in the folder the flag names",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "holyagent-pi-entry-"))
      const entry = join(REPOSITORY, "packages", "runtime", "src", "hooks", "pi-entry.ts")
      // A child that has not ended by itself well inside the test's timeout is killed and reported with
      // what it printed and how it ended, so a stalled run says where it stalled (the child alive,
      // or the child gone and a pipe held open) and not only that the test timed out.
      const spawn = async (...args: ReadonlyArray<string>) => {
        const child = Bun.spawn(["bun", "--no-env-file", entry, ...args], {
          cwd: tmpdir(),
          env: { ...process.env, HOLYAGENT_HOME: join(root, "home") },
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
          timeout: CHILD_DEADLINE_MS,
        })
        const text = (stream: ReadableStream<Uint8Array>) =>
          Promise.race([
            new Response(stream).text(),
            child.exited.then(() => Bun.sleep(PIPE_GRACE_MS)).then(() => "<pipe open after exit>"),
          ])
        const [stdout, stderr, code] = await Promise.all([
          text(child.stdout),
          text(child.stderr),
          child.exited,
        ])
        if (child.signalCode !== null)
          throw new Error(
            `the entry (${args.join(" ")}) was still running after ${CHILD_DEADLINE_MS} ms: ${JSON.stringify({ stdout, stderr })}`,
          )
        return { stdout, stderr, code }
      }
      try {
        const created = await spawn(
          PI_PROJECT_FLAG,
          root,
          "intent",
          "create",
          "--input",
          JSON.stringify({ objective: "Entry objective" }),
        )
        expect({ code: created.code, stderr: created.stderr }).toEqual({ code: 0, stderr: "" })
        // The process started in another folder, so the intent is in the project only if it was entered.
        const status = await spawn(PI_PROJECT_FLAG, root, "status")
        expect(status.code).toBe(0)
        expect(status.stdout).toContain("Entry objective")
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    PROCESS_TIMEOUT_MS,
  )
})
