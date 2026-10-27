import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { $ } from "bun"

import { ROUTES } from "../../../runtime/src/domain/route.ts"
import { ROOT_CORE_FILES } from "../../../runtime/src/instructions/claude-5.5/root-core.ts"
import { build } from "../build.ts"
import packageJson from "../package.json" with { type: "json" }
import {
  BUILTIN_TOOLS,
  CONDITIONAL_SECTIONS,
  FRONTEND_DESIGN_SECTION,
  INSPECTION_SECTION,
  MERGE_READY_SECTION,
  NATIVE_WEB_TOOLS,
  REQUIREMENT_SECTIONS,
  ROLE_SECTIONS,
  ROOT_SECTIONS,
  SPECIALIST_SECTIONS,
  WRITING_BAR_SECTION,
} from "../src/agents.ts"
import { DIST_DIRECTORY, VENDOR_DIRECTORY } from "../src/files.ts"
import { generate, GENERATED_PATHS, MARKETPLACE_PATH } from "../src/generate.ts"
import { fresh, PLUGIN, ROOT } from "./built.ts"

const read = (...path: Array<string>) => readFileSync(join(ROOT, ...path), "utf8")
const CLAUDE = "packages/runtime/src/instructions/claude-5.5"
const AGENTS = join("packages", "integrations", "claude", "dist", "agents")

/** The paths of every file below a path of the repository, relative to the repository. */
const filesBelow = async (path: string): Promise<ReadonlyArray<string>> => {
  const absolute = join(ROOT, path)
  if (await Bun.file(absolute).exists()) return [path]
  return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: absolute, dot: true })))
    .map((file) => join(path, file))
    .toSorted()
}

const generated = await generate()
const agent = (name: string) => generated.find((file) => file.path.endsWith(`agents/${name}.md`))
const frontmatter = (text: string) => text.split("\n---\n")[0] ?? ""
const field = (text: string, key: string) =>
  new RegExp(`^${key}: (.*)$`, "m").exec(frontmatter(text))?.[1]
/** The tools an agent's `disallowedTools` line lists, found by the agent file's path. */
const deniedTools = (path: string): ReadonlyArray<string> =>
  (
    field(generated.find((file) => file.path.endsWith(path))?.content ?? "", "disallowedTools") ??
    ""
  )
    .split(", ")
    .filter(Boolean)

describe("the generated plugin is in step with its sources", () => {
  test("every committed generated file equals a fresh build, byte for byte", async () => {
    const root = await fresh
    for (const file of generated) {
      expect({ path: file.path, text: read(file.path) }).toEqual({
        path: file.path,
        text: file.content,
      })
      expect({ path: file.path, text: await Bun.file(join(root, file.path)).text() }).toEqual({
        path: file.path,
        text: file.content,
      })
    }
  })

  test("the generated paths hold no file the build does not make, except the vendored tools", async () => {
    const committed = (await Promise.all(GENERATED_PATHS.map(filesBelow)))
      .flat()
      .filter((path) => !path.startsWith(`${VENDOR_DIRECTORY}/`))
      .toSorted()
    expect(committed).toEqual(generated.map((file) => file.path))
  })

  test("a build keeps the vendored tools where they are and removes any other file of the plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "holyagent-keep-"))
    const kept = join(root, VENDOR_DIRECTORY, "linux-x64", "rg")
    const stale = join(root, DIST_DIRECTORY, "scripts", "stale.txt")
    await Bun.write(kept, "program")
    await Bun.write(stale, "old")
    await build(root)
    expect({
      kept: await Bun.file(kept).text(),
      stale: await Bun.file(stale).exists(),
      wrapper: await Bun.file(join(root, DIST_DIRECTORY, "scripts", "holyagent")).exists(),
    }).toEqual({ kept: "program", stale: false, wrapper: true })
    await rm(root, { recursive: true, force: true })
  })

  test("the plugin has no top-level bin folder, which claude.ai refuses", () => {
    expect(readdirSync(PLUGIN)).not.toContain("bin")
    expect(generated.filter((file) => file.path.startsWith(`${DIST_DIRECTORY}/bin/`))).toEqual([])
  })

  test("the plugin ships no prebuilt workflow: the root writes each script on the spot", () => {
    expect(generated.filter((file) => file.path.includes("/workflows/"))).toEqual([])
  })

  test("the build is deterministic", async () => {
    const again = await generate()
    expect(again).toEqual(generated)
  })

  test("the wrapper is the one executable", async () => {
    const wrapper = join(PLUGIN, "scripts", "holyagent")
    expect((await Bun.file(wrapper).stat()).mode & 0o111).not.toBe(0)
    expect(generated.filter((file) => file.executable).map((file) => file.path)).toEqual([
      "packages/integrations/claude/dist/scripts/holyagent",
    ])
  })

  test("the commit hook stages exactly the generated paths", () => {
    const stage = read("lefthook.yml").split("git add -A --")[1] ?? ""
    expect(
      stage
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ).toEqual([...GENERATED_PATHS])
  })

  test("generated files carry the note where their format allows one", () => {
    for (const file of generated) {
      const noted = !file.path.endsWith(".json") && !file.path.includes("frontend-design")
      expect({
        path: file.path,
        noted: file.content.includes("Generated by packages/integrations/claude/build.ts"),
      }).toEqual({
        path: file.path,
        noted,
      })
    }
  })

  test("the frontend-design license ships untouched beside the embedded text, not as a skill", () => {
    expect(read("packages/integrations/claude/dist/licenses/frontend-design/LICENSE.txt")).toBe(
      read("packages/integrations/claude/vendor/frontend-design/LICENSE.txt"),
    )
    expect(generated.filter((file) => file.path.includes("/skills/frontend-design"))).toEqual([])
  })
})

