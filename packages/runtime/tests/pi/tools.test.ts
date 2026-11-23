import { describe, expect, test } from "bun:test"

import {
  BROWSE_TOOLS,
  BROWSER_USE_ALL_TOOLS,
  BROWSER_USE_TOOLS,
  T3_PREVIEW_TOOLS,
} from "../../src/config/capabilities.ts"
import { piPackages } from "../../src/config/packages.ts"
import type { Config } from "../../src/config/schema.ts"
import { RoleTask, routeFor } from "../../src/domain/route.ts"
import {
  BILLION_CONTEXT_GUARDRAILS_FILE,
  BILLION_CONTEXT_GUARDRAILS_OFF,
} from "../../src/pi/bash/guardrails.ts"
import { type ProviderProfile, PROVIDERS, webChoice } from "../../src/pi/provider.ts"
import {
  allToolArgs,
  BILLION_CONTEXT_FILE,
  CODEMODE_MAX_WORKERS_ENV,
  COMPUTER_USE_TOOLS,
  deactivatedT3Tools,
  isDeactivatedT3Tool,
  PI_FFF_FILE,
  PI_SETTINGS_FILE,
  POWERSHELL_ENTRY,
  rootActiveTools,
  SUBAGENTS_SETTINGS_FILE,
  T3_VISUAL_TOOLS,
  toolArgs,
  toolMatches,
  toolSettings,
} from "../../src/pi/tools.ts"
import { DEFAULT_CONFIG } from "../config/defaults.ts"

const withFeatures = (features: Partial<Config["pi"]["features"]>): Config => ({
  ...DEFAULT_CONFIG,
  pi: { ...DEFAULT_CONFIG.pi, features: { ...DEFAULT_CONFIG.pi.features, ...features } },
})

/** A provider whose extension offers no web tools, to try the fallback. */
const NO_WEB_PROVIDER: ProviderProfile = { ...PROVIDERS["kimi-coding-global"], webTools: [] }

const READ = ["read", "grep", "find", "ls", "multi_grep", "ffgrep", "fffind", "fff-multi-grep"]
const MOONSHOT = ["moonshot_search", "moonshot_fetch"]
// What @ff-labs/pi-fff registers, under Pi's own names in override mode and under its own otherwise
// (the default mode, --fff-mode, PI_FFF_MODE, a working directory it does not index); every role has them.
const FFF_TOOLS = ["grep", "find", "multi_grep", "ffgrep", "fffind", "fff-multi-grep"]
const WEB_KIT = ["web_search", "web_fetch"]
// Pi offers `powershell` beside `bash` on Windows; a role has both or neither.
const SHELLS = ["bash", "powershell"]

/** The decided `--tools` allowlist of each specialist with the default config, before `codemode`. */
const EXPECTED: Readonly<Record<RoleTask, ReadonlyArray<string>>> = {
  "Explorer.map": READ,
  "Explorer.lookup": READ,
  "Explorer.trace": READ,
  "Librarian.lookup": [...READ, ...MOONSHOT],
  "Librarian.research": [...READ, ...MOONSHOT],
  "Worker.mechanical": [...READ, "write", "edit", ...SHELLS],
  "Worker.implementation": [...READ, "write", "edit", ...SHELLS],
  "Worker.integration": [...READ, "write", "edit", ...SHELLS],
  "Worker.debugging": [...READ, "write", "edit", ...SHELLS],
  "Worker.operations": [...READ, ...SHELLS],
  "Worker.validation": [...READ, ...SHELLS],
  "Worker.visual": [...READ, "write", "edit", ...SHELLS, ...T3_VISUAL_TOOLS, ...COMPUTER_USE_TOOLS],
  "Reviewer.visual": [...READ, ...T3_VISUAL_TOOLS, ...COMPUTER_USE_TOOLS],
  "Reviewer.code": [...READ, ...SHELLS],
  "Reviewer.testing": [...READ, ...SHELLS],
  "Reviewer.audit": READ,
  "Reviewer.security": READ,
  "Reviewer.artifact": READ,
}

