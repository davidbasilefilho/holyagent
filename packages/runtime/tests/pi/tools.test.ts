import { describe, expect, test } from "bun:test"

import { piPackages } from "../../src/config/packages.ts"
import type { Config } from "../../src/config/schema.ts"
import { RoleTask, routeFor } from "../../src/domain/route.ts"
import { type ProviderProfile, PROVIDERS, webChoice } from "../../src/pi/provider.ts"
import {
  allToolArgs,
  BILLION_CONTEXT_DELEGATE_FILE,
  BILLION_CONTEXT_FILE,
  COMPUTER_USE_TOOLS,
  PI_SETTINGS_FILE,
  T3_VISUAL_TOOLS,
  toolArgs,
  toolSettings,
} from "../../src/pi/tools.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

const withFeatures = (features: Partial<Config["pi"]["features"]>): Config => ({
  ...DEFAULT_CONFIG,
  pi: { ...DEFAULT_CONFIG.pi, features: { ...DEFAULT_CONFIG.pi.features, ...features } },
})

/** A provider whose extension offers no web tools, to try the fallback. */
const NO_WEB_PROVIDER: ProviderProfile = { ...PROVIDERS["kimi-coding-global"], webTools: [] }

const READ = ["read", "grep", "find", "ls"]
const MOONSHOT = ["moonshot_search", "moonshot_fetch"]
const WEB_KIT = ["web_search", "web_fetch"]

/** The decided `--tools` allowlist of each specialist with the default config. */
const EXPECTED: Readonly<Record<RoleTask, ReadonlyArray<string>>> = {
  "Explorer.map": READ,
  "Explorer.lookup": READ,
  "Explorer.trace": READ,
  "Librarian.lookup": [...READ, ...MOONSHOT],
  "Librarian.research": [...READ, ...MOONSHOT],
  "Worker.mechanical": [...READ, "write", "edit", "bash"],
  "Worker.implementation": [...READ, "write", "edit", "bash"],
  "Worker.integration": [...READ, "write", "edit", "bash"],
  "Worker.debugging": [...READ, "write", "edit", "bash"],
  "Worker.operations": [...READ, "bash"],
  "Worker.validation": [...READ, "bash"],
  "Worker.visual": [...READ, "write", "edit", "bash", ...T3_VISUAL_TOOLS, ...COMPUTER_USE_TOOLS],
  "Reviewer.visual": [...READ, ...T3_VISUAL_TOOLS, ...COMPUTER_USE_TOOLS],
  "Reviewer.code": [...READ, "bash"],
  "Reviewer.testing": [...READ, "bash"],
  "Reviewer.audit": READ,
  "Reviewer.security": READ,
  "Reviewer.artifact": READ,
}

describe("toolArgs for the specialists", () => {
  test.each(RoleTask.literals)("%s gets the decided allowlist", (role) => {
    expect(toolArgs(DEFAULT_CONFIG, role).tools).toEqual(EXPECTED[role])
  })

  test("the write tools a role lacks are excluded, and only those", () => {
    for (const role of RoleTask.literals) {
      const { tools, excludeTools } = toolArgs(DEFAULT_CONFIG, role)
      expect(excludeTools).toEqual(
        ["write", "edit", "bash"].filter((tool) => !tools.includes(tool)),
      )
    }
    expect(toolArgs(DEFAULT_CONFIG, "Explorer.map").excludeTools).toEqual(["write", "edit", "bash"])
    expect(toolArgs(DEFAULT_CONFIG, "Worker.validation").excludeTools).toEqual(["write", "edit"])
    expect(toolArgs(DEFAULT_CONFIG, "Worker.implementation").excludeTools).toEqual([])
  })

  test("only the Write capability grants write and edit", () => {
    for (const role of RoleTask.literals) {
      const { tools } = toolArgs(DEFAULT_CONFIG, role)
      expect(tools.includes("write")).toBe(routeFor(role).capabilities.includes("Write"))
      expect(tools.includes("edit")).toBe(routeFor(role).capabilities.includes("Write"))
    }
  })

  test("no specialist gets the root's tools", () => {
    for (const role of RoleTask.literals) {
      const { tools } = toolArgs(DEFAULT_CONFIG, role)
      expect(tools).not.toContain("+codemode")
      expect(tools).not.toContain("codemode")
    }
  })

  test("argv renders --tools, then --exclude-tools only when something is excluded", () => {
    expect(toolArgs(DEFAULT_CONFIG, "Explorer.map").argv).toEqual([
      "--tools",
      "read,grep,find,ls",
      "--exclude-tools",
      "write,edit,bash",
    ])
    expect(toolArgs(DEFAULT_CONFIG, "Worker.implementation").argv).toEqual([
      "--tools",
      "read,grep,find,ls,write,edit,bash",
    ])
  })
})

