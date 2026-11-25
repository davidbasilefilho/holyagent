import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import piPins from "../../../core/src/config/pi-packages.json" with { type: "json" }
import {
  BROWSER_USE_MCP_SERVER,
  CUA_DRIVER_NAME,
  CUA_DRIVER_SERVER,
} from "../../../runtime/src/config/capabilities.ts"
import { PYPI_PACKAGE_VERSIONS } from "../../../runtime/src/config/pypi-packages.ts"
import { defaultConfig } from "../../../runtime/src/config/schema.ts"
import {
  HEADLESS_SCREEN_AGENT_SUFFIX,
  SCREEN_AGENT_SUFFIX,
} from "../../../runtime/src/domain/route.ts"
import {
  HEADLESS_SCREEN_NOTE,
  isScreenAgent,
  refuseT3PreviewOutsideT3,
  refuseUnassignedDesktop,
  registerScreenServers,
  screenFormOf,
  screenServers,
  withoutBrowserUseInT3,
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
    `@opencode/browse@${piPins["@opencode/browse"]}`,
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
    expect(screenServers(DEFAULTS, "normal")).toEqual([CUA_DRIVER_SERVER, BROWSE])
  })

  test("the headless form offers the browser-use server at its pin, through uvx with no uv config and the public index", () => {
    expect(screenServers(DEFAULTS, "headless")).toEqual([BROWSER_USE_MCP_SERVER])
    const { args, command, launchesChromium } = BROWSER_USE_MCP_SERVER
    expect([command, launchesChromium]).toEqual(["uvx", true])
    expect(args.slice(0, 3)).toEqual(["--no-config", "--default-index", "https://pypi.org/simple"])
    expect(args.slice(-4)).toEqual([
      "--from",
      `browser-use==${PYPI_PACKAGE_VERSIONS["browser-use"]}`,
      "browser-use",
      "--cli-mcp",
    ])
  })

  test("a switched-off capability adds none, and neither does the MCP extension being off", () => {
    expect(screenServers(withFeatures({ browserUse: false }), "normal")).toEqual([
      CUA_DRIVER_SERVER,
    ])
    expect(screenServers(withFeatures({ browserUse: false }), "headless")).toEqual([])
    // Pi's MCP extension runs the servers: with `--no-mcp` there is nothing to register them with.
    expect(screenServers(withFeatures({ mcp: false }), "normal")).toEqual([])
    expect(screenServers(withFeatures({ mcp: false }), "headless")).toEqual([])
  })

  test("a normal desktop route remains without browse", () => {
    expect(
      screenServers(withFeatures({ browserUse: false, computerUse: true, mcp: true }), "normal"),
    ).toEqual([CUA_DRIVER_SERVER])
  })
})

