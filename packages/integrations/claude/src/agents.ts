import { Effect } from "effect"

import { type Route, ROUTES } from "../../../runtime/src/domain/route.ts"
import {
  PRECEDENCE_FILE,
  ROOT_CORE_FILES,
} from "../../../runtime/src/instructions/claude-5.5/root-core.ts"
import type { Family } from "../../../runtime/src/instructions/families.ts"
import {
  embedMateriality,
  GUIDANCE_MARKER,
  guidanceRouter,
  MATERIALITY_PATH,
  stripCitations,
} from "../../../runtime/src/instructions/skills.ts"
import {
  DIST_DIRECTORY,
  type GeneratedFile,
  generatedNote,
  INSTRUCTIONS_DIRECTORY,
  readSource,
} from "./files.ts"

/** The plugin's name, which namespaces its agents and skills. */
export const PLUGIN_NAME = "holyagent"

const ROOT_DESCRIPTION =
  "Use as the main-thread agent: it plans the work as an Intent with Assignments, dispatches the holyagent specialists through the CLI, judges their reports, accepts work on evidence and owns version control."

/**
 * The built-in tools of Claude Code that an agent definition can grant or deny: the ones a
 * background subagent keeps (per the sub-agents documentation) plus the dispatch, ask and task
 * tools the root uses. Each agent's `disallowedTools` is this list minus what its role grants, so a
 * grant and its denial cannot drift. MCP tools are not in it: an agent without a `tools` line
 * inherits every MCP tool of the session, custom servers included.
 */
export const BUILTIN_TOOLS: ReadonlyArray<string> = [
  "Agent",
  "Artifact",
  "AskUserQuestion",
  "Bash",
  "Edit",
  "EnterWorktree",
  "ExitWorktree",
  "Glob",
  "Grep",
  "LSP",
  "Monitor",
  "NotebookEdit",
  "PowerShell",
  "Read",
  "SendMessage",
  "Skill",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Workflow",
  "Write",
]

/**
 * Claude Code's own web tools, denied to every agent: web work goes through the Exa connector,
 * whose tools every agent inherits as MCP tools.
 */
export const NATIVE_WEB_TOOLS: ReadonlyArray<string> = ["WebSearch", "WebFetch"]

/**
 * The built-in tool every agent keeps: with tool search on, Claude Code loads deferred MCP tools
 * through it, so denying it would cut agents off from the MCP servers they inherit.
 */
const MCP_LOADER = "ToolSearch"

const WRITING = ["Write", "Edit", "Bash"]

/**
 * The built-in tools of the root: dispatch, ask, tasks (TaskStop stops a running agent or workflow
 * when new information conflicts with it) and reading; it writes no files. It has no Grep or Glob,
 * since a role with a shell searches with `holyagent rg` and `holyagent fd` (the ripgrep and fd
 * installed on the machine) and falls back to the system grep or find through Bash.
 */
const ROOT_BUILTINS = [
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
]

/**
 * The `disallowedTools` value of an agent that is granted `granted`: every built-in tool left over,
 * which always includes the native web tools.
 */
const denylist = (granted: ReadonlyArray<string>): string =>
  BUILTIN_TOOLS.filter(
    (tool) => NATIVE_WEB_TOOLS.includes(tool) || (tool !== MCP_LOADER && !granted.includes(tool)),
  ).join(", ")

/** Roles that write or review code and take the mergeability bar with them. */
const MERGE_READY: ReadonlySet<string> = new Set([
  "Worker.mechanical",
  "Worker.implementation",
  "Worker.integration",
  "Worker.debugging",
  "Worker.visual",
  "Reviewer.code",
  "Reviewer.testing",
])

/**
 * Roles that get the code quality rules: the writers and reviewers of {@link MERGE_READY}, and
 * Reviewer.artifact, which reports duplicated instructions and artifacts.
 */
const CODE_QUALITY: ReadonlySet<string> = new Set([...MERGE_READY, "Reviewer.artifact"])

/** Roles that get the writing bar, for the instruction text they write or judge. */
const WRITING_BAR: ReadonlySet<string> = new Set(["Worker.implementation", "Reviewer.artifact"])

/**
 * The bullets on hooks, signing and history rewrites, a file of `shared/` as a path relative to
 * `root/`. The root prompt embeds it after its version-control rules and the version-control
 * reminder hook adds the same sentences, so the rules have one source.
 */