describe("toolArgs for the specialists", () => {
  test.each(RoleTask.literals)("%s gets the decided allowlist", (role) => {
    expect(toolArgs(DEFAULT_CONFIG, role).tools).toEqual([...EXPECTED[role], "codemode"])
  })

  test("the write tools a role lacks are excluded, and only those", () => {
    for (const role of RoleTask.literals) {
      const { tools, excludeTools } = toolArgs(DEFAULT_CONFIG, role)
      expect(excludeTools).toEqual(
        ["write", "edit", ...SHELLS].filter((tool) => !tools.includes(tool)),
      )
    }
    expect(toolArgs(DEFAULT_CONFIG, "Explorer.map").excludeTools).toEqual([
      "write",
      "edit",
      ...SHELLS,
    ])
    expect(toolArgs(DEFAULT_CONFIG, "Worker.validation").excludeTools).toEqual(["write", "edit"])
    expect(toolArgs(DEFAULT_CONFIG, "Worker.implementation").excludeTools).toEqual([])
  })

  test("powershell goes wherever bash goes, and is excluded wherever bash is", () => {
    for (const role of RoleTask.literals) {
      const { tools, excludeTools } = toolArgs(DEFAULT_CONFIG, role)
      expect(tools.includes("powershell")).toBe(tools.includes("bash"))
      expect(excludeTools.includes("powershell")).toBe(excludeTools.includes("bash"))
    }
    expect(toolArgs(DEFAULT_CONFIG, "Worker.operations").excludeTools).not.toContain("powershell")
    expect(toolArgs(DEFAULT_CONFIG, "Reviewer.audit").excludeTools).toContain("powershell")
  })

  test("only the Write capability grants write and edit", () => {
    for (const role of RoleTask.literals) {
      const { tools } = toolArgs(DEFAULT_CONFIG, role)
      expect(tools.includes("write")).toBe(routeFor(role).capabilities.includes("Write"))
      expect(tools.includes("edit")).toBe(routeFor(role).capabilities.includes("Write"))
    }
  })

  test.each(RoleTask.literals)("%s runs codemode, with the worker cap exported", (role) => {
    const { tools, env, argv } = toolArgs(DEFAULT_CONFIG, role)
    expect(tools.at(-1)).toBe("codemode")
    expect(tools).not.toContain("+codemode")
    expect(env).toEqual({ [CODEMODE_MAX_WORKERS_ENV]: "4", ...BILLION_CONTEXT_GUARDRAILS_OFF })
    expect(argv[1]).toBe(tools.join(","))
  })

  test("no specialist gets the root's other tools", () => {
    for (const role of RoleTask.literals) {
      const { tools } = toolArgs(DEFAULT_CONFIG, role)
      for (const name of ["todo", "ask_user_question", "process"]) expect(tools).not.toContain(name)
    }
  })

  test("argv renders --tools, then --exclude-tools only when something is excluded", () => {
    expect(toolArgs(DEFAULT_CONFIG, "Explorer.map").argv).toEqual([
      "--tools",
      "read,grep,find,ls,multi_grep,ffgrep,fffind,fff-multi-grep,codemode",
      "--exclude-tools",
      "write,edit,bash,powershell",
    ])
    expect(toolArgs(DEFAULT_CONFIG, "Worker.implementation").argv).toEqual([
      "--tools",
      "read,grep,find,ls,multi_grep,ffgrep,fffind,fff-multi-grep,write,edit,bash,powershell,codemode",
    ])
  })
})

