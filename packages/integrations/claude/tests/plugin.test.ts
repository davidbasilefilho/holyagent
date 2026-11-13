import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, normalize, win32 } from "node:path"

import { $ } from "bun"
import { Effect } from "effect"

import { LOCKFILE, VERSION_COPIES } from "../../../../scripts/bump-version.ts"
import { Dimension } from "../../../runtime/src/domain/assignment.ts"
import { toPosix } from "../../../runtime/src/domain/paths.ts"
import { ROUTES } from "../../../runtime/src/domain/route.ts"
import {
  PRECEDENCE_FILE,
  ROOT_CORE,
  ROOT_CORE_FILES,
} from "../../../runtime/src/instructions/claude-5.5/root-core.ts"
import { REQUIREMENT_COVERAGE } from "../../../runtime/src/instructions/coverage.ts"
import { parseRequirements } from "../../../runtime/src/instructions/requirements.ts"
import {
  embedMateriality,
  GUIDANCE_MARKER,
  guidanceRouter,
  OWNED_GUIDANCE,
} from "../../../runtime/src/instructions/skills.ts"
import { build } from "../build.ts"
import packageJson from "../package.json" with { type: "json" }
import {
  BUILTIN_TOOLS,
  CONDITIONAL_SECTIONS,
  DESIGN_SECTION,
  HISTORY_RULES_FILE,
  INSPECTION_SECTION,
  MATERIALITY_FILE,
  MERGE_READY_SECTION,
  NATIVE_WEB_TOOLS,
  ROLE_SECTIONS,
  ROOT_SECTIONS,
  SPECIALIST_SECTIONS,
  WRITING_BAR_SECTION,
} from "../src/agents.ts"
import { DIST_DIRECTORY } from "../src/files.ts"
import { DESCRIPTION, generate, GENERATED_PATHS, MARKETPLACE_PATH } from "../src/generate.ts"
import { field, fresh, PLUGIN, ROOT } from "./built.ts"
import { isExecutable } from "./host.ts"

const read = (...path: Array<string>) => readFileSync(join(ROOT, ...path), "utf8")
const CLAUDE = "packages/runtime/src/instructions/claude-5.5"
/** Every requirements file of the instruction sources, joined: the requirements as one text. */
const REQUIREMENTS = readdirSync(join(ROOT, "packages/runtime/src/instructions/requirements"), {
  recursive: true,
  encoding: "utf8",
})
  .map((path) => toPosix(path))
  .filter((path) => path.endsWith(".md"))
  .toSorted()
  .map((path) => read("packages/runtime/src/instructions/requirements", path))
  .join("\n")