export const HISTORY_RULES_FILE = "../shared/history-rules.md"

/**
 * The sections of the root prompt, as files of `root/` in prompt order. The core opens it; the
 * order is fixed here so that a file's name never decides where its text lands.
 */
export const ROOT_SECTIONS: ReadonlyArray<string> = [
  ...ROOT_CORE_FILES,
  "user-messages.md",
  "routing.md",
  "context.md",
  "workflows.md",
  "search.md",
  "assignments.md",
  "instruction-guidelines.md",
  "version-control.md",
  HISTORY_RULES_FILE,
  "stack-plan.md",
  "pr-text.md",
  "asking.md",
  "skills.md",
]

/**
 * The sections of the conduct every specialist shares, as files of `specialist/` in prompt order;
 * the order of precedence is the one file shared with the root core.
 */
export const SPECIALIST_SECTIONS: ReadonlyArray<string> = [
  "conduct.md",
  PRECEDENCE_FILE,
  "scope.md",
  "state-changes.md",
  "working.md",
  "report.md",
]

/**
 * The writing bar, a file of `specialist/` that only the roles of {@link WRITING_BAR} get, after
 * the conduct.
 */
export const WRITING_BAR_SECTION = "writing-bar.md"

/** The mergeability bar, a file of `specialist/` that the roles of {@link MERGE_READY} get. */
export const MERGE_READY_SECTION = "merge-ready.md"

/**
 * The code quality rules (no duplication, performance, readability), a file of `specialist/` that
 * the roles of {@link CODE_QUALITY} get, after the mergeability bar.
 */
export const CODE_QUALITY_SECTION = "code-quality.md"

/**
 * The one source of the materiality definition, relative to the repository root: the Claude
 * family's copy of the runtime's {@link MATERIALITY_PATH}.
 */
export const MATERIALITY_FILE = `${INSTRUCTIONS_DIRECTORY}/${MATERIALITY_PATH}`

/** The interface inspection rules, a file of `specialist/` for the roles that inspect renders. */
export const INSPECTION_SECTION = "interface-inspection.md"

/**
 * The files of `specialist/` that only some roles need, in prompt order after the conduct, with the
 * roles that get each. Their text is fixed in those agents, so none of it is loaded as a skill.
 */
export const CONDITIONAL_SECTIONS: ReadonlyArray<{
  readonly file: string
  readonly applies: (route: Route) => boolean
}> = [
  { file: WRITING_BAR_SECTION, applies: (route) => WRITING_BAR.has(route.roleTask) },
  { file: MERGE_READY_SECTION, applies: (route) => MERGE_READY.has(route.roleTask) },
  { file: CODE_QUALITY_SECTION, applies: (route) => CODE_QUALITY.has(route.roleTask) },
  {
    file: INSPECTION_SECTION,
    applies: (route) => route.capabilities.includes("VisualInspection"),
  },
]

/**
 * The role section of the visual roles that sends them to the platform design skill named in their
 * criteria, which holds the design guidance.
 */
export const DESIGN_SECTION = "design.md"

/**
 * The sections of each role, as files of `roles/<agent>/` in prompt order. The first is the
 * purpose, whose first sentence describes the agent to the root.
 */
export const ROLE_SECTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "explorer-lookup": ["purpose.md", "method.md"],
  "explorer-map": ["purpose.md", "method.md"],
  "explorer-trace": ["purpose.md", "method.md"],
  "librarian-lookup": ["purpose.md", "method.md"],
  "librarian-research": ["purpose.md", "method.md"],
  "reviewer-artifact": ["purpose.md", "method.md", "instruction-text.md"],
  "reviewer-audit": ["purpose.md", "method.md"],
  "reviewer-code": ["purpose.md", "builtin-review.md", "range.md"],
  "reviewer-security": ["purpose.md", "builtin-review.md", "trust-boundaries.md", "findings.md"],
  "reviewer-testing": ["purpose.md", "method.md"],
  "reviewer-visual": ["purpose.md", "captures.md", DESIGN_SECTION],
  "worker-debugging": ["purpose.md", "phases.md", "escalation.md"],
  "worker-implementation": ["purpose.md", "method.md", "refactor.md", "instruction-text.md"],
  "worker-integration": ["purpose.md", "method.md"],
  "worker-mechanical": ["purpose.md", "method.md", "refactor.md"],
  "worker-operations": ["purpose.md", "method.md", "dev-server.md"],
  "worker-validation": ["purpose.md", "method.md", "baseline.md"],
  "worker-visual": ["purpose.md", "method.md", DESIGN_SECTION],
}