describe("toolArgs for the root", () => {
  test("adds codemode to the default selection and takes write, edit, computer use and web away", () => {
    expect(toolArgs(DEFAULT_CONFIG, "root")).toEqual({
      tools: ["+codemode", ...FFF_TOOLS.map((name) => `+${name}`)],
      excludeTools: [
        "write",
        "edit",
        ...COMPUTER_USE_TOOLS,
        ...BROWSE_TOOLS,
        ...BROWSER_USE_ALL_TOOLS,
        ...MOONSHOT,
      ],
      noMcp: false,
      env: { PI_CODEMODE_MAX_WORKERS: "4", ...BILLION_CONTEXT_GUARDRAILS_OFF },
      argv: [
        "--tools",
        "+codemode,+grep,+find,+multi_grep,+ffgrep,+fffind,+fff-multi-grep",
        "--exclude-tools",
        "write,edit,computer_use_*,mcp__browse__*,mcp__browser_use__*,moonshot_search,moonshot_fetch",
      ],
    })
  })

  test("excludes the computer-use tools only while pi.features.computerUse is on", () => {
    const on = toolArgs(
      withFeatures({ computerUse: true, fff: false, browserUse: false, web: "off" }),
      "root",
    )
    const off = toolArgs(
      withFeatures({ computerUse: false, fff: false, browserUse: false, web: "off" }),
      "root",
    )
    expect(on.excludeTools).toEqual(["write", "edit", ...COMPUTER_USE_TOOLS])
    expect(off.excludeTools).toEqual(["write", "edit"])
  })

  test("excludes the tools of the web choice: pi-web-kit, the provider's, or none", () => {
    const exclusions = (web: Config["pi"]["features"]["web"], profile?: ProviderProfile) =>
      toolArgs(
        withFeatures({ computerUse: false, fff: false, browserUse: false, web }),
        "root",
        profile,
      ).excludeTools
    expect(exclusions("pi-web-kit")).toEqual(["write", "edit", ...MOONSHOT, ...WEB_KIT])
    expect(exclusions("provider", PROVIDERS["kimi-coding-global"])).toEqual([
      "write",
      "edit",
      ...MOONSHOT,
    ])
    expect(exclusions("provider", NO_WEB_PROVIDER)).toEqual(["write", "edit", ...MOONSHOT])
    expect(exclusions("off")).toEqual(["write", "edit"])
  })

  test("allows the FFF tools for root and specialists only while the capability is on", () => {
    const on = toolArgs(
      withFeatures({ fff: true, computerUse: false, browserUse: false, web: "off" }),
      "root",
    )
    const off = toolArgs(
      withFeatures({ fff: false, computerUse: false, browserUse: false, web: "off" }),
      "root",
    )
    expect(on.excludeTools).toEqual(["write", "edit"])
    expect(on.tools).toEqual(["+codemode", ...FFF_TOOLS.map((name) => `+${name}`)])
    expect(off.tools).toEqual(["+codemode"])
    expect(off.excludeTools).toEqual(["write", "edit"])
    for (const role of RoleTask.literals)
      expect(toolArgs(DEFAULT_CONFIG, role).tools).toEqual([
        ...toolArgs(withFeatures({ fff: false }), role).tools.slice(0, 4),
        ...FFF_TOOLS.filter((name) => name !== "grep" && name !== "find"),
        ...toolArgs(withFeatures({ fff: false }), role).tools.slice(4),
      ])
  })

  test("the worker cap follows pi.codemode.maxWorkers for the root and every specialist", () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      pi: { ...DEFAULT_CONFIG.pi, codemode: { ...DEFAULT_CONFIG.pi.codemode, maxWorkers: 7 } },
    }
    for (const args of Object.values(allToolArgs(config))) {
      expect(args.env[CODEMODE_MAX_WORKERS_ENV]).toBe("7")
    }
  })

  test("allToolArgs covers the root and all 18 specialists", () => {
    const all = allToolArgs(DEFAULT_CONFIG)
    expect(Object.keys(all).sort()).toEqual(["root", ...RoleTask.literals].sort())
    expect(all.root).toEqual(toolArgs(DEFAULT_CONFIG, "root"))
  })
})