describe("the servers in a session T3 hosts", () => {
  test("the headless form's browser-use server is dropped, and nothing else is", () => {
    expect(withoutBrowserUseInT3(screenServers(DEFAULTS, "headless"), true)).toEqual([])
    expect(withoutBrowserUseInT3([BROWSE, BROWSER_USE_MCP_SERVER], true)).toEqual([BROWSE])
  })

  test("the normal form's browse stays", () => {
    expect(withoutBrowserUseInT3(screenServers(DEFAULTS, "normal"), true)).toEqual([
      CUA_DRIVER_SERVER,
      BROWSE,
    ])
  })

  test("outside T3 the servers of either form are unchanged", () => {
    for (const form of ["normal", "headless"] as const)
      expect(withoutBrowserUseInT3(screenServers(DEFAULTS, form), false)).toEqual(
        screenServers(DEFAULTS, form),
      )
  })

  test("a headless specialist is told that T3's preview tools are its browser and browser-use is not available there", () => {
    expect(HEADLESS_SCREEN_NOTE).toContain("T3 hosts the session")
    expect(HEADLESS_SCREEN_NOTE).toContain("T3's preview tools")
    expect(HEADLESS_SCREEN_NOTE).toContain("browser-use is not available")
    expect(HEADLESS_SCREEN_NOTE).toContain("`mcp__browser_use__browser_exec`")
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
      "mcp__browser_use__browser_exec",
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
  // The launcher the extension supplies: Bun on the bundled runtime's `browser-server` command.
  const LAUNCH = () => ({ command: "/bin/bun", args: ["holyagent.js", "browser-server"] })
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

  test("only graphical visual specialists register the official desktop transport", () => {
    for (const [agent, authorized] of [
      ["worker-visual", true],
      ["reviewer-visual-screen", true],
      ["worker-implementation-screen", false],
      ["worker-visual-headless-screen", false],
      [undefined, false],
    ] as const) {
      const { calls, register } = recorder()
      registerScreenServers(register, agent, [CUA_DRIVER_SERVER], NEUTRAL, LAUNCH)
      expect(calls).toHaveLength(authorized ? 1 : 0)
      if (authorized)
        expect(calls[0]).toMatchObject({
          name: CUA_DRIVER_NAME,
          config: {
            command: "cua-driver",
            args: ["mcp"],
            cwd: NEUTRAL,
            exposure: "hidden",
            toolExposure: { get_window_state: "direct" },
          },
        })
    }
    const event = (tool: string) => ({ toolName: `mcp__${CUA_DRIVER_NAME}__${tool}` })
    expect(refuseUnassignedDesktop(event("get_window_state"), true)).toBeUndefined()
    expect(refuseUnassignedDesktop(event("get_window_state"), false)?.block).toBe(true)
    expect(refuseUnassignedDesktop(event("install_extension"), true)?.block).toBe(true)
    expect(refuseUnassignedDesktop(event("run_script"), true)?.block).toBe(true)
    expect(refuseUnassignedDesktop({ toolName: "computer_use_click" }, true)?.block).toBe(true)
  })

  test("a screen specialist registers each server as a stdio command", () => {
    const { calls, register } = recorder()
    expect(
      registerScreenServers(register, "worker-visual-screen", [BROWSE], NEUTRAL, LAUNCH),
    ).toEqual({
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
      LAUNCH,
    )
    expect(calls.map(({ name, config }) => [name, (config as { cwd?: string }).cwd])).toEqual([
      ["browse", NEUTRAL],
      ["other", undefined],
    ])
  })

  test("a server that launches a Chromium is registered as the launcher's command, in the neutral folder", () => {
    const { calls, register } = recorder()
    expect(
      registerScreenServers(
        register,
        "worker-visual-headless-screen",
        [BROWSER_USE_MCP_SERVER],
        NEUTRAL,
        LAUNCH,
      ),
    ).toEqual({ registered: ["browser_use"], failures: [] })
    expect(calls).toEqual([
      {
        name: "browser_use",
        config: { command: "/bin/bun", args: ["holyagent.js", "browser-server"], cwd: NEUTRAL },
      },
    ])
  })

  test("a launcher that cannot be built fails that server with its reason", () => {
    const { calls, register } = recorder()
    const result = registerScreenServers(
      register,
      "worker-visual-headless-screen",
      [BROWSE, BROWSER_USE_MCP_SERVER],
      NEUTRAL,
      () => {
        throw new Error("Bun was not found")
      },
    )
    expect(result).toEqual({ registered: ["browse"], failures: ["browser_use: Bun was not found"] })
    expect(calls.map(({ name }) => name)).toEqual(["browse"])
  })

  test("any other session registers nothing", () => {
    for (const agent of [undefined, "worker-visual", "reviewer-code", "general-purpose"]) {
      const { calls, register } = recorder()
      expect(registerScreenServers(register, agent, [BROWSE], NEUTRAL, LAUNCH)).toEqual({
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
      LAUNCH,
    )
    expect(result).toEqual({ registered: ["second"], failures: ["first: invalid name"] })
    expect(calls).toEqual([{ name: "second", config: { command: "b", args: ["x"] } }])
  })
})