describe("toolArgs for the root", () => {
  test("adds codemode to the default selection and takes write and edit away", () => {
    expect(toolArgs(DEFAULT_CONFIG, "root")).toEqual({
      tools: ["+codemode"],
      excludeTools: ["write", "edit"],
      noMcp: false,
      argv: ["--tools", "+codemode", "--exclude-tools", "write,edit"],
    })
  })

  test("allToolArgs covers the root and all 18 specialists", () => {
    const all = allToolArgs(DEFAULT_CONFIG)
    expect(Object.keys(all).sort()).toEqual(["root", ...RoleTask.literals].sort())
    expect(all.root).toEqual(toolArgs(DEFAULT_CONFIG, "root"))
  })
})

describe("the web tools of the Librarian roles", () => {
  test("the provider's own tools are used by default, and pi-web-kit is not loaded", () => {
    expect(toolArgs(DEFAULT_CONFIG, "Librarian.research").tools).toEqual([...READ, ...MOONSHOT])
    expect(piPackages(DEFAULT_CONFIG)).not.toContain("npm:pi-web-kit@0.5.0")
  })

  test("a provider without web tools falls back to pi-web-kit, which is then loaded", () => {
    expect(toolArgs(DEFAULT_CONFIG, "Librarian.lookup", NO_WEB_PROVIDER).tools).toEqual([
      ...READ,
      ...WEB_KIT,
    ])
    expect(piPackages(DEFAULT_CONFIG, NO_WEB_PROVIDER)).toContain("npm:pi-web-kit@0.5.0")
  })

  test("pi-web-kit selected in config.json is loaded and its tools are named", () => {
    const config = withFeatures({ web: "pi-web-kit" })
    expect(toolArgs(config, "Librarian.research").tools).toEqual([...READ, ...WEB_KIT])
    expect(piPackages(config)).toContain("npm:pi-web-kit@0.5.0")
  })

  test("web off gives the Librarian roles no web tool and loads no web package", () => {
    const config = withFeatures({ web: "off" })
    expect(toolArgs(config, "Librarian.research").tools).toEqual(READ)
    expect(piPackages(config)).not.toContain("npm:pi-web-kit@0.5.0")
  })

  test("webChoice: off has none, the provider's tools win in provider mode, the kit is the fallback", () => {
    const kimi = PROVIDERS["kimi-coding-global"]
    expect(webChoice(kimi, "off")).toEqual({ source: "off", tools: [] })
    expect(webChoice(kimi, "provider")).toEqual({ source: "provider", tools: MOONSHOT })
    expect(webChoice(kimi, "pi-web-kit")).toEqual({ source: "pi-web-kit", tools: WEB_KIT })
    expect(webChoice(NO_WEB_PROVIDER, "provider")).toEqual({ source: "pi-web-kit", tools: WEB_KIT })
    expect(webChoice(NO_WEB_PROVIDER, "off").source).toBe("off")
  })

  test("no role but the Librarians gets a web tool", () => {
    for (const role of RoleTask.literals) {
      const { tools } = toolArgs(DEFAULT_CONFIG, role)
      const web = tools.some((tool) => MOONSHOT.includes(tool) || WEB_KIT.includes(tool))
      expect(web).toBe(role.startsWith("Librarian."))
    }
  })
})