describe("the web tools of the Librarian roles", () => {
  test("the provider's own tools are used by default, and pi-web-kit is not loaded", () => {
    expect(toolArgs(DEFAULT_CONFIG, "Librarian.research").tools).toEqual([
      ...READ,
      ...MOONSHOT,
      "codemode",
    ])
    expect(piPackages(DEFAULT_CONFIG)).not.toContain("npm:pi-web-kit@0.5.0")
  })

  test("a root provider without native search does not silently select fallback", () => {
    expect(toolArgs(DEFAULT_CONFIG, "Librarian.lookup", NO_WEB_PROVIDER).tools).toEqual([
      ...READ,
      ...MOONSHOT,
      "codemode",
    ])
    expect(piPackages(DEFAULT_CONFIG, NO_WEB_PROVIDER)).not.toContain("npm:pi-web-kit@0.5.0")
  })

  test("pi-web-kit selected in config.json is loaded and its tools are named", () => {
    const config = withFeatures({ web: "pi-web-kit" })
    expect(toolArgs(config, "Librarian.research").tools).toEqual([
      ...READ,
      ...MOONSHOT,
      ...WEB_KIT,
      "codemode",
    ])
    expect(piPackages(config)).toContain("npm:pi-web-kit@0.5.0")
  })

  test("web off gives the Librarian roles no web tool and loads no web package", () => {
    const config = withFeatures({ web: "off" })
    expect(toolArgs(config, "Librarian.research").tools).toEqual([...READ, "codemode"])
    expect(piPackages(config)).not.toContain("npm:pi-web-kit@0.5.0")
  })

  test("webChoice: off has none, and fallback requires explicit configuration", () => {
    const kimi = PROVIDERS["kimi-coding-global"]
    expect(webChoice(kimi, "off")).toEqual({ source: "off", tools: [] })
    expect(webChoice(kimi, "provider")).toEqual({ source: "provider", tools: MOONSHOT })
    expect(webChoice(kimi, "pi-web-kit")).toEqual({
      source: "pi-web-kit",
      tools: [...MOONSHOT, ...WEB_KIT],
    })
    expect(webChoice(NO_WEB_PROVIDER, "provider")).toEqual({ source: "provider", tools: MOONSHOT })
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
    expect(toolArgs(config, "Reviewer.visual").tools).toEqual([
      ...READ,
      ...COMPUTER_USE_TOOLS,
      "codemode",
    ])
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
      ...SHELLS,
      ...T3_VISUAL_TOOLS,
      "codemode",
    ])
    expect(toolArgs(config, "Reviewer.visual").tools).toEqual([
      ...READ,
      ...T3_VISUAL_TOOLS,
      "codemode",
    ])
    expect(piPackages(config)).not.toContain("npm:@amaster.ai/pi-computer-use@0.1.38")
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
  test("the default config leaves provider settings alone and yields other capability settings", () => {
    expect(toolSettings(DEFAULT_CONFIG)).toEqual([
      { file: PI_SETTINGS_FILE, content: { codemode: { mode: "only" } } },
      {
        file: "~/.pi/agent/subagents.json",
        content: { disableDefaultAgents: true, fallbackSubagent: "none" },
      },
      { file: BILLION_CONTEXT_FILE, content: { pi: { subagents: false } } },
      {
        file: PI_SETTINGS_FILE,
        content: { "pi-computer-use": { confirmAppLaunch: false, confirmDangerousActions: false } },
      },
      {
        file: BILLION_CONTEXT_FILE,
        content: BILLION_CONTEXT_GUARDRAILS_FILE,
        whileOn: "contextCompression",
        revertWhenOff: true,
      },
      {
        file: PI_FFF_FILE,
        content: { mode: "override" },
        revertWhenOff: true,
      },
    ])
  })

  test("fff puts pi-fff in override mode, leaving followSymlinks unset, while it is on and its native library covers the host", () => {
    const patches = (config: Config, platform?: string) =>
      toolSettings(config, undefined, "normal", platform).filter((p) => p.file === PI_FFF_FILE)
    expect(patches(DEFAULT_CONFIG, "linux-x64")).toEqual([
      {
        file: PI_FFF_FILE,
        content: { mode: "override" },
        revertWhenOff: true,
      },
    ])
    expect(patches(withFeatures({ fff: false }), "linux-x64")).toEqual([])
    expect(patches(DEFAULT_CONFIG, "freebsd-x64")).toEqual([])
    expect(patches(DEFAULT_CONFIG, "linux-riscv64")).toEqual([])
  })

  test("Billion Context gets exactly the README's setting for subagents off, compression on", () => {
    const files = toolSettings(DEFAULT_CONFIG).map((patch) => patch.file)
    expect(files).not.toContain("~/.pi/acp.json")
    const subagents = toolSettings(DEFAULT_CONFIG).filter(
      (p) => p.file.includes("billion-context") && "pi" in p.content,
    )
    expect(subagents).toEqual([
      {
        file: "~/.config/billion-context/billion-context.json",
        content: { pi: { subagents: false } },
      },
    ])
  })

  test("the codemode mode in Pi's settings follows pi.codemode.mode", () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      pi: { ...DEFAULT_CONFIG.pi, codemode: { ...DEFAULT_CONFIG.pi.codemode, mode: "on" } },
    }
    expect(toolSettings(config)).toContainEqual({
      file: PI_SETTINGS_FILE,
      content: { codemode: { mode: "on" } },
    })
  })

  test("only the specialists launch while subagents is on: the defaults are off and no type falls back", () => {
    const patches = toolSettings(DEFAULT_CONFIG).filter((p) => p.file === SUBAGENTS_SETTINGS_FILE)
    expect(patches).toEqual([
      {
        file: SUBAGENTS_SETTINGS_FILE,
        content: { disableDefaultAgents: true, fallbackSubagent: "none" },
      },
    ])
  })

  test("subagents off writes no package settings, since the package is not loaded", () => {
    const files = toolSettings(withFeatures({ subagents: false })).map((p) => p.file)
    expect(files).not.toContain(SUBAGENTS_SETTINGS_FILE)
  })

  test("contextCompression off writes no Billion Context settings", () => {
    const files = toolSettings(withFeatures({ contextCompression: false })).map((p) => p.file)
    expect(files).not.toContain(BILLION_CONTEXT_FILE)
    expect(files).not.toContain("~/.pi/acp.json")
  })

  test("computerUse off writes no computer-use setting", () => {
    expect(
      toolSettings(withFeatures({ computerUse: false })).filter(
        (p) => "pi-computer-use" in p.content,
      ),
    ).toEqual([])
  })

  test("no web mode writes the provider's optional tool settings", () => {
    const providerFile = PROVIDERS["kimi-coding-global"].toolsFile ?? ""
    const files = (config: Config, profile?: ProviderProfile) =>
      toolSettings(config, profile).map((patch) => patch.file)
    expect(files(DEFAULT_CONFIG)).not.toContain(providerFile)
    expect(files(withFeatures({ web: "pi-web-kit" }))).not.toContain(providerFile)
    expect(files(withFeatures({ web: "off" }))).not.toContain(providerFile)
    expect(files(DEFAULT_CONFIG, NO_WEB_PROVIDER)).not.toContain(providerFile)
  })

  test("pi.enable off writes nothing", () => {
    const off: Config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, enable: false } }
    expect(toolSettings(off)).toEqual([])
  })
})