const readSections = async (
  directory: string,
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> =>
  (await Promise.all(names.map((name) => readSource(`${directory}/${name}`)))).map((text) =>
    stripCitations(text).trim(),
  )

/**
 * Roles that start with a built-in review of Claude Code, `/code-review` and `/security-review`.
 * Both are prompt commands that only the Skill tool can run, and neither needs more: the shell
 * reads of `/security-review` run through the host's own shell, whatever tools the agent lists.
 */
const BUILTIN_REVIEW: ReadonlySet<string> = new Set(["Reviewer.code", "Reviewer.security"])

/**
 * The built-in tools of a specialist: reading for all, then what its capabilities call for. The
 * Search capability grants none, since the Exa connector's tools come as MCP tools. Reviewer.code
 * keeps Bash without a Shell capability, since it reads diffs with git. The roles of
 * {@link BUILTIN_REVIEW} get Skill, and a role with Bash gets Monitor for its long commands. A role
 * with Bash searches with `holyagent rg` and `holyagent fd`, or the system grep or find when those
 * programs are missing, and so gets neither Grep nor Glob; a role without it keeps both.
 */
const builtinsOf = (route: Route): ReadonlyArray<string> => {
  const shell = route.capabilities.includes("Shell") || route.roleTask === "Reviewer.code"
  const granted = [
    "Read",
    ...(route.capabilities.includes("Write") ? WRITING : []),
    ...(shell ? ["Bash"] : []),
    ...(BUILTIN_REVIEW.has(route.roleTask) ? ["Skill"] : []),
  ]
  const unique = [...new Set(granted)]
  return unique.includes("Bash") ? [...unique, "Monitor"] : [...unique, "Grep", "Glob"]
}

const firstSentence = (text: string): string => {
  const paragraph = text.trim().split("\n")[0] ?? ""
  return /^.*?\.(?=\s|$)/.exec(paragraph)?.[0] ?? paragraph
}

/**
 * What the root reads to pick the specialist: its purpose first, then how it runs. `runtime` is the
 * host's trailing detail, such as the model and effort where the agent file fixes them.
 */
const describe = (route: Route, role: string, runtime: string): string =>
  `Use for ${route.agent}: ${firstSentence(role)} ${route.mutability === "ReadOnly" ? "Read-only" : "Writes inside its ownership paths"}; independence ${route.independence}${runtime}.`

/**
 * An agent file's head: the generated note for `note`, then `lines`, between the frontmatter
 * fences.
 */
export const frontmatter = (note: string, lines: ReadonlyArray<string>): string =>
  ["---", `# ${note}`, ...lines, "---"].join("\n")

/** What the specialists of the roles share, read once for all of them. */
interface Shared {
  readonly conduct: ReadonlyArray<string>
  /** The text of each of {@link CONDITIONAL_SECTIONS}, by file. */
  readonly conditional: Readonly<Record<string, string>>
}

/**
 * What a host adds to the specialist prompt the hosts share: where its instructions are and how its
 * agent files look.
 */
export interface SpecialistHost {
  /** The instruction sources of the host's model family, relative to the repository root. */
  readonly instructions: string
  /** Family and package root used to route private guidance. */
  readonly guidanceFamily: Family
  readonly guidanceRoot: string
  /** The path of a route's agent file, relative to the repository root. */
  readonly path: (route: Route) => string
  /** The head of a route's agent file, from the folder `source` of its role and its description. */
  readonly head: (route: Route, source: string, description: string) => string
  /** What the description says after the independence, for example the model; empty for none. */
  readonly runtime: (route: Route) => string
  /**
   * A section the host adds after the prompt's own, for example a note on the form of the machine;
   * none by default.
   */
  readonly appendix?: (route: Route) => string
}

const specialist = async (
  host: SpecialistHost,
  route: Route,
  shared: Shared,
): Promise<GeneratedFile> => {
  const source = `${host.instructions}/roles/${route.agent}`
  const sections = ROLE_SECTIONS[route.agent] ?? []
  const [role = "", ...rest] = await readSections(source, sections)
  const head = host.head(route, source, describe(route, role, host.runtime(route)))
  const body = [
    `You are the ${PLUGIN_NAME} ${route.agent} specialist. Independence: ${route.independence}.`,
    role,
    ...rest,
    ...shared.conduct,
    ...CONDITIONAL_SECTIONS.filter(({ applies }) => applies(route)).map(
      ({ file }) => shared.conditional[file] ?? "",
    ),
    ...[guidanceRouter(route.roleTask, host.guidanceFamily, host.guidanceRoot)].filter(Boolean),
    ...(host.appendix === undefined ? [] : [host.appendix(route)]),
  ].join("\n\n")
  return { path: host.path(route), content: `${head}\n\n${body}\n` }
}

/**
 * One agent file for each route, built from the host's instructions: the role sections, the shared
 * conduct and the conditional sections the role needs, with the maintainers' notes stripped. Every
 * host's specialist prompt is made here, so a change to it is made once.
 */
export const specialistFiles = async (
  host: SpecialistHost,
): Promise<ReadonlyArray<GeneratedFile>> => {
  const directory = `${host.instructions}/specialist`
  const files = CONDITIONAL_SECTIONS.map(({ file }) => file)
  const [conduct, texts, materiality] = await Promise.all([
    readSections(directory, SPECIALIST_SECTIONS),
    readSections(directory, files),
    readSource(`${host.instructions}/${MATERIALITY_PATH}`).then(stripCitations),
  ])
  const embedded = await Effect.runPromise(
    Effect.forEach(files, (file, at) =>
      embedMateriality(texts[at] ?? "", materiality, `${directory}/${file}`),
    ),
  )
  const conditional = Object.fromEntries(files.map((file, at) => [file, embedded[at] ?? ""]))
  return Promise.all(ROUTES.map((route) => specialist(host, route, { conduct, conditional })))
}

/**
 * The root agent: the main thread, which dispatches every specialist. Its body is the files of
 * `root/` in order.
 */
const rootAgent = async (): Promise<GeneratedFile> => {
  const source = `${INSTRUCTIONS_DIRECTORY}/root`
  const head = frontmatter(generatedNote(source), [
    `name: ${PLUGIN_NAME}`,
    `description: ${JSON.stringify(ROOT_DESCRIPTION)}`,
    "model: opus",
    // Claude Code ignores `effort` on the main thread (anthropics/claude-code#81677, #97829), so
    // the root's real level comes from the user settings `holyagent setup` writes; the field
    // documents the intent and applies where the root runs as a subagent.
    "effort: high",
    `disallowedTools: ${denylist(ROOT_BUILTINS)}`,
  ])
  // The history rules continue the bullet list of the version-control rules, so no blank line
  // splits it; every other section is a paragraph of its own.
  const body = (await readSections(source, ROOT_SECTIONS))
    .map((text) =>
      text.replace(GUIDANCE_MARKER, guidanceRouter("root", "claude-5.5", "${CLAUDE_PLUGIN_ROOT}")),
    )
    .map((text, at) =>
      at === 0 ? text : `${ROOT_SECTIONS[at] === HISTORY_RULES_FILE ? "\n" : "\n\n"}${text}`,
    )
    .join("")
  return {
    path: `${DIST_DIRECTORY}/agents/${PLUGIN_NAME}.md`,
    content: `${head}\n\n${body}\n`,
  }
}

/** The specialist prompt's host for the Claude plugin. */
const CLAUDE_HOST: SpecialistHost = {
  instructions: INSTRUCTIONS_DIRECTORY,
  guidanceFamily: "claude-5.5",
  guidanceRoot: "${CLAUDE_PLUGIN_ROOT}",
  path: (route) => `${DIST_DIRECTORY}/agents/${route.agent}.md`,
  head: (route, source, description) =>
    frontmatter(generatedNote(source), [
      `name: ${route.agent}`,
      `description: ${JSON.stringify(description)}`,
      `model: ${route.model}`,
      `effort: ${route.effort}`,
      "background: true",
      `disallowedTools: ${denylist(builtinsOf(route))}`,
      "experimental:",
      "  cacheTtl: 1h",
    ]),
  runtime: (route) => `; ${route.model}, ${route.effort} effort`,
}

/** The root agent and one agent for each route, with paths relative to the plugin folder. */
export const agentFiles = async (): Promise<ReadonlyArray<GeneratedFile>> => [
  await rootAgent(),
  ...(await specialistFiles(CLAUDE_HOST)),
]