describe("manifests", () => {
  const manifest = JSON.parse(
    read("packages/integrations/claude/dist/.claude-plugin/plugin.json"),
  ) as Record<string, unknown>
  const marketplace = JSON.parse(read(MARKETPLACE_PATH)) as Record<string, unknown>

  test("the plugin is named and versioned from the package", () => {
    expect(manifest).toMatchObject({
      name: "holyagent",
      version: packageJson.version,
      author: { name: "davidbasilefilho" },
      license: "Apache-2.0",
      dependencies: ["billion-context@billion-context", "exa@claude-plugins-official"],
    })
  })

  test("the marketplace points at the built plugin with the same version", () => {
    expect(marketplace).toMatchObject({
      name: "holyagent",
      owner: { name: "davidbasilefilho" },
      allowCrossMarketplaceDependenciesOn: ["billion-context", "claude-plugins-official"],
      plugins: [
        {
          name: "holyagent",
          source: "./packages/integrations/claude/dist",
          version: packageJson.version,
          description: manifest.description,
        },
      ],
    })
  })

  test("the root agent is the main thread", () => {
    expect(JSON.parse(read("packages/integrations/claude/dist/settings.json"))).toEqual({
      agent: "holyagent",
    })
  })
})

describe("hooks", () => {
  const { hooks } = JSON.parse(read("packages/integrations/claude/dist/hooks/hooks.json")) as {
    hooks: Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>
  }
  const command = (name: string, extra: Record<string, unknown> = {}) => ({
    type: "command",
    command: "bun",
    args: [
      "--no-env-file",
      "--config=${CLAUDE_PLUGIN_ROOT}/scripts/empty-bunfig.toml",
      "${CLAUDE_PLUGIN_ROOT}/scripts/holyagent.js",
      "hook",
      name,
    ],
    timeout: 10,
    ...extra,
  })

  test("are exactly the session, subagent-start, reminder, workflow and launch hooks, in exec form that runs bun on the bundle, with no shell", () => {
    expect(hooks).toEqual({
      SessionStart: [
        { matcher: "startup|resume|clear|compact", hooks: [command("session-start")] },
      ],
      SubagentStart: [{ hooks: [command("subagent-start")] }],
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            command("vcs-reminder", { if: "Bash(*git*commit*)" }),
            command("vcs-reminder", { if: "Bash(*git*push*)" }),
          ],
        },
        { matcher: "Workflow", hooks: [command("workflow", { onFailure: "block" })] },
      ],
      PostToolUse: [{ matcher: "Agent", hooks: [command("agent-launch")] }],
    })
  })

  test("the launch hook runs only for the Agent tool and never blocks", () => {
    const launch = hooks.PostToolUse ?? []
    expect(launch.map((group) => group.matcher)).toEqual(["Agent"])
    for (const hook of launch.flatMap((group) => group.hooks))
      expect(hook).not.toHaveProperty("onFailure")
  })

  test("no hook that carries version-control rules can block, and no hook is a Bash guard", () => {
    const carriers = [...(hooks.SubagentStart ?? []), ...(hooks.PreToolUse ?? [])]
      .filter((group) => group.matcher !== "Workflow")
      .flatMap((group) => group.hooks)
    expect(carriers).toHaveLength(3)
    for (const hook of carriers) expect(hook).not.toHaveProperty("onFailure")
    expect(JSON.stringify(hooks)).not.toContain("redirect")
  })

  test("the reminder rules start on git with commit or push anywhere after it, and on nothing else", () => {
    const glob = (rule: string) => {
      const inner = rule.slice("Bash(".length, -1)
      return new RegExp(`^${inner.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
    }
    const [commit, push] = (hooks.PreToolUse?.[0]?.hooks ?? []).map((hook) => glob(String(hook.if)))
    for (const text of [
      "git commit -m x",
      "git -C d commit",
      "sudo git push",
      "env X=1 git commit -m x",
      "bash -c 'git push origin main'",
      "timeout 5 git push",
    ])
      expect(commit?.test(text) || push?.test(text)).toBe(true)
    for (const text of ["npm test", "git status", "bun check", "ls -la", "git log --oneline"])
      expect(commit?.test(text) || push?.test(text)).toBe(false)
  })
})

describe("agents", () => {
  test("have one agent for each route plus the root, named in kebab case like the route", () => {
    const names = generated
      .filter((file) => file.path.includes("/agents/"))
      .map((file) => file.path.split("/").at(-1)?.replace(/\.md$/, "") ?? "")
      .toSorted()
    expect(names).toEqual(["holyagent", ...ROUTES.map((route) => route.agent)].toSorted())
    for (const route of ROUTES)
      expect(field(agent(route.agent)?.content ?? "", "name")).toBe(route.agent)
    expect(field(agent("holyagent")?.content ?? "", "name")).toBe("holyagent")
  })

  test("no agent name or reference has a dot or an uppercase letter, and each is a route's agent", () => {
    const agents = new Set(ROUTES.map((route) => route.agent))
    const references = generated
      .filter((file) => !file.path.includes("/scripts/"))
      .flatMap((file) => file.content.match(/holyagent:[A-Za-z0-9._-]+/g) ?? [])
      .map((reference) => reference.slice("holyagent:".length))
    const known = new Set([...agents, "dev-server", "user-busy"])
    for (const name of [...references, ...ROUTES.map((route) => route.agent)]) {
      expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
      expect(known.has(name)).toBe(true)
    }
    for (const file of generated.filter((f) => f.path.includes("/agents/")))
      expect(frontmatter(file.content)).not.toMatch(/Worker\.|Reviewer\.|Explorer\.|Librarian\./)
  })

  test("the root's body is the files of root/ in the fixed order", () => {
    const body = ROOT_SECTIONS.map((name) => read(`${CLAUDE}/root`, name).trim()).join("\n\n")
    expect(agent("holyagent")?.content.endsWith(`\n---\n\n${body}\n`)).toBe(true)
    expect(ROOT_SECTIONS.slice(0, ROOT_CORE_FILES.length)).toEqual([...ROOT_CORE_FILES])
  })

  test("the root agent holds each of the user's behavior rules once", () => {
    const content = agent("holyagent")?.content ?? ""
    for (const rule of [
      "Acknowledge every user message",
      "names an action",
      "Every pending decision goes through AskUserQuestion",
      "never reach the same result through another tool",
      "After a denial, stop that line of work",
      "A brief acknowledgment is always allowed",
      "update_plan",
    ])
      expect({ rule, count: content.split(rule).length - 1 }).toEqual({ rule, count: 1 })
  })

  test("the static root text holds no cloud identity guidance: the session-start hook adds it in a cloud session", () => {
    const content = agent("holyagent")?.content ?? ""
    for (const part of ["get_me", "vcs identity", "users.noreply.github.com"])
      expect({ part, found: content.includes(part) }).toEqual({ part, found: false })
    expect(content).toContain("commits use the configured git identity")
  })

  test("the session reminder states each of the user's behavior rules once", () => {
    const reminder = read(CLAUDE, "session-reminder.md")
    for (const rule of [
      "Acknowledge every user message",
      "names an action",
      "AskUserQuestion",
      "After a denial, stop and report",
      "otherwise write only for decisions, blockers and the final report",
      "update_plan",
    ])
      expect({ rule, count: reminder.split(rule).length - 1 }).toEqual({ rule, count: 1 })
  })

  test("every requirement of requirements.md is implemented by a section that reaches its agents", () => {
    const lines = read("packages/runtime/src/instructions", "requirements.md").split("\n")
    const listed = lines.filter((line) => line.startsWith("- "))
    const ids = listed.map((line) => /^- (R-[A-Z]+(?:-[A-Z]+)*): \S/.exec(line)?.[1] ?? line)
    expect(ids.every((id) => /^R-[A-Z]+(?:-[A-Z]+)*$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.toSorted()).toEqual(Object.keys(REQUIREMENT_SECTIONS).toSorted())

    const assembled = [
      ...ROOT_SECTIONS.map((name) => `root/${name}`),
      ...SPECIALIST_SECTIONS.map((name) => `specialist/${name}`),
      ...CONDITIONAL_SECTIONS.map(({ file }) => `specialist/${file}`),
      ...Object.entries(ROLE_SECTIONS).flatMap(([role, names]) =>
        names.map((name) => `roles/${role}/${name}`),
      ),
    ]
    for (const [id, { section, phrase }] of Object.entries(REQUIREMENT_SECTIONS)) {
      expect({ id, assembled: assembled.includes(section) }).toEqual({ id, assembled: true })
      expect({ id, holds: read(CLAUDE, section).includes(phrase) }).toEqual({ id, holds: true })
      const conditional = CONDITIONAL_SECTIONS.find(({ file }) => section === `specialist/${file}`)
      const reached = section.startsWith("root/")
        ? ["holyagent"]
        : section.startsWith("roles/")
          ? [section.split("/")[1] ?? ""]
          : ROUTES.filter((route) => conditional?.applies(route) ?? true).map(
              (route) => route.agent,
            )
      for (const name of reached)
        expect({ id, name, reaches: agent(name)?.content.includes(phrase) }).toEqual({
          id,
          name,
          reaches: true,
        })
    }
  })

  test("every file of root/, specialist/ and roles/ is assembled and every assembled file exists", () => {
    const assembled = (folder: string, names: ReadonlyArray<string>) => {
      expect({ folder, files: readdirSync(join(ROOT, CLAUDE, folder)).toSorted() }).toEqual({
        folder,
        files: [...names].toSorted(),
      })
      expect(new Set(names).size).toBe(names.length)
    }
    assembled("root", ROOT_SECTIONS)
    assembled("specialist", [
      ...SPECIALIST_SECTIONS,
      ...CONDITIONAL_SECTIONS.map(({ file }) => file),
    ])
    expect(Object.keys(ROLE_SECTIONS).toSorted()).toEqual(ROUTES.map((r) => r.agent).toSorted())
    for (const [role, names] of Object.entries(ROLE_SECTIONS)) {
      assembled(`roles/${role}`, names)
      expect(names[0]).toBe("purpose.md")
    }
  })

  test("a specialist is its role sections, then the conduct sections, in the fixed order", () => {
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      const parts = [
        ...(ROLE_SECTIONS[route.agent] ?? []).map((name) =>
          read(`${CLAUDE}/roles/${route.agent}`, name).trim(),
        ),
        ...SPECIALIST_SECTIONS.map((name) => read(`${CLAUDE}/specialist`, name).trim()),
      ]
      const at = parts.map((part) => text.indexOf(part))
      expect(at.every((position) => position >= 0)).toBe(true)
      expect(at).toEqual(at.toSorted((a, b) => a - b))
    }
  })

  test("the root carries the instruction guidelines and the stacking and task list defaults", () => {
    const text = agent("holyagent")?.content ?? ""
    expect(text).toContain(read(`${CLAUDE}/root`, "instruction-guidelines.md").trim())
    expect(text).toContain("Every PR of one delivery stacks in work order by default")
    expect(text).not.toContain("only on a real code dependency")
    expect(text).toContain("Create the task list first")
  })

  test("the language rule is stated by the root and the specialists, and nothing contradicts it", () => {
    const root = agent("holyagent")?.content ?? ""
    expect(root).toContain("in English by default unless the target repository's convention")
    expect(root).toContain("in the language of the user's latest message")
    for (const route of ROUTES)
      expect(agent(route.agent)?.content).toContain(
        "in English unless the repository's convention says otherwise",
      )
    for (const file of generated.filter((f) => f.path.includes("/agents/")))
      expect(file.content).not.toMatch(
        /user's language|repository's language|in the user's most recent language/,
      )
  })

  test("specialists run in the background with a warm cache and the route's model and effort", () => {
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      expect(field(text, "model")).toBe(route.model)
      expect(field(text, "effort")).toBe(route.effort)
      expect(field(text, "background")).toBe("true")
      expect(frontmatter(text)).toContain("experimental:\n  cacheTtl: 1h")
      expect(text).toContain(
        `You are the holyagent ${route.agent} specialist. Independence: ${route.independence}.`,
      )
      for (const name of SPECIALIST_SECTIONS)
        expect(text).toContain(read(`${CLAUDE}/specialist`, name).trim())
    }
  })

  test("no agent has a tools line, and every one inherits MCP tools while denying the native web tools", () => {
    for (const file of generated.filter((f) => f.path.includes("/agents/"))) {
      const head = frontmatter(file.content)
      expect(head).not.toMatch(/^tools:/m)
      expect(head).not.toMatch(/Agent\(/)
      const denied = deniedTools(file.path)
      for (const web of NATIVE_WEB_TOOLS) expect(denied).toContain(web)
      expect(denied.some((tool) => tool.startsWith("mcp__"))).toBe(false)
      for (const tool of denied) expect(BUILTIN_TOOLS).toContain(tool)
    }
  })

  test("each role keeps exactly its built-in tools, with Grep and Glob only where there is no Bash", () => {
    const reading = ["Read", "Grep", "Glob"]
    // A role with Bash searches with the bundled ripgrep and fd, so it has no Grep or Glob.
    const writing = ["Read", "Write", "Edit", "Bash", "Monitor"]
    const shell = ["Read", "Bash", "Monitor"]
    const previous: Record<string, ReadonlyArray<string>> = {
      holyagent: [
        "Agent",
        "SendMessage",
        "AskUserQuestion",
        "Skill",
        "Monitor",
        "Workflow",
        "TaskCreate",
        "TaskUpdate",
        "TaskList",
        "TaskGet",
        "Read",
        "Bash",
      ],
      "explorer-map": reading,
      "explorer-lookup": reading,
      "explorer-trace": reading,
      "librarian-lookup": reading,
      "librarian-research": reading,
      "reviewer-artifact": reading,
      "reviewer-audit": reading,
      "reviewer-visual": reading,
      "reviewer-security": [...reading, "Skill"],
      "reviewer-code": [...shell, "Skill"],
      "reviewer-testing": shell,
      "worker-operations": shell,
      "worker-validation": shell,
      "worker-mechanical": writing,
      "worker-implementation": writing,
      "worker-integration": writing,
      "worker-debugging": writing,
      "worker-visual": writing,
    }
    expect(Object.keys(previous).toSorted()).toEqual(
      ["holyagent", ...ROUTES.map((route) => route.agent)].toSorted(),
    )
    for (const [name, builtins] of Object.entries(previous)) {
      const effective = BUILTIN_TOOLS.filter(
        (tool) => !deniedTools(`agents/${name}.md`).includes(tool),
      )
      // ToolSearch loads deferred MCP tools, so every agent keeps it besides its previous built-ins.
      expect({ name, effective: effective.toSorted() }).toEqual({
        name,
        effective: [...builtins, "ToolSearch"].toSorted(),
      })
    }
    // The documented built-ins a background subagent keeps, and the root's extras, are all covered.
    for (const tool of ["Write", "Edit", "NotebookEdit", "Bash", "WebSearch", "WebFetch", "Agent"])
      expect(BUILTIN_TOOLS).toContain(tool)
  })

  test("the root runs on opus, and the librarians are still told to search with the Exa tools", () => {
    expect(field(agent("holyagent")?.content ?? "", "model")).toBe("opus")
    for (const name of ["librarian-lookup", "librarian-research"]) {
      const text = agent(name)?.content ?? ""
      expect(text).toContain("`web_search_exa`")
      expect(text).toContain("`web_fetch_exa`")
    }
  })

  test("the removed skills are gone from the plugin, and the roles start with the built-in reviews", () => {
    const names = generated
      .filter((file) => file.path.endsWith("SKILL.md"))
      .map((file) => file.path.split("/").at(-2) ?? "")
      .toSorted()
    expect(names).toEqual(["dev-server", "user-busy"])
    expect(agent("reviewer-code")?.content).toContain(
      "Start every review, re-reviews included, with the built-in `/code-review`",
    )
    expect(agent("reviewer-security")?.content).toContain("built-in `/security-review`")
    for (const text of generated.map((file) => file.content))
      expect(text).not.toMatch(/`assignments` skill|grill-me|stacks-and-ci|continue-work/)
  })

  test("no specialist preloads a skill: what a role always needs is fixed text in it", () => {
    for (const route of ROUTES)
      expect(frontmatter(agent(route.agent)?.content ?? "")).not.toContain("skills:")
  })

  test("the mergeability bar and the inspection rules are fixed text in exactly the roles that need them, once", () => {
    for (const { file, applies } of CONDITIONAL_SECTIONS) {
      const section = read(`${CLAUDE}/specialist`, file).trim()
      for (const route of ROUTES) {
        const text = agent(route.agent)?.content ?? ""
        expect({ file, agent: route.agent, copies: text.split(section).length - 1 }).toEqual({
          file,
          agent: route.agent,
          copies: applies(route) ? 1 : 0,
        })
      }
    }
    const merge = ROUTES.filter((route) =>
      agent(route.agent)?.content.includes("A change is merge-ready when"),
    ).map((route) => route.agent)
    expect(merge.toSorted()).toEqual(
      [
        "worker-mechanical",
        "worker-implementation",
        "worker-integration",
        "worker-debugging",
        "worker-visual",
        "reviewer-code",
        "reviewer-testing",
      ].toSorted(),
    )
    expect(MERGE_READY_SECTION).toBe("merge-ready.md")
    const inspecting = ROUTES.filter((route) =>
      agent(route.agent)?.content.includes(read(`${CLAUDE}/specialist`, INSPECTION_SECTION).trim()),
    ).map((route) => route.agent)
    expect(inspecting.toSorted()).toEqual(["reviewer-visual", "worker-visual"])
  })

  test("the visual roles embed the frontend-design guidance with its headings two levels down and its license named", () => {
    const vendored = read("packages/integrations/claude/vendor/frontend-design", "SKILL.md")
    const guidance = vendored
      .slice(vendored.indexOf("# Frontend Design"))
      .trim()
      .split("\n")
      .map((line) => (line.startsWith("#") ? `##${line}` : line))
      .join("\n")
    expect(guidance.length).toBeGreaterThan(5000)
    expect(guidance).toStartWith("### Frontend Design")
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      const visual = ["worker-visual", "reviewer-visual"].includes(route.agent)
      expect({ agent: route.agent, embedded: text.includes(guidance) }).toEqual({
        agent: route.agent,
        embedded: visual,
      })
      if (visual) {
        const framing = read(`${CLAUDE}/roles/${route.agent}`, FRONTEND_DESIGN_SECTION).trim()
        expect(text).toContain(`${framing}\n\n${guidance}`)
        expect(text).toContain("licenses/frontend-design/LICENSE.txt")
      }
    }
  })

  test("each agent description stands alone, without pointing at text below it", () => {
    for (const route of ROUTES)
      expect({
        agent: route.agent,
        points: /\b(below|above)\b/.test(
          field(agent(route.agent)?.content ?? "", "description") ?? "",
        ),
      }).toEqual({ agent: route.agent, points: false })
  })

  test("the dev-server skill is generated, opens with the situation, and covers start, share and stop", () => {
    const skill = generated.find((file) =>
      file.path.endsWith("skills/dev-server/SKILL.md"),
    )?.content
    expect(skill).toBeDefined()
    expect(field(skill ?? "", "name")).toBe("dev-server")
    expect(field(skill ?? "", "description")).toStartWith("Use when ")
    for (const part of [
      "Worker.operations",
      "process id",
      "Worker.visual and Reviewer.visual",
      "start none of your own",
      "Stop it",
    ])
      expect(skill).toContain(part)
    expect(read("packages/integrations/claude/dist/skills/dev-server/SKILL.md")).toBe(skill ?? "")
  })

  test("the root judges visual work from a section of its own, ahead of the guidelines", () => {
    expect(ROOT_SECTIONS.indexOf("visual.md")).toBeGreaterThan(
      ROOT_SECTIONS.indexOf("assignments.md"),
    )
    expect(agent("holyagent")?.content).toContain(read(`${CLAUDE}/root`, "visual.md").trim())
  })

  test("the writing bar is in the implementation writer and the artifact reviewer once, and nowhere else", () => {
    const bar = read(`${CLAUDE}/specialist`, WRITING_BAR_SECTION).trim()
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      const wanted = ["worker-implementation", "reviewer-artifact"].includes(route.agent)
      expect({ agent: route.agent, copies: text.split(bar).length - 1 }).toEqual({
        agent: route.agent,
        copies: wanted ? 1 : 0,
      })
    }
    for (const role of ["worker-implementation", "reviewer-artifact"])
      for (const name of ROLE_SECTIONS[role] ?? [])
        expect(read(`${CLAUDE}/roles/${role}`, name)).not.toContain("compact and proportional")
  })

  test("agent files sit where the plugin expects them", () => {
    expect(AGENTS).toBe("packages/integrations/claude/dist/agents")
  })
})