describe("POWERSHELL_ENTRY", () => {
  test("adds powershell to the root's tools unless the root excludes it", () => {
    const root = toolArgs(DEFAULT_CONFIG, "root")
    const withShell = { ...root, tools: [...root.tools, POWERSHELL_ENTRY] }
    const active = ["read", "bash"]
    expect(rootActiveTools(withShell, active, ["read", "bash", "powershell"])).toEqual([
      "read",
      "bash",
      "codemode",
      "powershell",
    ])
    expect(rootActiveTools(root, active, ["read", "bash", "powershell"])).toEqual([
      "read",
      "bash",
      "codemode",
    ])
  })
})

describe("rootActiveTools", () => {
  const root = toolArgs(DEFAULT_CONFIG, "root")
  const registered = [
    "read",
    "bash",
    "write",
    "edit",
    "todo",
    "codemode",
    "moonshot_search",
    "moonshot_fetch",
    "computer_use_click",
    "computer_use_type",
    "mcp__t3_code__preview_open",
  ]

  test("toolMatches takes an exact name or a pattern whose * is any run of characters", () => {
    expect(toolMatches("write", "write")).toBe(true)
    expect(toolMatches("write", "rewrite")).toBe(false)
    expect(toolMatches("computer_use_*", "computer_use_click")).toBe(true)
    expect(toolMatches("computer_use_*", "xcomputer_use_click")).toBe(false)
    expect(toolMatches("mcp__t3*code__preview_*", "mcp__t3-code__preview_open")).toBe(true)
    expect(toolMatches("a.b", "axb")).toBe(false)
  })

  test("literal and wildcard policies match both names of known aliases", () => {
    for (const [pattern, original, alias] of [
      ["agent", "Agent", "agent"],
      ["Agent", "Agent", "agent"],
      ["agent*", "Agent", "agent"],
      ["Agent*", "Agent", "agent"],
      ["subagent_*", "SubagentWorkflow", "subagent_workflow"],
      ["Subagent*", "SubagentWorkflow", "subagent_workflow"],
      ["fff_multi_*", "fff-multi-grep", "fff_multi_grep"],
      ["fff-multi-*", "fff-multi-grep", "fff_multi_grep"],
    ]) {
      expect(toolMatches(pattern!, original!)).toBe(true)
      expect(toolMatches(pattern!, alias!)).toBe(true)
    }
    expect(toolMatches("agent*", "AgentOther")).toBe(false)
    expect(toolMatches("subagent_*", "SubagentOther")).toBe(false)
    expect(toolMatches("fff_multi_*", "fff-multi-other")).toBe(false)
  })

  test("alias patterns add and exclude both registered names", () => {
    const names = ["Agent", "agent", "SubagentWorkflow", "subagent_workflow", "other"]
    expect(rootActiveTools({ tools: ["+agent*"], excludeTools: [] }, [], names)).toEqual([
      "Agent",
      "agent",
    ])
    expect(rootActiveTools({ tools: [], excludeTools: ["subagent_*"] }, names, names)).toEqual([
      "Agent",
      "agent",
      "other",
    ])
  })

  test("is the active selection plus the root's tools, minus the excluded ones", () => {
    expect(
      rootActiveTools(
        root,
        ["read", "bash", "write", "edit", "todo", "moonshot_search"],
        registered,
      ),
    ).toEqual(["read", "bash", "todo", "codemode"])
  })

  test("a pattern excludes every active tool it matches, and keeps the rest", () => {
    expect(
      rootActiveTools(
        root,
        ["read", "computer_use_click", "computer_use_type", "todo"],
        registered,
      ),
    ).toEqual(["read", "todo", "codemode"])
  })

  test("a pattern in tools adds every registered tool it matches", () => {
    expect(
      rootActiveTools(
        { tools: ["+computer_use_*", "plain"], excludeTools: ["computer_use_type"] },
        ["read"],
        registered,
      ),
    ).toEqual(["read", "computer_use_click", "plain"])
  })

  test("a tool in both the selection and the additions appears once", () => {
    expect(rootActiveTools(root, ["codemode", "read"], registered)).toEqual(["codemode", "read"])
  })
})

