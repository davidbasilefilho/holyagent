import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, win32 } from "node:path"

import { $ } from "bun"

import { toPosix } from "../../../runtime/src/domain/paths.ts"
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
import { isExecutable } from "./host.ts"

const read = (...path: Array<string>) => readFileSync(join(ROOT, ...path), "utf8")
const CLAUDE = "packages/runtime/src/instructions/claude-5.5"
const AGENTS = join("packages", "integrations", "claude", "dist", "agents")
/** The skills of the plugin, which only the root loads. */
const SKILLS = [
  "ci-watch",
  "dev-server",
  "evidence-judging",
  "instruction-writing",
  "state-mode",
  "user-busy",
  "visual-judging",
]

/** The paths of every file below a path of the repository, relative to the repository. */
const filesBelow = async (path: string): Promise<ReadonlyArray<string>> => {
  const absolute = join(ROOT, path)
  if (await Bun.file(absolute).exists()) return [path]
  return (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: absolute, dot: true })))
    .map((file) => toPosix(join(path, file)))
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
    expect(await isExecutable(wrapper)).toBe(true)
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
    })
  })

  test("nothing depends on another plugin: web work goes through the Exa connector", () => {
    expect(manifest).not.toHaveProperty("dependencies")
    expect(marketplace).not.toHaveProperty("allowCrossMarketplaceDependenciesOn")
  })

  test("the marketplace points at the built plugin with the same version", () => {
    expect(marketplace).toMatchObject({
      name: "holyagent",
      owner: { name: "davidbasilefilho" },
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

  test("are exactly the session, rules, subagent-start, reminder, workflow and launch hooks, in exec form that runs bun on the bundle, with no shell", () => {
    expect(hooks).toEqual({
      SessionStart: [
        { matcher: "startup|resume|clear|compact", hooks: [command("session-start")] },
      ],
      UserPromptSubmit: [{ hooks: [command("root-rules")] }],
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
        { hooks: [command("root-rules")] },
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

  test("the rules hook runs for every prompt and every tool and never blocks", () => {
    const rules = [...(hooks.UserPromptSubmit ?? []), ...(hooks.PreToolUse ?? [])].filter((group) =>
      group.hooks.some((hook) => (hook.args as Array<string>).at(-1) === "root-rules"),
    )
    expect(rules.map((group) => [group.matcher, group.hooks.length])).toEqual([
      [undefined, 1],
      [undefined, 1],
    ])
    for (const hook of rules.flatMap((group) => group.hooks))
      expect(hook).not.toHaveProperty("onFailure")
  })

  test("no hook that carries version-control rules can block, and no hook is a Bash guard", () => {
    const carriers = [...(hooks.SubagentStart ?? []), ...(hooks.PreToolUse ?? [])]
      .filter((group) => group.matcher !== "Workflow")
      .flatMap((group) => group.hooks)
      .filter((hook) => (hook.args as Array<string>).at(-1) !== "root-rules")
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

describe("the setup command", () => {
  const command = generated.find((file) => file.path === `${DIST_DIRECTORY}/commands/setup.md`)
  const text = command?.content ?? ""

  test("the generator emits /holyagent:setup, with the generated note in its frontmatter", () => {
    expect(command).toBeDefined()
    expect(frontmatter(text)).toContain("# Generated by")
    expect(field(text, "description")).toBeTruthy()
  })

  test("it pre-authorizes only the setup invocation of the plugin's own CLI", () => {
    const allowed = field(text, "allowed-tools") ?? ""
    expect(allowed).toMatch(/^Bash\(bun [^)]*holyagent\.js\*? setup\*\)$/)
    expect(allowed).not.toContain(",")
  })

  test("the body runs the CLI through the plugin root, shows the report and asks for a restart", () => {
    expect(text).toContain('"${CLAUDE_PLUGIN_ROOT}/scripts/holyagent.js" setup $ARGUMENTS')
    expect(text).toContain('--config="${CLAUDE_PLUGIN_ROOT}/scripts/empty-bunfig.toml"')
    expect(text).toContain("exactly as the command printed it")
    expect(text).toContain("restart Claude Code")
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
    const known = new Set([...agents, ...SKILLS])
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

  test("the root text states the rules that two sections once shared in one section only", () => {
    const content = agent("holyagent")?.content ?? ""
    for (const rule of [
      "Run no gates, probes or data checks yourself",
      "never open or re-emit the brief",
      "no scheduled check-ins or wait loops",
      "Never force-push",
      "Hook and harness noise gets no mention or reply",
      "push once the reviews accept",
      "Read only what a decision needs",
    ])
      expect({ rule, count: content.split(rule).length - 1 }).toEqual({ rule, count: 1 })
    expect(content).not.toContain("Push only after the reviews accept")
  })

  test("the root text says what to do with an Assignment that assignment reports does not list", () => {
    const text = read(`${CLAUDE}/root`, "workflows.md")
    expect(text).toContain("does not list returned no result")
    expect(text).toContain(
      "close it with `--outcome errored` once the run has completed, without further confirmation",
    )
    expect(text).toContain("names the journal in its diagnostics")
    expect(text).toContain("`<transcript dir>/journal.jsonl`")
  })

  test("the root deletes branches only when the user asks and never proposes it or lists kept branches as work", () => {
    const content = (agent("holyagent")?.content ?? "").toLowerCase()
    for (const part of [
      "branches are the user's to remove: they keep history and references after a merge, and deleting is destructive",
      "delete a branch, local or remote, merged or not, only when the user asks",
      "do not pass `--delete-branch` (or the api equivalent) when merging",
      "leave a repository's own auto-delete-on-merge setting as it is",
      "do not propose deleting them",
      "offer deletion as an askuserquestion option",
      "list kept branches as remaining work or cleanup in a report",
    ])
      expect({ part, found: content.includes(part) }).toEqual({ part, found: true })
    const requirement = read("packages/runtime/src/instructions", "requirements.md")
      .split("\n")
      .find((line) => line.startsWith("- R-BRANCH:"))
    for (const part of [
      "they keep history and references after a merge",
      "only when the user asks",
      "after a merge, in the final report and in proposals",
      "do not pass --delete-branch when merging",
      "auto-delete-on-merge setting as it is",
      "remaining work or cleanup",
    ])
      expect({ part, found: requirement?.includes(part) }).toEqual({ part, found: true })
  })

  test("the root never asks whether or how to merge reviewed green PRs: it reports them ready, and merges on the user's word by convention, earlier answer, then default", () => {
    const content = (agent("holyagent")?.content ?? "").replace(/\s+/g, " ")
    for (const part of [
      "do not ask whether to merge or how; report them in the final report as ready to merge and wait",
      "merging needs the user to name it",
      "merge at once without asking the method",
      "the repository's convention (merge settings, CONTRIBUTING, the history of merged PRs)",
      "else the method the user chose earlier, else the holyagent default",
      "retarget the next PR to the base, since its commits are no longer in the base's history: if the base's tree equals the merged PR's head tree, reconcile the next branch with `git merge -s ours <base>`",
      "the reviewed green PRs that are ready to merge and wait for the user to say so (asking nothing about merging)",
    ])
      expect({ part, found: content.includes(part) }).toEqual({ part, found: true })
    const ciWatch = generated.find((file) =>
      file.path.endsWith("skills/ci-watch/SKILL.md"),
    )?.content
    expect(ciWatch).toContain("report the PR as ready to merge and do not ask whether to merge")
    expect(ciWatch).not.toContain("merging still needs the user's approval")
    const requirements = read("packages/runtime/src/instructions", "requirements.md")
    for (const id of ["R-NOASK", "R-MERGEWAIT"])
      expect({ id, found: requirements.includes(`- ${id}:`) }).toEqual({ id, found: true })
  })

  test("the root asks only a question that passes one general test, with the common unnecessary questions as illustrations and the rules that say when to ask agreeing", () => {
    const content = (agent("holyagent")?.content ?? "").replace(/\s+/g, " ")
    for (const part of [
      "A question is unnecessary when its answer would not change what you do, or when something already settles it",
      "the target repository's conventions",
      "a default that holyagent's rules or the repository define",
      "a fact a specialist can establish",
      "Ask only a question that passes this test",
      "These common questions fail the test",
      "whether to merge reviewed green PRs, or by which method",
      "whether to delete branches",
      "confirmation of a plan the user did not ask for",
      "whether to continue or to wait",
      "Ask only when the answer would change what you do",
    ])
      expect({ part, found: content.includes(part) }).toEqual({ part, found: true })
    expect(content).not.toContain("Ask only when the answer materially changes the result")
    const requirement = read("packages/runtime/src/instructions", "requirements.md")
    expect(requirement).toContain("- R-NOASK:")
  })

  test("every specialist, reviewers included, is told never to change HEAD, a branch, the index or the working tree of a shared checkout", () => {
    const rule =
      "Never change HEAD, a branch, the index or the working tree of a checkout other workers share with git commands (`switch`, `restore`, `clean`, `add`, `rebase`, `cherry-pick`)"
    const alternatives =
      "`git show <sha>:<path>`, `git diff`, or `git archive <sha>` extracted into the scratchpad"
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      expect({ agent: route.agent, rule: text.includes(rule) }).toEqual({
        agent: route.agent,
        rule: true,
      })
      expect({ agent: route.agent, alternatives: text.includes(alternatives) }).toEqual({
        agent: route.agent,
        alternatives: true,
      })
    }
    expect(agent("reviewer-code")?.content).toContain("never `git checkout`")
    expect(agent("reviewer-testing")?.content).toContain(
      "never `git checkout` in the shared checkout",
    )
    expect(agent("holyagent")?.content).not.toContain(rule)
  })

  test("the static root text holds no cloud identity guidance: the session-start hook adds it in a cloud session", () => {
    const content = agent("holyagent")?.content ?? ""
    for (const part of ["get_me", "vcs identity", "users.noreply.github.com"])
      expect({ part, found: content.includes(part) }).toEqual({ part, found: false })
    expect(content).toContain("commits use the configured git identity")
  })

  test("the session reminder states each rule once and none that the core root rules hold", () => {
    const reminder = read(CLAUDE, "session-reminder.md")
    for (const rule of ["task-list tool if it is deferred", "mid-turn", "names an action"])
      expect({ rule, count: reminder.split(rule).length - 1 }).toEqual({ rule, count: 1 })
    for (const rule of [
      "AskUserQuestion",
      "After a denial, stop",
      "holyagent vcs commit",
      "otherwise write only for decisions, blockers and the final report",
    ])
      expect({ rule, found: reminder.includes(rule) }).toEqual({ rule, found: false })
  })

  test("every requirement of requirements.md is implemented by a section that reaches its agents", () => {
    const lines = read("packages/runtime/src/instructions", "requirements.md").split("\n")
    const listed = lines.filter((line) => line.startsWith("- "))
    const ids = listed.map((line) => /^- (R-[A-Z]+(?:-[A-Z]+)*): \S/.exec(line)?.[1] ?? line)
    expect(ids.every((id) => /^R-[A-Z]+(?:-[A-Z]+)*$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.toSorted()).toEqual(Object.keys(REQUIREMENT_SECTIONS).toSorted())

    const assembled = [
      ...SKILLS.map((name) => `skills/${name}/SKILL.md`),
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
      if (section.startsWith("skills/")) {
        const skill = generated.find((file) => file.path.endsWith(section))
        expect({ id, skill: skill?.content.includes(phrase) }).toEqual({ id, skill: true })
        continue
      }
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
        "TaskStop",
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

  test("the root declares high effort, which the specialists' route-set efforts do not follow", () => {
    expect(field(agent("holyagent")?.content ?? "", "effort")).toBe("high")
    for (const route of ROUTES)
      expect(field(agent(route.agent)?.content ?? "", "effort")).toBe(route.effort)
  })

  test("the root keeps its context small, never polls, and routes mechanical work to haiku", () => {
    const text = agent("holyagent")?.content ?? ""
    for (const part of [
      "Run no gates, probes or data checks yourself",
      "never open or re-emit the brief",
      "`assignment close <id> --outcome <o> < <report-file>`",
      "a cap on the report",
      "no scheduled check-ins or wait loops",
      "a wake that changes nothing gets one short line",
      "The route table, not the brief, sets model and effort",
      "data, list or count corrections",
      "resolving conflicts in tests or generated files",
      "Worker.validation for gate runs",
      "builds and screenshot capture",
      "`holyagent assignment reports <journal.jsonl>`",
      "`{ done: [ids] }`",
    ])
      expect({ part, found: text.includes(part) }).toEqual({ part, found: true })
    expect(text).not.toContain("read the image in the main thread")
    expect(text).not.toContain("Read screenshots yourself")
  })

  test("the root never works on a platform-assigned branch, asks when the conventional push is refused, and commits atomically with squash merge by default", () => {
    const text = agent("holyagent")?.content ?? ""
    for (const part of [
      "Never work on a branch the platform assigns",
      "create the conventional branch and leave the assigned one alone",
      "If the push of the conventional branch is refused",
      "ask through AskUserQuestion whether to push to the assigned branch instead; never work around the refusal",
      "`exp/<experiment>/<type>/<change>` for work with no published version",
      "`release/<version>/<type>/<change>` when the repository has tags or releases",
      "each commit on a branch is atomic",
      "a Conventional Commit",
      "PRs merge by squash by default, with the PR title as the Conventional summary",
      "The repository's conventions, branch protection and merge settings come first",
      "After a lower PR squash-merges, retarget the next PR to the base",
    ])
      expect({ part, found: text.includes(part) }).toEqual({ part, found: true })
    for (const part of [
      "use it as the work branch",
      "When the platform assigns a branch",
      "whether to open the PR from a branch that follows it",
    ])
      expect({ part, found: text.includes(part) }).toEqual({ part, found: false })
    expect(text).not.toContain("when the version workflow fits")
  })

  test("the removed skills are gone from the plugin, and the roles start with the built-in reviews", () => {
    const names = generated
      .filter((file) => file.path.endsWith("SKILL.md"))
      .map((file) => file.path.split("/").at(-2) ?? "")
      .toSorted()
    expect(names).toEqual(SKILLS)
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

  test("the evidence-judging skill opens with the situation, gives each rule its reason, and the root points to it", () => {
    const skill = generated.find((file) =>
      file.path.endsWith("skills/evidence-judging/SKILL.md"),
    )?.content
    expect(skill).toBeDefined()
    expect(field(skill ?? "", "name")).toBe("evidence-judging")
    expect(field(skill ?? "", "description")).toStartWith(
      "Use when a specialist report carries a verdict the root must accept or reject: a blocking review finding, a research claim with conflicting sources or numbers, prose written for people, or a material design choice.",
    )
    for (const part of [
      "never from raw logs or whole files",
      "starts a repair only with evidence from the reviewer",
      "a file:line trace (for a vulnerability, source to sink) from one without",
      "a Reviewer.visual observation (viewport, interaction, visible result)",
      "back to the same reviewer for that evidence",
      "have a specialist re-derive any number before it is published or decided on",
      "keep inference labeled as inference",
      "Reviewer.artifact reviews it and you judge the excerpts it flags",
      "your brief asks an explorer for two or three short options with their trade-offs",
      "Routine choices stay with the writer",
      "a reproduction, the cause it shows, and a fix that makes the reproduction pass",
    ])
      expect({ part, found: skill?.includes(part) }).toEqual({ part, found: true })
    expect(read("packages/integrations/claude/dist/skills/evidence-judging/SKILL.md")).toBe(
      skill ?? "",
    )
    const root = agent("holyagent")?.content ?? ""
    expect(root).toContain(
      "`evidence-judging`: a specialist report carries a verdict you must accept or reject",
    )
  })

  test("the root loads visual-judging before the first visual dispatch and points to it for the repair-round rules", () => {
    const root = agent("holyagent")?.content ?? ""
    for (const part of [
      "`visual-judging`: load it before the first Worker.visual or Reviewer.visual dispatch",
      "loaded before the first visual dispatch",
      "starts a repair and a re-review once it carries the evidence `evidence-judging` requires",
      "a served static or single-file build",
    ])
      expect({ part, found: root.includes(part) }).toEqual({ part, found: true })
    const skill = generated.find((file) => file.path.endsWith("skills/visual-judging/SKILL.md"))
    expect(field(skill?.content ?? "", "description")).toStartWith(
      "Use before the first Worker.visual or Reviewer.visual dispatch",
    )
    const devServer = generated.find((file) => file.path.endsWith("skills/dev-server/SKILL.md"))
    expect(field(devServer?.content ?? "", "description")).toContain("static or single-file build")
  })

  test("Reviewer.artifact is a sonnet agent, and the root lists it with the sonnet roles, not the haiku ones", () => {
    expect(field(agent("reviewer-artifact")?.content ?? "", "model")).toBe("sonnet")
    expect(field(agent("reviewer-artifact")?.content ?? "", "effort")).toBe("high")
    expect(field(agent("reviewer-audit")?.content ?? "", "model")).toBe("haiku")
    const routing = read(`${CLAUDE}/root`, "routing.md")
    const haiku = routing.split("\n").find((line) => line.startsWith("- Haiku")) ?? ""
    const sonnet = routing.split("\n").find((line) => line.startsWith("- Sonnet")) ?? ""
    expect(haiku).toContain("Reviewer.audit")
    expect(haiku).not.toContain("Reviewer.artifact")
    expect(sonnet).toContain("the artifact, code, testing and security reviews")
    const requirements = read("packages/runtime/src/instructions", "requirements.md")
    expect(requirements).toContain("(Reviewer.artifact) goes to a sonnet route")
  })

  test("the four moment-specific sections are root skills that open with the situation, and their text is out of the root prompt", () => {
    const root = agent("holyagent")?.content ?? ""
    const extracted: Record<string, ReadonlyArray<string>> = {
      "visual-judging": [
        "A discrepancy is material, and starts a repair whatever its size",
        "Read an image in the main thread only to show it to the user (a path is not delivery) or to settle a concrete doubt",
        'say "round N of 3"',
        "at most three rounds per finding",
        "after three, report the finding as a blocker",
        "`html_render`",
      ],
      "ci-watch": [
        "Watch with Monitor running `gh pr checks <n> --watch`",
        "the only CI wait",
        "Failed, Unknown, Pending, Passed",
        "claims to verify",
      ],
      "instruction-writing": [
        "US English",
        "`requirements.md`",
        "prompting guidance",
        "in its own file",
        "`<example>` tags",
      ],
      "state-mode": [
        "set the mode with `holyagent state mode <mode>`",
        "`git ls-files .holyagent ':!.holyagent/config.json'`",
        "in one shared worktree",
      ],
    }
    expect(ROOT_SECTIONS).not.toContain("visual.md")
    expect(ROOT_SECTIONS).not.toContain("ci.md")
    const pointers = read(`${CLAUDE}/root`, "skills.md")
    for (const [name, parts] of Object.entries(extracted)) {
      const skill = generated.find((file) => file.path.endsWith(`skills/${name}/SKILL.md`))?.content
      expect({ name, generated: skill !== undefined }).toEqual({ name, generated: true })
      expect(field(skill ?? "", "name")).toBe(name)
      expect(field(skill ?? "", "description")).toStartWith("Use ")
      expect(pointers).toContain(`\`${name}\``)
      expect(root).toContain(`\`${name}\``)
      for (const part of parts) {
        expect({ name, part, inSkill: skill?.includes(part) }).toEqual({
          name,
          part,
          inSkill: true,
        })
        expect({ name, part, inRoot: root.includes(part) }).toEqual({ name, part, inRoot: false })
      }
    }
    // The brief essentials stay in the root: full task with reasons, keep-working, a real check.
    const briefs = read(`${CLAUDE}/root`, "instruction-guidelines.md")
    for (const part of ["Keep working until everything asked is done", "A real check before"])
      expect(briefs).toContain(part)
    expect(read("packages/integrations/claude/dist/skills/visual-judging/SKILL.md")).toBe(
      generated.find((file) => file.path.endsWith("skills/visual-judging/SKILL.md"))?.content ?? "",
    )
  })

  test("every agent prompt, the root's and each specialist's, says 'Respond tersely.'", () => {
    const agents = generated.filter((file) => file.path.includes("/agents/"))
    expect(agents).toHaveLength(ROUTES.length + 1)
    for (const file of agents)
      expect({ path: file.path, found: file.content.includes("Respond tersely.") }).toEqual({
        path: file.path,
        found: true,
      })
    for (const file of agents) expect(read(file.path)).toContain("Respond tersely.")
  })

  test("the root can stop a running agent or workflow, and only the root", () => {
    expect(deniedTools("agents/holyagent.md")).not.toContain("TaskStop")
    for (const route of ROUTES)
      expect(deniedTools(`agents/${route.agent}.md`)).toContain("TaskStop")
    const dispatch = read(`${CLAUDE}/root`, "dispatch.md")
    expect(dispatch).toContain(
      "only when a new requirement or new information conflicts with that running work",
    )
    expect(dispatch).toContain(
      "When finishing and then repairing costs less than stopping and relaunching",
    )
    expect(dispatch).toContain("Close a stopped Assignment with `--outcome stopped`")
    expect(dispatch).not.toMatch(/no polling, steering or stopping/)
    expect(read("packages/runtime/src/instructions", "requirements.md")).not.toContain(
      "steering or stopping",
    )
  })

  test("the guide gaps are each stated once, in the file that owns them", () => {
    const once = (text: string, phrase: string) => text.split(phrase).length - 1
    const root = agent("holyagent")?.content ?? ""
    const gaps: ReadonlyArray<readonly [string, string, string]> = [
      ["G1", `${CLAUDE}/root/task-list.md`, "End your turn only when the work is done"],
      ["G2", `${CLAUDE}/root/user-messages.md`, "asks for ideas, options or a plan"],
      [
        "G3",
        `${CLAUDE}/specialist/writing-bar.md`,
        "filler sections, redundant summaries or boilerplate",
      ],
      ["G4", `${CLAUDE}/specialist/scope.md`, "seems mistaken or a better approach exists"],
    ]
    for (const [gap, path, phrase] of gaps) {
      expect({ gap, count: once(read(path), phrase) }).toEqual({ gap, count: 1 })
      // No other instruction file states it.
      const holders = generated
        .filter((file) => file.path.includes("/agents/") || file.path.includes("/skills/"))
        .filter((file) => file.content.includes(phrase))
        .map((file) => file.path.split("/").at(-1))
      expect({ gap, holders: holders.length > 0 }).toEqual({ gap, holders: true })
    }
    expect(once(root, "asks for ideas, options or a plan")).toBe(1)
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      expect(once(text, "seems mistaken or a better approach exists")).toBe(1)
      expect(once(text, "End your turn only when the work is done")).toBe(0)
    }
  })

  test("the root states its own mistaken-request and no-filler rules once, each mapped to a requirement", () => {
    const root = agent("holyagent")?.content ?? ""
    const once = (text: string, phrase: string) => text.split(phrase).length - 1
    expect(once(root, "in your acknowledgment of that message and continue as asked")).toBe(1)
    expect(once(root, "free of filler sections, redundant summaries and boilerplate")).toBe(1)
    const requirements = read("packages/runtime/src/instructions", "requirements.md")
    expect(requirements).toContain("- R-FLAG:")
    expect(requirements).toContain("- R-NOFILLER:")
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
        expect(read(`${CLAUDE}/roles/${role}`, name)).not.toContain("State each rule once")
  })

  test("the context-file rule is in the implementation writer, the artifact reviewer and the instruction-writing skill only, convention first", () => {
    const rule = "codebase overviews"
    for (const route of ROUTES) {
      const wanted = ["worker-implementation", "reviewer-artifact"].includes(route.agent)
      const text = agent(route.agent)?.content ?? ""
      expect({ agent: route.agent, rule: text.includes(rule) }).toEqual({
        agent: route.agent,
        rule: wanted,
      })
      if (wanted) {
        expect(text).toContain("The repository's own convention for context files comes first")
        expect(text).toContain("only when the user ask")
      }
    }
    expect(agent("holyagent")?.content.includes(rule)).toBe(false)
    const skill = generated.find((file) =>
      file.path.endsWith("skills/instruction-writing/SKILL.md"),
    )
    expect(skill?.content).toContain(rule)
    expect(skill?.content).toContain(
      "The repository's own convention for context files comes first",
    )
    expect(skill?.content).toContain("only when the user asks")
    const requirements = read("packages/runtime/src/instructions", "requirements.md")
    expect(requirements).toContain("arXiv 2602.11988")
    expect(requirements).toContain("Inference: that paths in context files go stale")
  })

  test("agent files sit where the plugin expects them", () => {
    // The folder is joined with the platform's separator; the plugin and git expect it with `/`.
    expect(toPosix(AGENTS)).toBe("packages/integrations/claude/dist/agents")
    expect(toPosix(win32.join("packages", "integrations", "claude", "dist", "agents"), "\\")).toBe(
      "packages/integrations/claude/dist/agents",
    )
  })
})

const available = (await $`claude --version`.quiet().nothrow()).exitCode === 0

describe("claude plugin validate", () => {
  // The external claude CLI starts a fresh process per check; on a loaded machine (the parallel
  // verify gates, other workers) that can outlast the 5 s default, so the checks get a longer one.
  const VALIDATE_TIMEOUT = 30_000
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

  test.skipIf(!available)(
    "the built plugin passes strict validation",
    async () => {
      const { code, text } = await check(PLUGIN)
      expect(code).toBe(0)
      clean(text)
    },
    VALIDATE_TIMEOUT,
  )

  test.skipIf(!available)(
    "the repository root marketplace passes strict validation",
    async () => {
      const { code, text } = await check(ROOT)
      expect(code).toBe(0)
      clean(text)
    },
    VALIDATE_TIMEOUT,
  )

  test.skipIf(available)("is skipped because the claude CLI is not installed", () => {
    console.warn("claude is not on PATH: plugin validation did not run")
  })
})
