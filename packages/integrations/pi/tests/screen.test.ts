import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { PLAYWRIGHT_MCP_SERVER } from "../../../runtime/src/config/capabilities.ts"
import { defaultConfig } from "../../../runtime/src/config/schema.ts"
import {
  HEADLESS_SCREEN_AGENT_SUFFIX,
  SCREEN_AGENT_SUFFIX,
} from "../../../runtime/src/domain/route.ts"
import {
  isScreenAgent,
  refuseT3PreviewOutsideT3,
  registerScreenServers,
  screenFormOf,
  screenServers,
} from "../src/screen.ts"
import { SCREEN_SPECIALIST_NAMES, SPECIALIST_NAMES } from "../src/specialists.ts"

const DEFAULTS = await Effect.runPromise(defaultConfig)
const withFeatures = (features: Record<string, unknown>) => ({
  ...DEFAULTS,
  pi: { ...DEFAULTS.pi, features: { ...DEFAULTS.pi.features, ...features } },
})

const REGISTRY = ["--registry=https://registry.npmjs.org/"]
const BROWSE = {
  name: "browse",
  command: "npx",
  args: [
    ...REGISTRY,
    "--@opencode:registry=https://registry.npmjs.org/",
    "-y",
    "@opencode/browse@0.0.15",
    "mcp",
  ],
}

describe("the screen specialists' names", () => {
  test("are the 18 specialists' names with the suffix, and nothing else is a screen agent", () => {
    expect(SCREEN_SPECIALIST_NAMES).toEqual(
      SPECIALIST_NAMES.flatMap((name) => [
        `${name}${SCREEN_AGENT_SUFFIX}`,
        `${name}${HEADLESS_SCREEN_AGENT_SUFFIX}`,
      ]),
    )
    for (const name of SCREEN_SPECIALIST_NAMES) expect(isScreenAgent(name)).toBe(true)
    for (const name of [
      ...SPECIALIST_NAMES,
      undefined,
      "",
      "-screen",
      "explorer-map-screens",
      "explorer-map-headless",
    ])
      expect(isScreenAgent(name)).toBe(false)
  })

  test("the form of a screen specialist is the one its file was made for", () => {
    expect(screenFormOf("worker-visual-screen")).toBe("normal")
    expect(screenFormOf("worker-visual-headless-screen")).toBe("headless")
    expect(screenFormOf(undefined)).toBe("normal")
  })
})

describe("the servers a screen specialist registers", () => {
  test("the normal form offers browse at the pinned release", () => {
    expect(screenServers(DEFAULTS, "normal")).toEqual([BROWSE])
  })

  test("the headless form offers the Playwright server at its pin: headless, isolated, on Chromium", () => {
    const { chromiumFlag: _flag, ...server } = PLAYWRIGHT_MCP_SERVER
    expect(screenServers(DEFAULTS, "headless")).toEqual([server])
    expect(server.args.slice(0, 2)).toEqual([
      ...REGISTRY,
      "--@playwright:registry=https://registry.npmjs.org/",
    ])
    expect(server.args).toContain("--headless")
    expect(server.args).toContain("--isolated")
    expect(server.args.join(" ")).toContain("--browser chromium")
  })

  test("the machine's Chromium becomes the server's executable path, and its absence leaves the server's own", () => {
    const [server] = screenServers(DEFAULTS, "headless", "/opt/pw-browsers/chromium")
    expect(server?.args.slice(-2)).toEqual(["--executable-path", "/opt/pw-browsers/chromium"])
    expect(screenServers(DEFAULTS, "headless", undefined)[0]?.args).not.toContain(
      "--executable-path",
    )
    // Browse launches no browser, so it takes no executable path.
    expect(screenServers(DEFAULTS, "normal", "/opt/pw-browsers/chromium")).toEqual([BROWSE])
  })

  test("a switched-off capability adds none, and neither does the MCP extension being off", () => {
    expect(screenServers(withFeatures({ browserUse: false }), "normal")).toEqual([])
    expect(screenServers(withFeatures({ browserUse: false }), "headless")).toEqual([])
    // Pi's MCP extension runs the servers: with `--no-mcp` there is nothing to register them with.
    expect(screenServers(withFeatures({ mcp: false }), "normal")).toEqual([])
    expect(
      screenServers(withFeatures({ mcp: false }), "headless", "/opt/pw-browsers/chromium"),
    ).toEqual([])
  })

  test("the other capabilities add none: only browse has a server", () => {
    expect(
      screenServers(withFeatures({ browserUse: false, computerUse: true, mcp: true }), "normal"),
    ).toEqual([])
  })
})

describe("T3's preview tools", () => {
  const preview = [
    "mcp__t3-code__preview_open",
    "mcp__t3_code__t3_preview_snapshot",
    "mcp__t3-code__html_render",
  ]

  test("are refused to a screen specialist when T3 does not host the session", () => {
    for (const agent of ["worker-visual-screen", "reviewer-code-headless-screen"])
      for (const toolName of preview) {
        const result = refuseT3PreviewOutsideT3({ toolName }, agent, false)
        expect(result?.block, `${agent} ${toolName}`).toBe(true)
        expect(result?.reason).toContain("T3 does not host this session")
      }
  })

  test("are granted when T3 hosts the session", () => {
    for (const toolName of preview)
      expect(refuseT3PreviewOutsideT3({ toolName }, "worker-visual-screen", true)).toBeUndefined()
  })

  test("the gate leaves every other tool, and every other session, alone", () => {
    for (const toolName of [
      "mcp__browse__execute",
      "mcp__playwright__browser_navigate",
      "bash",
      "mcp__t3-code__device_list",
    ])
      expect(refuseT3PreviewOutsideT3({ toolName }, "worker-visual-screen", false)).toBeUndefined()
    for (const agent of [undefined, "worker-visual", "reviewer-code"])
      expect(refuseT3PreviewOutsideT3({ toolName: preview[0] ?? "" }, agent, false)).toBeUndefined()
  })
})

describe("registering them", () => {
  const NEUTRAL = "/home/user"
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
    expect(registerScreenServers(register, "worker-visual-screen", [BROWSE], NEUTRAL)).toEqual({
      registered: ["browse"],
      failures: [],
    })
    expect(calls).toEqual([
      {
        name: "browse",
        config: { command: "npx", args: [...BROWSE.args], cwd: NEUTRAL },
      },
    ])
  })

  test("a server launched through npx starts in the neutral folder and any other starts where Pi puts it", () => {
    const { calls, register } = recorder()
    registerScreenServers(
      register,
      "worker-visual-screen",
      [BROWSE, { name: "other", command: "node", args: ["server.js"] }],
      NEUTRAL,
    )
    expect(calls.map(({ name, config }) => [name, (config as { cwd?: string }).cwd])).toEqual([
      ["browse", NEUTRAL],
      ["other", undefined],
    ])
  })

  test("any other session registers nothing", () => {
    for (const agent of [undefined, "worker-visual", "reviewer-code", "general-purpose"]) {
      const { calls, register } = recorder()
      expect(registerScreenServers(register, agent, [BROWSE], NEUTRAL)).toEqual({
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
    const result = registerScreenServers(
      register,
      "explorer-map-screen",
      [
        { name: "first", command: "a", args: [] },
        { name: "second", command: "b", args: ["x"] },
      ],
      NEUTRAL,
    )
    expect(result).toEqual({ registered: ["second"], failures: ["first: invalid name"] })
    expect(calls).toEqual([{ name: "second", config: { command: "b", args: ["x"] } }])
  })
})