describe("the T3 Code tools the root keeps off", () => {
  const KEPT = [
    "html_render",
    "html_preview",
    "preview_open",
    "preview_snapshot",
    "t3_preview_open",
    "device_list",
    "device_tap",
  ]
  const DROPPED = [
    "orchestrator_capabilities",
    "delegate_task",
    "task_status",
    "task_cancel",
    "create_threads",
    "t3_thread_list",
    "t3_thread_send",
    "schedule_task",
    "list_scheduled_tasks",
    "delete_scheduled_task",
    "t3_pending_request",
    "html_render_all",
    "devices",
  ]

  test("are every T3 tool, in either spelling of the server, outside the visual families", () => {
    for (const server of ["mcp__t3-code__", "mcp__t3_code__"]) {
      for (const name of KEPT) expect(isDeactivatedT3Tool(`${server}${name}`)).toBe(false)
      for (const name of DROPPED) expect(isDeactivatedT3Tool(`${server}${name}`)).toBe(true)
    }
  })

  test("leave every tool of another server or of Pi alone", () => {
    for (const name of ["read", "bash", "codemode", "mcp__other__delegate_task", "delegate_task"])
      expect(isDeactivatedT3Tool(name)).toBe(false)
  })

  test("are picked out of a registered list in its order", () => {
    const registered = [
      "read",
      "mcp__t3-code__delegate_task",
      "mcp__t3-code__html_render",
      "mcp__t3_code__schedule_task",
    ]
    expect(deactivatedT3Tools(registered)).toEqual([
      "mcp__t3-code__delegate_task",
      "mcp__t3_code__schedule_task",
    ])
  })
})