describe("the feature switches and the tool arguments", () => {
  test("mcp off starts every process with --no-mcp and names no MCP tool for the visual roles", () => {
    const config = withFeatures({ mcp: false })
    for (const args of Object.values(allToolArgs(config))) {
      expect(args.noMcp).toBe(true)
      expect(args.argv.at(-1)).toBe("--no-mcp")
      expect(args.tools.some((tool) => tool.startsWith("mcp__"))).toBe(false)
    }
    expect(toolArgs(config, "Reviewer.visual").tools).toEqual([...READ, ...COMPUTER_USE_TOOLS])
  })

  test("mcp on leaves --no-mcp out", () => {
    for (const args of Object.values(allToolArgs(DEFAULT_CONFIG))) {
      expect(args.noMcp).toBe(false)
      expect(args.argv).not.toContain("--no-mcp")
    }
  })

  test("computerUse off drops the computer-use tools and its package, and nothing else", () => {
    const config = withFeatures({ computerUse: false })
    expect(toolArgs(config, "Worker.visual").tools).toEqual([
      ...READ,
      "write",
      "edit",
      "bash",
      ...T3_VISUAL_TOOLS,
    ])
    expect(toolArgs(config, "Reviewer.visual").tools).toEqual([...READ, ...T3_VISUAL_TOOLS])
    expect(piPackages(config)).not.toContain("npm:@amaster.ai/pi-computer-use@0.1.36")
  })

  test("only the two visual roles get T3 Code and computer-use tools", () => {
    for (const role of RoleTask.literals) {
      const { tools } = toolArgs(DEFAULT_CONFIG, role)
      const visual = tools.some(
        (tool) => tool.startsWith("mcp__") || tool.startsWith("computer_use_"),
      )
      expect(visual).toBe(role.endsWith(".visual"))
    }
  })

  test("the T3 patterns match both spellings of the server name and nothing else", () => {
    expect(T3_VISUAL_TOOLS).toEqual([
      "mcp__t3*code__preview_*",
      "mcp__t3*code__t3_preview_*",
      "mcp__t3*code__html_render",
      "mcp__t3*code__html_preview",
      "mcp__t3*code__device_*",
    ])
    const matches = (pattern: string, name: string) =>
      new RegExp(`^${pattern.replaceAll("*", ".*")}$`).test(name)
    const allowed = (name: string) => T3_VISUAL_TOOLS.some((pattern) => matches(pattern, name))
    expect(allowed("mcp__t3-code__preview_open")).toBe(true)
    expect(allowed("mcp__t3_code__html_render")).toBe(true)
    expect(allowed("mcp__t3-code__device_list")).toBe(true)
    expect(allowed("mcp__t3-code__delegate_task")).toBe(false)
    expect(allowed("mcp__other__preview_open")).toBe(false)
  })

  test("todo, ask and processes are the root's by default selection and add no specialist tool", () => {
    const off = withFeatures({ todo: false, ask: false, processes: false })
    expect(allToolArgs(off)).toEqual(allToolArgs(DEFAULT_CONFIG))
    expect(piPackages(off)).toEqual(
      piPackages(DEFAULT_CONFIG).filter(
        (source) => !/rpiv-todo|rpiv-ask-user-question|pi-processes/.test(source),
      ),
    )
  })
})

describe("toolSettings", () => {
  test("the default config yields the provider tools, Billion Context and computer-use settings", () => {
    expect(toolSettings(DEFAULT_CONFIG)).toEqual([
      {
        file: "~/.pi/providers/kimi-coding/config.json",
        content: {
          tools: { moonshot_search: { enabled: true }, moonshot_fetch: { enabled: true } },
        },
      },
      { file: BILLION_CONTEXT_FILE, content: { pi: { subagents: false } } },
      { file: BILLION_CONTEXT_DELEGATE_FILE, content: { delegate: { forceEnable: true } } },
      {
        file: PI_SETTINGS_FILE,
        content: { "pi-computer-use": { confirmAppLaunch: false, confirmDangerousActions: false } },
      },
    ])
  })

  test("Billion Context compresses the root and specialists with its own subagents off", () => {
    const patches = toolSettings(DEFAULT_CONFIG)
    expect(patches).toContainEqual({
      file: "~/.config/billion-context/billion-context.json",
      content: { pi: { subagents: false } },
    })
    expect(patches).toContainEqual({
      file: "~/.pi/acp.json",
      content: { delegate: { forceEnable: true } },
    })
  })

  test("contextCompression off writes no Billion Context settings", () => {
    const files = toolSettings(withFeatures({ contextCompression: false })).map((p) => p.file)
    expect(files).not.toContain(BILLION_CONTEXT_FILE)
    expect(files).not.toContain(BILLION_CONTEXT_DELEGATE_FILE)
  })

  test("computerUse off writes no computer-use setting", () => {
    expect(toolSettings(withFeatures({ computerUse: false })).map((p) => p.file)).not.toContain(
      PI_SETTINGS_FILE,
    )
  })

  test("the provider's web tools are enabled only in provider mode with a provider that has some", () => {
    const providerFile = PROVIDERS["kimi-coding-global"].toolsFile
    const files = (config: Config, profile?: ProviderProfile) =>
      toolSettings(config, profile).map((patch) => patch.file)
    expect(files(DEFAULT_CONFIG)).toContain(providerFile)
    expect(files(withFeatures({ web: "pi-web-kit" }))).not.toContain(providerFile)
    expect(files(withFeatures({ web: "off" }))).not.toContain(providerFile)
    expect(files(DEFAULT_CONFIG, NO_WEB_PROVIDER)).not.toContain(providerFile)
  })

  test("pi.enable off writes nothing", () => {
    const off: Config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enable: false } }
    expect(toolSettings(off)).toEqual([])
  })
})
