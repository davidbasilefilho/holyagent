import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { defaultConfig } from "../../../runtime/src/config/schema.ts"
import { SCREEN_AGENT_SUFFIX } from "../../../runtime/src/domain/route.ts"
import { isScreenAgent, registerScreenServers, screenServers } from "../src/screen.ts"
import { SCREEN_SPECIALIST_NAMES, SPECIALIST_NAMES } from "../src/specialists.ts"

const DEFAULTS = await Effect.runPromise(defaultConfig)
const withFeatures = (features: Record<string, unknown>) => ({
  ...DEFAULTS,
  pi: { ...DEFAULTS.pi, features: { ...DEFAULTS.pi.features, ...features } },
})

const BROWSE = { name: "browse", command: "npx", args: ["-y", "@opencode/browse@0.0.15", "mcp"] }

describe("the screen specialists' names", () => {
  test("are the 18 specialists' names with the suffix, and nothing else is a screen agent", () => {
    expect(SCREEN_SPECIALIST_NAMES).toEqual(
      SPECIALIST_NAMES.map((name) => `${name}${SCREEN_AGENT_SUFFIX}`),
    )
    for (const name of SCREEN_SPECIALIST_NAMES) expect(isScreenAgent(name)).toBe(true)
    for (const name of [...SPECIALIST_NAMES, undefined, "", "-screen", "explorer-map-screens"])
      expect(isScreenAgent(name)).toBe(false)
  })
})

describe("the servers a screen specialist registers", () => {
  test("the normal form offers browse at the pinned release", () => {
    expect(screenServers(DEFAULTS, "normal")).toEqual([BROWSE])
  })

  test("the headless form offers none, and a switched-off capability adds none", () => {
    expect(screenServers(DEFAULTS, "headless")).toEqual([])
    expect(screenServers(withFeatures({ browserUse: false }), "normal")).toEqual([])
  })

  test("the other capabilities add none: only browse has a server", () => {
    expect(
      screenServers(withFeatures({ browserUse: false, computerUse: true, mcp: true }), "normal"),
    ).toEqual([])
  })
})

describe("registering them", () => {
  const recorder = (fail?: (name: string) => Error | undefined) => {
    const calls: Array<{ name: string; config: unknown }> = []
    return {
      calls,
      register: (name: string, config: unknown) => {
        const error = fail?.(name)
        if (error !== undefined) throw error
        calls.push({ name, config })
      },
    }
  }

  test("a screen specialist registers each server as a stdio command", () => {
    const { calls, register } = recorder()
    expect(registerScreenServers(register, "worker-visual-screen", [BROWSE])).toEqual({
      registered: ["browse"],
      failures: [],
    })
    expect(calls).toEqual([
      {
        name: "browse",
        config: { command: "npx", args: ["-y", "@opencode/browse@0.0.15", "mcp"] },
      },
    ])
  })

  test("any other session registers nothing", () => {
    for (const agent of [undefined, "worker-visual", "reviewer-code", "general-purpose"]) {
      const { calls, register } = recorder()
      expect(registerScreenServers(register, agent, [BROWSE])).toEqual({
        registered: [],
        failures: [],
      })
      expect(calls).toEqual([])
    }
  })

  test("a failure is returned with the server's name and the others still register", () => {
    const { calls, register } = recorder((name) =>
      name === "first" ? new Error("invalid name") : undefined,
    )
    const result = registerScreenServers(register, "explorer-map-screen", [
      { name: "first", command: "a", args: [] },
      { name: "second", command: "b", args: ["x"] },
    ])
    expect(result).toEqual({ registered: ["second"], failures: ["first: invalid name"] })
    expect(calls).toEqual([{ name: "second", config: { command: "b", args: ["x"] } }])
  })
})