describe("toolArgs with the screen capability", () => {
  const SCREEN = [...COMPUTER_USE_TOOLS, ...BROWSE_TOOLS, ...T3_PREVIEW_TOOLS]
  const T3_DEVICE = "mcp__t3*code__device_*"

  test("a specialist of any role gets the computer-use, browse and T3 preview tools after its own", () => {
    for (const role of RoleTask.literals) {
      const plain = toolArgs(DEFAULT_CONFIG, role).tools
      const screen = toolArgs(DEFAULT_CONFIG, role, undefined, { screen: true }).tools
      const added = screen.filter((tool) => !plain.includes(tool))
      // The visual roles already have computer use and T3's tools; the others gain every one.
      const visual = routeFor(role).capabilities.includes("VisualInspection")
      expect(added.toSorted(), role).toEqual((visual ? BROWSE_TOOLS : SCREEN).toSorted())
      for (const tool of SCREEN) expect(screen, role).toContain(tool)
      expect(screen.at(-1), role).toBe("codemode")
      // Only the screen tools differ, and the write tools stay as the role decides.
      expect(
        screen.filter((tool) => plain.includes(tool)),
        role,
      ).toEqual([...plain])
    }
  })

  test("an Assignment without it gets none of them beyond what a visual role always had", () => {
    for (const role of RoleTask.literals) {
      const plain = toolArgs(DEFAULT_CONFIG, role).tools
      const visual = routeFor(role).capabilities.includes("VisualInspection")
      expect(
        plain.some((tool) => BROWSE_TOOLS.includes(tool)),
        role,
      ).toBe(false)
      expect(
        plain.some((tool) => COMPUTER_USE_TOOLS.includes(tool)),
        role,
      ).toBe(visual)
      expect(
        plain.some((tool) => T3_PREVIEW_TOOLS.includes(tool)),
        role,
      ).toBe(visual)
      expect(plain, role).toEqual(
        toolArgs(DEFAULT_CONFIG, role, undefined, { screen: false }).tools,
      )
    }
  })

  test("T3's device tools are not part of it", () => {
    expect(
      toolArgs(DEFAULT_CONFIG, "Worker.implementation", undefined, { screen: true }).tools,
    ).not.toContain(T3_DEVICE)
  })

  test("a capability that is off, or whose switch is off, adds none of its tools", () => {
    const tools = (features: Partial<Config["pi"]["features"]>) =>
      toolArgs(withFeatures(features), "Worker.implementation", undefined, { screen: true }).tools
    expect(tools({ computerUse: false })).not.toContain("computer_use_*")
    expect(tools({ browserUse: false })).not.toContain("mcp__browse__*")
    expect(tools({ mcp: false }).some((tool) => tool.startsWith("mcp__t3"))).toBe(false)
    // The MCP servers run in Pi's MCP extension, so their tools need it on.
    expect(tools({ mcp: false }).some((tool) => tool.startsWith("mcp__"))).toBe(false)
    expect(tools({ mcp: false })).toContain("computer_use_*")
    expect(tools({ mcp: true })).toContain("mcp__browse__*")
  })

  test("the headless form grants browser-use's exec and screenshot tools, never its login, and no computer-use or browse tool, whatever the role", () => {
    for (const role of RoleTask.literals) {
      const screen = toolArgs(DEFAULT_CONFIG, role, undefined, {
        screen: true,
        form: "headless",
      }).tools
      for (const tool of [...BROWSER_USE_TOOLS, ...T3_PREVIEW_TOOLS])
        expect(screen, role).toContain(tool)
      expect(screen, role).not.toContain("mcp__browser_use__browser_login")
      expect(screen, role).not.toContain("mcp__browser_use__*")
      expect(
        screen.some((tool) => BROWSE_TOOLS.includes(tool)),
        role,
      ).toBe(false)
      // Not even a visual role, whose own tools they are in the normal form: a headless machine has
      // no desktop.
      expect(
        screen.some((tool) => COMPUTER_USE_TOOLS.includes(tool)),
        role,
      ).toBe(false)
    }
  })

  test("the normal form grants browse and no browser-use tool, and is the default", () => {
    const normal = toolArgs(DEFAULT_CONFIG, "Worker.implementation", undefined, {
      screen: true,
      form: "normal",
    }).tools
    expect(normal).toEqual(
      toolArgs(DEFAULT_CONFIG, "Worker.implementation", undefined, { screen: true }).tools,
    )
    for (const tool of BROWSE_TOOLS) expect(normal).toContain(tool)
    expect(normal.some((tool) => BROWSER_USE_TOOLS.includes(tool))).toBe(false)
  })

  test("without the capability the form changes nothing but a visual role's computer-use tools", () => {
    for (const role of RoleTask.literals) {
      const normal = toolArgs(DEFAULT_CONFIG, role).tools
      const headless = toolArgs(DEFAULT_CONFIG, role, undefined, { form: "headless" }).tools
      expect(headless, role).toEqual(normal.filter((tool) => !COMPUTER_USE_TOOLS.includes(tool)))
    }
  })

  test("the root takes no screen tools: it excludes them whether or not the option is passed", () => {
    expect(toolArgs(DEFAULT_CONFIG, "root", undefined, { screen: true })).toEqual(
      toolArgs(DEFAULT_CONFIG, "root"),
    )
    const { excludeTools } = toolArgs(DEFAULT_CONFIG, "root")
    for (const tool of [...COMPUTER_USE_TOOLS, ...BROWSE_TOOLS])
      expect(excludeTools).toContain(tool)
  })
})
