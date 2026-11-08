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
import { configResult } from "../../../runtime/src/hooks/pi-entry.ts"
import { ROOT_CORE_FILES } from "../../../runtime/src/instructions/claude-5.5/root-core.ts"
import { instructionsDirectory, stripCitations } from "../../../runtime/src/instructions/skills.ts"
import { REPOSITORY } from "../src/files.ts"

const kimi = (file: string) =>
  readFileSync(join(REPOSITORY, instructionsDirectory("kimi-k3.1"), "root", file), "utf8")

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