const AGENTS = join("packages", "integrations", "claude", "dist", "agents")
/** The skills of the plugin, which only the root loads. */
const SKILLS = [
  "ci-watch",
  "desktop-design",
  "dev-server",
  "documentation-lookup",
  "evidence-judging",
  "instruction-writing",
  "mobile-design",
  "state-mode",
  "tui-design",
  "user-busy",
  "visual-judging",
  "web-design",
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

  test("the generated paths hold no file the build does not make", async () => {
    const committed = (await Promise.all(GENERATED_PATHS.map(filesBelow))).flat().toSorted()
    expect(committed).toEqual(generated.map((file) => file.path))
  })

  test("a build removes any other file of the plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "holyagent-keep-"))
    const stale = join(root, DIST_DIRECTORY, "scripts", "stale.txt")
    await Bun.write(stale, "old")
    await build(root)
    expect({
      stale: await Bun.file(stale).exists(),
      wrapper: await Bun.file(join(root, DIST_DIRECTORY, "scripts", "holyagent")).exists(),
    }).toEqual({ stale: false, wrapper: true })
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
    const stage = (read("lefthook.yml").split("git add -A --")[1] ?? "").split("- name:")[0] ?? ""
    expect(
      stage
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#")),
    ).toEqual([...GENERATED_PATHS])
  })

  test("the commit hook stages the copies of the version and the lockfile that the build rewrites", () => {
    const job = read("lefthook.yml").split("- name: versions")[1] ?? ""
    const staged = /git add -- (.*)/.exec(job)?.[1]?.trim().split(/\s+/)
    expect(staged).toEqual([...VERSION_COPIES, LOCKFILE])
  })

  test("generated files carry the note where their format allows one", () => {
    for (const file of generated) {
      const noted = !file.path.endsWith(".json")
      expect({
        path: file.path,
        noted: file.content.includes("Generated by packages/integrations/claude/build.ts"),
      }).toEqual({
        path: file.path,
        noted,
      })
    }
  })

  test("no frontend-design file, skill, license or mention is generated or built, and its vendor folder is gone", async () => {
    const mentions = /frontend.design/i
    expect(generated.filter((file) => mentions.test(file.path))).toEqual([])
    expect(
      generated.filter((file) => mentions.test(file.content)).map((file) => file.path),
    ).toEqual([])
    expect((await filesBelow(DIST_DIRECTORY)).filter((path) => mentions.test(path))).toEqual([])
    expect(readdirSync(join(ROOT, "packages/integrations/claude"))).not.toContain("vendor")
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
            command("vcs-reminder", { if: "Bash(*vcs commit*)" }),
            command("vcs-reminder", { if: "Bash(*vcs pr*)" }),
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
    expect(carriers).toHaveLength(5)
    for (const hook of carriers) expect(hook).not.toHaveProperty("onFailure")
    expect(JSON.stringify(hooks)).not.toContain("redirect")
  })

  test("the reminder rules start on git with commit or push anywhere after it, and on vcs with commit or pr after it, and on nothing else", () => {
    const glob = (rule: string) => {
      const inner = rule.slice("Bash(".length, -1)
      return new RegExp(`^${inner.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`)
    }
    const rules = (hooks.PreToolUse?.[0]?.hooks ?? []).map((hook) => glob(String(hook.if)))
    expect(rules).toHaveLength(4)
    for (const text of [
      "git commit -m x",
      "git -C d commit",
      "sudo git push",
      "env X=1 git commit -m x",
      "bash -c 'git push origin main'",
      "timeout 5 git push",
      "holyagent vcs commit -m x a",
      "bun --no-env-file holyagent.js vcs commit -m x a",
      "holyagent vcs pr --base main",
    ])
      expect(rules.some((rule) => rule.test(text))).toBe(true)
    for (const text of [
      "npm test",
      "git status",
      "bun check",
      "ls -la",
      "git log --oneline",
      "holyagent vcs status",
      "holyagent vcs identity",
    ])
      expect(rules.some((rule) => rule.test(text))).toBe(false)
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
    // The history rules continue the bullet list before them; every other section is a paragraph.
    const body = ROOT_SECTIONS.map(
      (name, at) =>
        `${at === 0 ? "" : name === HISTORY_RULES_FILE ? "\n" : "\n\n"}${read(
          `${CLAUDE}/root`,
          name,
        )
          .trim()
          .replace(
            GUIDANCE_MARKER,
            guidanceRouter("root", "claude-5.5", "${CLAUDE_PLUGIN_ROOT}"),
          )}`,
    ).join("")
    expect(agent("holyagent")?.content.endsWith(`\n---\n\n${body}\n`)).toBe(true)
    expect(ROOT_SECTIONS.slice(0, ROOT_CORE_FILES.length)).toEqual([...ROOT_CORE_FILES])
  })

  test("the root agent holds each of the user's behavior rules once", () => {
    const content = agent("holyagent")?.content ?? ""
    for (const rule of [
      "Acknowledge every user message",
      "names an action",
      "Send every pending decision through AskUserQuestion",
      "Never work around an unresolved denial through another tool, script, or link",
      "After an explicit user denial, stop that line of work",
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
      "no polling, steering, scheduled check-ins or wait loops",
      "Never force-push",
      "Ignore hook and harness noise",
      "push once the reviews accept",
      "Read only what a decision needs",
    ])
      expect({ rule, count: content.split(rule).length - 1 }).toEqual({ rule, count: 1 })
    expect(content).not.toContain("Push only after the reviews accept")
  })

  test("the root prompt opens with the exact core the session-start hook injects, and the branch rule sits in that core once", () => {
    const content = agent("holyagent")?.content ?? ""
    const body = content.slice(content.indexOf("\n---\n\n") + "\n---\n\n".length)
    expect(body.startsWith(`${ROOT_CORE}\n\n`)).toBe(true)
    const rule = "Never work on a branch the platform assigns"
    expect({ rule, count: content.split(rule).length - 1 }).toEqual({ rule, count: 1 })
    expect(ROOT_CORE).toContain(rule)
    expect(read(`${CLAUDE}/root`, "version-control.md")).not.toContain("platform assigns")
  })

  test("the precedence has one source file that the root core and the specialist text embed, and every prompt carries it once", () => {
    const source = read(CLAUDE, PRECEDENCE_FILE.replace("../", "")).trim()
    expect(source).toContain("1. mergeability in the target repository")
    expect(source).toContain("2. project patterns;")
    expect(source).toContain("3. HolyAgent defaults.")
    expect(source).toContain("does not waive a rule that needs the user's approval")
    expect(ROOT_CORE_FILES).toContain(PRECEDENCE_FILE)
    expect(ROOT_CORE).toContain(source)
    expect(SPECIALIST_SECTIONS).toContain(PRECEDENCE_FILE)
    for (const route of [undefined, ...ROUTES]) {
      const text = agent(route?.agent ?? "holyagent")?.content ?? ""
      expect({ agent: route?.agent, copies: text.split(source).length - 1 }).toEqual({
        agent: route?.agent,
        copies: 1,
      })
    }
    // No other source states the order, so there is nothing to keep in step with the shared file.
    for (const folder of ["root", "specialist"])
      for (const name of readdirSync(join(ROOT, CLAUDE, folder)))
        expect({
          name,
          states: read(CLAUDE, folder, name).includes("1. mergeability in the target repository"),
        }).toEqual({
          name,
          states: false,
        })
  })

  test("the code quality rules reach the writers and the reviewers of code and artifacts, and no other role", () => {
    const holding = ROUTES.filter((route) =>
      agent(route.agent)?.content.includes("## Code quality"),
    ).map((route) => route.agent)
    expect(holding.toSorted()).toEqual(
      [
        "worker-mechanical",
        "worker-implementation",
        "worker-integration",
        "worker-debugging",
        "worker-visual",
        "reviewer-code",
        "reviewer-testing",
        "reviewer-artifact",
      ].toSorted(),
    )
    const rules = read(`${CLAUDE}/specialist`, "code-quality.md")
    for (const part of [
      "No duplication: reuse existing code, helpers, abstractions and instructions",
      "extract a shared piece when the same logic or text appears twice",
      "repeated I/O, quadratic loops over data that grows, unbounded memory, blocking calls on hot paths and redundant process spawns",
      "Skip micro-optimization that costs readability without a measured or obvious gain",
      "comments that explain why, not what",
      "A writer extracts inside its ownership paths and reports duplication elsewhere under `notes:`",
      "A reviewer reports duplication of logic or instructions that the change introduces, and a performance problem with its evidence",
      "a finding blocks only when the change also makes existing behavior or performance worse, fails a gate, breaks a stated repository rule or leaves a duplicate that already disagrees with its original",
      "otherwise it is optional, as is anything already on the base",
    ])
      expect({ part, found: rules.includes(part) }).toEqual({ part, found: true })
  })

  test("the code quality text owns the severity of duplication and performance findings, and the other texts do not restate it", () => {
    const sources = {
      mergeReady: read(CLAUDE, "specialist", "merge-ready.md"),
      assignments: read(CLAUDE, "root", "assignments.md"),
      mergeability: read(
        "packages/runtime/src/instructions/requirements/specialist",
        "merge-ready.md",
      )
        .split("\n")
        .filter((line) => !line.startsWith("- R-MERGE:"))
        .join("\n"),
    }
    for (const [name, text] of Object.entries(sources)) {
      expect({ name, found: /duplicat\w* (?:logic|code)|performance problem/.test(text) }).toEqual({
        name,
        found: false,
      })
    }
    expect(sources.mergeReady).toContain("which set their own severity")
    expect(sources.assignments).toContain(
      "carry the severity the specialists' code quality rules give them",
    )
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      if (text.includes("## Code quality"))
        expect({
          agent: route.agent,
          copies: text.split("a finding blocks only when").length - 1,
        }).toEqual({
          agent: route.agent,
          copies: 1,
        })
    }
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
    const requirement = REQUIREMENTS.split("\n").find((line) => line.startsWith("- R-BRANCH:"))
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
      file.path.endsWith("guidance/claude-5.5/ci-watch/SKILL.md"),
    )?.content
    expect(ciWatch).toContain("report the PR as ready to merge and do not ask whether to merge")
    expect(ciWatch).not.toContain("merging still needs the user's approval")
    const requirements = REQUIREMENTS
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
      "Send every pending decision through AskUserQuestion (options, a recommended default), not a plain-text list.",
      "Use AskUserQuestion for every type of question, including when the user asks what needs their decision.",
    ])
      expect({ part, found: content.includes(part) }).toEqual({ part, found: true })
    expect(content).not.toContain("Ask only when the answer materially changes the result")
    const requirement = REQUIREMENTS
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

  test("every requirement of requirements/ is implemented by a section that reaches its agents", () => {
    const { ids } = parseRequirements(REQUIREMENTS)
    expect(new Set(ids).size).toBe(ids.length)
    const coverage = REQUIREMENT_COVERAGE["claude-5.5"]
    expect(ids.toSorted()).toEqual(Object.keys(coverage).toSorted())

    const assembled = [
      ...SKILLS.map((name) => `skills/${name}/SKILL.md`),
      ...ROOT_SECTIONS.map((name) => toPosix(normalize(`root/${name}`))),
      ...SPECIALIST_SECTIONS.map((name) => toPosix(normalize(`specialist/${name}`))),
      ...CONDITIONAL_SECTIONS.map(({ file }) => `specialist/${file}`),
      "shared/materiality.md",
      ...Object.entries(ROLE_SECTIONS).flatMap(([role, names]) =>
        names.map((name) => `roles/${role}/${name}`),
      ),
    ]
    for (const [id, entry] of Object.entries(coverage)) {
      // A requirement that code or documentation carries has no section to reach agents; the
      // runtime tests check that file.
      if ("carriedBy" in entry) continue
      const { section, phrase } = entry
      expect({ id, assembled: assembled.includes(section) }).toEqual({ id, assembled: true })
      expect({ id, holds: read(CLAUDE, section).includes(phrase) }).toEqual({ id, holds: true })
      const conditional = CONDITIONAL_SECTIONS.find(({ file }) => section === `specialist/${file}`)
      if (section.startsWith("skills/")) {
        const skill = generated.find((file) =>
          file.path.endsWith(section.replace("skills/", "guidance/claude-5.5/")),
        )
        expect({ id, skill: skill?.content.includes(phrase) }).toEqual({ id, skill: true })
        continue
      }
      // The materiality definition is embedded where the inspection rules are, so it reaches the
      // roles that get them.
      const inspection = CONDITIONAL_SECTIONS.find(({ file }) => file === INSPECTION_SECTION)
      const reached = section.startsWith("root/")
        ? ["holyagent"]
        : section === "shared/materiality.md"
          ? ROUTES.filter((route) => inspection?.applies(route)).map((route) => route.agent)
          : section.startsWith("shared/")
            ? ["holyagent", ...ROUTES.map((route) => route.agent)]
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
    // The shared files sit in a folder of their own and are listed by their path from the folder.
    const own = (name: string) => !name.startsWith("../")
    assembled("root", ROOT_SECTIONS.filter(own))
    assembled("specialist", [
      ...SPECIALIST_SECTIONS.filter(own),
      ...CONDITIONAL_SECTIONS.map(({ file }) => file),
    ])
    for (const name of [...ROOT_SECTIONS, ...SPECIALIST_SECTIONS].filter((entry) => !own(entry)))
      expect({
        name,
        listed: readdirSync(join(ROOT, CLAUDE, "shared")).includes(name.replace("../shared/", "")),
      }).toEqual({ name, listed: true })
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
    // A role with Bash searches with `holyagent rg` and `holyagent fd`, so it has no Grep or Glob.
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
      "no polling, steering, scheduled check-ins or wait loops",
      "a wake changing nothing gets one short line",
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
      "Before the first commit, check `git branch --show-current`",
      "first create the conventional branch",
      "commit and push only there",
      "If refused, stop, report the blocker",
      "a branch the user named as the work branch is not one",
      "ask via AskUserQuestion to push to the assigned branch; it is never a default, so park the push when the user is away",
      "a decision the rules reserve for the user's answer (pushing to the platform-assigned branch, approvals) is parked, never defaulted",
      "never work around a refused push",
      "`exp/<experiment>/<type>/<change>` for work with no published version",
      "`release/<version>/<type>/<change>` when the repository has tags or releases",
      "each commit on a branch is atomic",
      "a Conventional Commit",
      "PRs merge by squash by default, with the PR title as the Conventional summary",
      "Branch protection, merge settings and conventions decide first (Precedence)",
      "After a lower PR squash-merges, retarget the next PR to the base",
    ])
      expect({ part, found: text.includes(part) }).toEqual({ part, found: true })
    for (const part of [
      "use it as the work branch",
      "may have pushed",
      "cloud sessions may push only",
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

  test("the root reads the base, the PR target and every non-work branch from the repository's conventions, hardcoding none", () => {
    const text = (agent("holyagent")?.content ?? "").replace(/\s+/g, " ")
    for (const part of [
      "The base is the branch the conventions or the user name as the work's target, else the default branch",
      "supply only the remote and the default branch, so the base (see the identity rules) comes from the conventions or the user first",
      "settle its PR's target (the open stack's top, or the base, which the conventions may point at an integration branch)",
      "check it against the conventions' rules on which branches may open PRs into which",
      "if the check bars the stack's top, start from the base",
      "which also decides any other branch the plan needs (an integration branch, where it is cut from and who cuts it)",
      "cut from the start the convention gives, carrying only that start, and pushed as part of this plan without asking (Precedence)",
      "Pushing commits onto an existing base needs the user's approval",
      "Creating and pushing a convention-named base absent remotely is not such a push; pushing commits to an existing base is",
      "`git diff <target>...HEAD` (the PR's actual target: its predecessor in the stack or the base)",
    ])
      expect({ part, found: text.includes(part) }).toEqual({ part, found: true })
    expect(text).not.toContain("git diff <base>...HEAD")
    // One definition of the base, in the identity rules that the session-start core carries.
    expect(text.split("as the work's target, else the default branch").length - 1).toBe(1)
    expect(read(CLAUDE, "roles/reviewer-code/range.md")).not.toContain("<base>")
    expect(read(CLAUDE, "roles/reviewer-code/builtin-review.md")).not.toContain("<base>")
    expect(text).not.toMatch(/release\/\d|integration branch cut from main/)
  })

  test("no specialist preloads a skill: what a role always needs is fixed text in it", () => {
    for (const route of ROUTES)
      expect(frontmatter(agent(route.agent)?.content ?? "")).not.toContain("skills:")
  })

  test("the mergeability bar and the inspection rules are fixed text in exactly the roles that need them, once", () => {
    for (const { file, applies } of CONDITIONAL_SECTIONS) {
      const section = Effect.runSync(
        embedMateriality(read(`${CLAUDE}/specialist`, file), read(MATERIALITY_FILE), file),
      ).trim()
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
    const inspection = Effect.runSync(
      embedMateriality(
        read(`${CLAUDE}/specialist`, INSPECTION_SECTION),
        read(MATERIALITY_FILE),
        INSPECTION_SECTION,
      ),
    ).trim()
    const inspecting = ROUTES.filter((route) =>
      agent(route.agent)?.content.includes(inspection),
    ).map((route) => route.agent)
    expect(inspecting.toSorted()).toEqual(["reviewer-visual", "worker-visual"])
  })

  test("each visual role says once that a missing target record blocks the inspection and that it starts no target", () => {
    for (const name of ["worker-visual", "reviewer-visual"]) {
      const text = agent(name)?.content ?? ""
      expect({ name, copies: text.match(/no record (?:is )?named/g)?.length }).toEqual({
        name,
        copies: 1,
      })
      expect({ name, copies: text.match(/start none of your own/gi)?.length }).toEqual({
        name,
        copies: 1,
      })
    }
  })

  test("the visual roles send the design guidance to the platform skill their criteria name, and no other agent does", () => {
    for (const route of ROUTES) {
      const text = agent(route.agent)?.content ?? ""
      const visual = ["worker-visual", "reviewer-visual"].includes(route.agent)
      expect({ agent: route.agent, section: text.includes("## Design guidance") }).toEqual({
        agent: route.agent,
        section: visual,
      })
      if (visual) {
        const section = read(`${CLAUDE}/roles/${route.agent}`, DESIGN_SECTION).trim()
        expect(text).toContain(section)
        expect(section).toContain("the platform design skill whose file your criteria name")
        expect(section).toContain("checklist")
        expect(section).not.toMatch(/frontend.design/i)
      }
    }
  })

  test("the platform design skills carry the design directives that the visual roles no longer embed", () => {
    const core = [
      "confirm them with the user when one can answer",
      "Let the subject supply the look",
      "accept visual risk when it earns its place",
      "a small named palette (four to six colors, each with a value and a role)",
      "rough ASCII wireframes",
      "start coding only from the revised plan",
      "Strip ornament that does nothing for the brief",
      "Numbers mark a real sequence",
      "An eyebrow over every heading, all-caps labels and labels that say nothing",
      "invent specific copy from the subject",
      '("Send invoice", not "Submit")',
      'the Duplicate button leads to a "Duplicated" confirmation',
      "each action carries one name from first label to confirmation",
      "An error states what happened and how to recover",
      "an empty state invites the first action",
      "keep the tone conversational and in step with the brand and its readers",
      "under reduced motion, movement becomes a fade or nothing",
      "Check your own work as it takes shape",
    ]
    const web = [
      "Fill the hero with what is most distinctive about the subject",
      "One family may carry both display and body when it suits the brief",
      "The Elements of Typographic Style",
      "A serif body face tolerates a somewhat longer measure",
      "never override each other's padding or margin",
      "entrance animations on every section",
      "a card-kit page",
      "picking out one word or phrase of a headline",
      "default-kit trimmings that show up regardless of subject",
      "Feedback motion earns its place by making the change visible",
      "The brief's own words win over this list",
      "a warm paper-cream ground",
    ]
    for (const name of ["web-design", "mobile-design", "desktop-design", "tui-design"]) {
      const text = read(`packages/integrations/claude/dist/guidance/claude-5.5/${name}/SKILL.md`)
      for (const phrase of core)
        expect({ name, phrase, has: text.includes(phrase) }).toEqual({ name, phrase, has: true })
    }
    const skill = read("packages/integrations/claude/dist/guidance/claude-5.5/web-design/SKILL.md")
    for (const phrase of web)
      expect({ phrase, has: skill.includes(phrase) }).toEqual({ phrase, has: true })
    for (const name of ["mobile-design", "desktop-design", "tui-design"]) {
      const text = read(`packages/integrations/claude/dist/guidance/claude-5.5/${name}/SKILL.md`)
      for (const phrase of web)
        expect({ name, phrase, has: text.includes(phrase) }).toEqual({ name, phrase, has: false })
    }
    for (const word of [/\beyebrow/i, /Numbers mark a real sequence/, /fade or nothing/])
      expect({
        word: String(word),
        copies: skill.split("\n").filter((l) => word.test(l)).length,
      }).toEqual({
        word: String(word),
        copies: 1,
      })
  })

  test("specialists read routed guidance when relevant without repeating it for the root", () => {
    const directive = "Read the relevant guidance when its situation applies."
    for (const route of ROUTES) {
      const prompt = agent(route.agent)?.content ?? ""
      expect(prompt.includes(directive)).toBe(
        OWNED_GUIDANCE.some((entry) => entry.roles.includes(route.roleTask)),
      )
    }
    expect(agent("holyagent")?.content).not.toContain(directive)
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

  test("the dev-server skill is generated, opens with the situation, and covers the target record, every platform, blocked targets and owner-only stop", () => {
    const skill = generated.find((file) =>
      file.path.endsWith("guidance/claude-5.5/dev-server/SKILL.md"),
    )?.content
    expect(skill).toBeDefined()
    expect(field(skill ?? "", "name")).toBe("dev-server")
    expect(field(skill ?? "", "description")).toStartWith("Use when ")
    for (const part of [
      "Worker.operations",
      "## Detect",
      "## Target record",
      "the detected stack with its signal",
      "the supported variants, each with its set and reset commands and current value",
      "the owner and process group, the stop command, and what stopping cleans up",
      "unique to this work",
      "start none of its own",
      "Reviewer.visual has no shell",
      "Only the owner stops a target",
      "- Web:",
      "- Terminal UI:",
      "- Linux desktop:",
      "- Android:",
      "- iOS:",
      "- macOS and Windows desktop:",
      "interchangeable example",
      "[verify]",
      "reports it blocked with the reason and what would unblock it",
      "a web build of a native app is not the native render",
    ])
      expect({ part, found: skill?.includes(part) }).toEqual({ part, found: true })
    expect(read("packages/integrations/claude/dist/guidance/claude-5.5/dev-server/SKILL.md")).toBe(
      skill ?? "",
    )
    const roleParts: Record<string, ReadonlyArray<string>> = {
      "worker-operations": [
        "the target record",
        "report it blocked with the reason and what would unblock it",
      ],
      "worker-visual": [
        "the target record in your criteria, never from a bare URL",
        "with no record named or the target down",
      ],
      "reviewer-visual": [
        "the target record in your criteria",
        "with no record named or the target down",
      ],
    }
    for (const [name, parts] of Object.entries(roleParts))
      for (const part of parts)
        expect({ name, part, found: agent(name)?.content.includes(part) }).toEqual({
          name,
          part,
          found: true,
        })
  })

  test("the evidence-judging skill opens with the situation, gives each rule its reason, and the root points to it", () => {
    const skill = generated.find((file) =>
      file.path.endsWith("guidance/claude-5.5/evidence-judging/SKILL.md"),
    )?.content
    expect(skill).toBeDefined()
    expect(field(skill ?? "", "name")).toBe("evidence-judging")
    expect(field(skill ?? "", "description")).toStartWith(
      "Use when a specialist report carries a verdict the root must accept or reject: a blocking review finding, a research claim with conflicting sources or numbers, prose written for people, or a material design choice.",
    )
    for (const part of [
      "never from raw logs or whole files",
      "starts a repair only with evidence:",
      "a file:line trace (for a vulnerability, source to sink) from one without",
      "a Reviewer.visual observation (viewport, interaction, visible result) or a finding of your own final pass that cites the capture path and what it shows",
      "back to the same reviewer for that evidence",
      "have a specialist re-derive any number before it is published or decided on",
      "keep inference labeled as inference",
      "Reviewer.artifact reviews it and you judge the excerpts it flags",
      "your brief asks an explorer for two or three short options with their trade-offs",
      "Routine choices stay with the writer",
      "a reproduction, the cause it shows, and a fix that makes the reproduction pass",
    ])
      expect({ part, found: skill?.includes(part) }).toEqual({ part, found: true })
    expect(
      read("packages/integrations/claude/dist/guidance/claude-5.5/evidence-judging/SKILL.md"),
    ).toBe(skill ?? "")
    const root = agent("holyagent")?.content ?? ""
    expect(root).toContain("a specialist verdict needs acceptance or rejection")
  })

  test("the root loads visual-judging before the first visual dispatch and points to it for the repair-round rules", () => {
    const root = agent("holyagent")?.content ?? ""
    for (const part of [
      "before any visual-task writer, source edit or visual specialist dispatch",
      "loaded before the first visual dispatch",
      "starts a repair and a re-review once it carries the evidence `evidence-judging` requires",
      "a web app or served static build, a terminal UI, a desktop or mobile app",
    ])
      expect({ part, found: root.includes(part) }).toEqual({ part, found: true })
    const skill = generated.find((file) =>
      file.path.endsWith("guidance/claude-5.5/visual-judging/SKILL.md"),
    )
    expect(field(skill?.content ?? "", "description")).toStartWith(
      "Use before the first Worker.visual or Reviewer.visual dispatch",
    )
    for (const part of [
      "Your own final pass, after Worker.visual and Reviewer.visual, decides acceptance",
      "inform the decision and do not make it",
      "`web-design`, `mobile-design`, `desktop-design` or `tui-design`",
      "`guidance/<family>/<name>/SKILL.md` under the plugin folder",
      "repeat your final pass on the captures that changed",
      "a web page that Reviewer.visual inspected live and for which Worker.visual saved no captures, have Worker.visual or Worker.operations save the final captures at the listed sizes and variants, which Reviewer.visual then lists",
    ])
      expect({ part, found: skill?.content.includes(part) }).toEqual({ part, found: true })
    // The platform skill reaches both specialists by a literal path: the dispatch rules (the root
    // body and the session-start core alike) say a brief names a plugin file by its absolute path
    // and where the plugin folder is read from; the skill points to them and does not repeat why.
    for (const text of [root, ROOT_CORE])
      for (const part of ["A brief that names a plugin file", "the directory above `scripts/`"])
        expect({ part, found: text.includes(part) }).toEqual({ part, found: true })
    expect(skill?.content).not.toContain("the directory above `scripts/`")
    for (const name of ["worker-visual", "reviewer-visual"]) {
      const text = agent(name)?.content ?? ""
      expect({ name, found: text.includes("read that file") }).toEqual({ name, found: true })
    }
    expect(agent("reviewer-visual")?.content).toContain(
      "List the paths of the final captures you judged from",
    )
    expect(agent("reviewer-visual")?.content).toContain(
      "For a web page you inspect live, list the paths of the final captures that Worker.visual or Worker.operations saved",
    )
    const pointers = agent("holyagent")?.content ?? ""
    for (const name of ["web-design", "mobile-design", "desktop-design", "tui-design"])
      expect({ name, found: pointers.includes(`/${name}/SKILL.md`) }).toEqual({ name, found: true })
    const devServer = generated.find((file) =>
      file.path.endsWith("guidance/claude-5.5/dev-server/SKILL.md"),
    )
    expect(field(devServer?.content ?? "", "description")).toContain(
      "a terminal UI, a desktop app, or an Android or iOS app",
    )
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
    const requirements = REQUIREMENTS
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
        "the `requirements/` tree",
        "the family's `guide.md`",
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
    const pointers = agent("holyagent")?.content ?? ""
    for (const [name, parts] of Object.entries(extracted)) {
      const skill = generated.find((file) =>
        file.path.endsWith(`guidance/claude-5.5/${name}/SKILL.md`),
      )?.content
      expect({ name, generated: skill !== undefined }).toEqual({ name, generated: true })
      expect(field(skill ?? "", "name")).toBe(name)
      expect(field(skill ?? "", "description")).toStartWith("Use ")
      expect(pointers).toContain(`/${name}/SKILL.md`)
      expect(root).toContain(`/${name}/SKILL.md`)
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
    expect(
      read("packages/integrations/claude/dist/guidance/claude-5.5/visual-judging/SKILL.md"),
    ).toBe(
      generated.find((file) => file.path.endsWith("guidance/claude-5.5/visual-judging/SKILL.md"))
        ?.content ?? "",
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
    expect(dispatch).toContain("only for conflicting new requirements or information")
    expect(dispatch).toContain(
      "let it finish if finishing and repairing costs less than stopping and relaunching",
    )
    expect(dispatch).toContain("Close the stopped Assignment with `--outcome stopped`")
    expect(dispatch).not.toMatch(/no polling, steering or stopping/)
    expect(REQUIREMENTS).not.toContain("steering or stopping")
  })

  test("the guide gaps are each stated once, in the file that owns them, and in exactly the agents and skills that need them", () => {
    const once = (text: string, phrase: string) => text.split(phrase).length - 1
    const specialists = ROUTES.map((route) => `agents/${route.agent}.md`)
    // The generated agent and skill files that hold the phrase, with how often each holds it.
    const holders = (phrase: string) =>
      generated
        .filter((file) => file.path.includes("/agents/") || file.path.includes("/skills/"))
        .map((file) => ({
          file: /(?:agents|skills)\/.*$/.exec(file.path)?.[0] ?? file.path,
          copies: once(file.content, phrase),
        }))
        .filter(({ copies }) => copies > 0)
        .toSorted((a, b) => (a.file < b.file ? -1 : 1))
    // Each gap: the source file that owns the phrase and every generated file that may hold it.
    // The root states its own mistaken-request rule in its own words under the same phrase.
    const gaps: ReadonlyArray<readonly [string, string, string, ReadonlyArray<string>]> = [
      [
        "G1",
        `${CLAUDE}/root/task-list.md`,
        "End your turn only when done or nothing can move until an answer or completion notice",
        ["agents/holyagent.md"],
      ],
      [
        "G2",
        `${CLAUDE}/root/user-messages.md`,
        "asks for ideas, options or a plan",
        ["agents/holyagent.md"],
      ],
      [
        "G3",
        `${CLAUDE}/specialist/writing-bar.md`,
        "filler sections, redundant summaries or boilerplate",
        ["agents/reviewer-artifact.md", "agents/worker-implementation.md"],
      ],
      [
        "G4",
        `${CLAUDE}/specialist/scope.md`,
        "seems mistaken or a better approach exists",
        ["agents/holyagent.md", ...specialists],
      ],
    ]
    for (const [gap, path, phrase, files] of gaps) {
      expect({ gap, count: once(read(path), phrase) }).toEqual({ gap, count: 1 })
      expect({ gap, holders: holders(phrase) }).toEqual({
        gap,
        holders: files.toSorted().map((file) => ({ file, copies: 1 })),
      })
    }
  })

  test("the root states its own mistaken-request and no-filler rules once, each mapped to a requirement", () => {
    const root = agent("holyagent")?.content ?? ""
    const once = (text: string, phrase: string) => text.split(phrase).length - 1
    expect(once(root, "in your acknowledgment of that message and continue as asked")).toBe(1)
    expect(once(root, "free of filler, redundant summaries and boilerplate")).toBe(1)
    const requirements = REQUIREMENTS
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
      file.path.endsWith("guidance/claude-5.5/instruction-writing/SKILL.md"),
    )
    expect(skill?.content).toContain(rule)
    expect(skill?.content).toContain(
      "The repository's own convention for context files comes first",
    )
    expect(skill?.content).toContain("only when the user asks")
    const requirements = REQUIREMENTS
    expect(requirements).toContain("arXiv 2602.11988")
    expect(requirements).toContain("Inference: that paths in context files go stale")
  })

  test("the mergeability table names exactly the dimensions the runtime stores", () => {
    const table = read(`${CLAUDE}/specialist`, "merge-ready.md")
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Dimension"))
      .map((line) => line.split("|")[1]?.trim() ?? "")
      .filter((name) => /^[a-z][a-z-]*$/.test(name))
    expect(table).toEqual([...Dimension.literals])
  })

  test("the hooks, signing and history rewrite rules have one source file that the root prompt embeds once, after its version-control rules", () => {
    const rules = read(CLAUDE, HISTORY_RULES_FILE.replace("../", "")).trim()
    expect(ROOT_SECTIONS.indexOf(HISTORY_RULES_FILE)).toBe(
      ROOT_SECTIONS.indexOf("version-control.md") + 1,
    )
    const root = agent("holyagent")?.content ?? ""
    expect(root.split(rules).length - 1).toBe(1)
    // They continue the bullet list of the version-control rules, with no blank line between.
    expect(root.slice(0, root.indexOf(rules))).toMatch(/\n- [^\n]*\n$/)
    for (const route of ROUTES)
      expect({ agent: route.agent, holds: agent(route.agent)?.content.includes(rules) }).toEqual({
        agent: route.agent,
        holds: false,
      })
    // The root's own version-control file leaves them to the shared file.
    for (const line of rules.split("\n"))
      expect(read(`${CLAUDE}/root`, "version-control.md")).not.toContain(line.slice(2))
  })

  test("the specialist count in the manifests and the docs is the route table's", () => {
    const words = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
      "ten",
      "eleven",
      "twelve",
      "thirteen",
      "fourteen",
      "fifteen",
      "sixteen",
      "seventeen",
      "eighteen",
      "nineteen",
      "twenty",
    ]
    const word = words[ROUTES.length - 1]
    expect(DESCRIPTION).toContain(` ${word} specialists `)
    for (const path of [
      "packages/integrations/claude/dist/.claude-plugin/plugin.json",
      MARKETPLACE_PATH,
    ])
      expect(read(path)).toContain(DESCRIPTION)
    // Every count of the roster that a page states, in words or digits, is the route table's.
    const count = new RegExp(
      `\\b(${[...words, "\\d+"].join("|")}) (?:specialists|route agents|agent names)\\b`,
      "gi",
    )
    const pages = [
      "README.md",
      "docs/README.md",
      "docs/decisions.md",
      "docs/development.md",
      "docs/hooks.md",
      "docs/pi/claude-parity.md",
    ]
    for (const path of pages) {
      const wrong = [...read(path).matchAll(count)]
        .map((match) => match[1]?.toLowerCase())
        .filter((found) => found !== word && found !== String(ROUTES.length))
      expect({ path, wrong }).toEqual({ path, wrong: [] })
    }
  })

  test("agent files sit where the plugin expects them", () => {
    // The folder is joined with the platform's separator; the plugin and git expect it with `/`.
    expect(toPosix(AGENTS)).toBe("packages/integrations/claude/dist/agents")
    expect(toPosix(win32.join("packages", "integrations", "claude", "dist", "agents"), "\\")).toBe(
      "packages/integrations/claude/dist/agents",
    )
  })
})

describe("claude plugin validate", () => {
  // The pinned Claude Code of the `@anthropic-ai/claude-code` devDependency (the version in
  // bun.lock, which the CI validation step runs too), started through Bun so a `claude` on PATH of
  // another version never decides. A missing install fails the test: nothing is skipped.
  // The external claude CLI starts a fresh process per check; on a loaded machine (the parallel
  // verify gates, other workers) that can outlast the 5 s default, so the checks get a longer one.
  const VALIDATE_TIMEOUT = 30_000
  const check = async (directory: string) => {
    const result = await $`bun run claude plugin validate --strict ${directory}`
      .cwd(ROOT)
      .quiet()
      .nothrow()
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

  test(
    "the built plugin passes strict validation with the pinned Claude Code",
    async () => {
      const { code, text } = await check(PLUGIN)
      expect(code).toBe(0)
      clean(text)
    },
    VALIDATE_TIMEOUT,
  )

  test(
    "the repository root marketplace passes strict validation with the pinned Claude Code",
    async () => {
      const { code, text } = await check(ROOT)
      expect(code).toBe(0)
      clean(text)
    },
    VALIDATE_TIMEOUT,
  )
})

test("Claude role routers use private guidance and preserve normal host skill discovery", () => {
  const root = agent("holyagent")?.content ?? ""
  for (const route of ROUTES) {
    const prompt = agent(route.agent)?.content ?? ""
    for (const entry of OWNED_GUIDANCE)
      expect(prompt.includes(`/guidance/claude-5.5/${entry.name}/SKILL.md`)).toBe(
        entry.roles.includes(route.roleTask),
      )
    expect(prompt).not.toContain("# Library documentation lookup")
  }
  expect(root).toContain("/guidance/claude-5.5/visual-judging/SKILL.md")
  expect(root).not.toContain("# Library documentation lookup")
  expect(generated.some((file) => file.path.startsWith(`${DIST_DIRECTORY}/skills/`))).toBe(false)
  const plugin =
    generated.find((file) => file.path.endsWith(".claude-plugin/plugin.json"))?.content ?? "{}"
  expect(JSON.parse(plugin)).not.toHaveProperty("skills")
})