const available = (await $`claude --version`.quiet().nothrow()).exitCode === 0

describe("claude plugin validate", () => {
  const check = async (directory: string) => {
    const result = await $`claude plugin validate --strict ${directory}`.quiet().nothrow()
    return { code: result.exitCode, text: `${result.stdout.toString()}${result.stderr.toString()}` }
  }
  // The "plugin directory" block (README, license, icon) is about listing in Anthropic's catalog and
  // does not change the result, so it is cut before checking for errors and warnings.
  const clean = (text: string) => {
    const own = text.replace(
      /Plugin directory checks for[\s\S]*?The directory also runs[^\n]*\n/,
      "",
    )
    expect(own).toContain("Validation passed")
    expect(own).not.toMatch(/×|Found \d+ (?:error|warning)/)
  }

  test.skipIf(!available)("the built plugin passes strict validation", async () => {
    const { code, text } = await check(PLUGIN)
    expect(code).toBe(0)
    clean(text)
  })

  test.skipIf(!available)("the repository root marketplace passes strict validation", async () => {
    const { code, text } = await check(ROOT)
    expect(code).toBe(0)
    clean(text)
  })

  test.skipIf(available)("is skipped because the claude CLI is not installed", () => {
    console.warn("claude is not on PATH: plugin validation did not run")
  })
})
