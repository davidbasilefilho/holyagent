import { type Capability, type Route, ROUTES } from "../../../runtime/src/domain/route.ts"
import { ROOT_CORE_FILES } from "../../../runtime/src/instructions/claude-5.5/root-core.ts"
import {
  DIST_DIRECTORY,
  type GeneratedFile,
  generatedNote,
  INSTRUCTIONS_DIRECTORY,
  readSource,
} from "./files.ts"

/** The plugin's name, which namespaces its agents, skills and workflows. */
export const PLUGIN_NAME = "holyagent"

const ROOT_DESCRIPTION =
  "Use as the main-thread agent: it plans the work as an Intent with Assignments, dispatches the holyagent specialists through the CLI, judges their reports, accepts work on evidence and owns version control."

/**
 * The web tools of the Search roles: the MCP server of Exa's plugin, a dependency of this one, in
 * place of Claude Code's WebSearch and WebFetch. `agent_run` is listed only when the user has
 * signed in to Exa or set an API key.
 */
const WEB = ["web_search_exa", "web_fetch_exa", "agent_run"].map(
  (name) => `mcp__plugin_exa_exa__${name}`,
)
const WRITING = ["Write", "Edit", "Bash"]
/**
 * The T3 Code tools of the root; the visual roles take theirs from the `interface-inspection`
 * skill.
 */
const ROOT_T3_TOOLS = ["html_render", "html_preview", "watch_pull_request"]

/** Roles that review code and take the mergeability bar and the `merge-ready` skill with them. */
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
 * The sections of the root prompt, as files of `root/` in prompt order. The core opens it; the
 * order is fixed here so that a file's name never decides where its text lands.
 */
export const ROOT_SECTIONS: ReadonlyArray<string> = [
  ...ROOT_CORE_FILES,
  "routing.md",
  "workflows.md",
  "assignments.md",
  "instruction-guidelines.md",
  "version-control.md",
  "stack-plan.md",
  "ci.md",
  "pr-text.md",
  "asking.md",
  "skills.md",
]

/** The sections of the conduct every specialist shares, as files of `specialist/` in prompt order. */
export const SPECIALIST_SECTIONS: ReadonlyArray<string> = [
  "conduct.md",
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
  "reviewer-visual": ["purpose.md", "captures.md"],
  "worker-debugging": ["purpose.md", "phases.md", "escalation.md"],
  "worker-implementation": ["purpose.md", "method.md", "refactor.md", "instruction-text.md"],
  "worker-integration": ["purpose.md", "method.md"],
  "worker-mechanical": ["purpose.md", "method.md", "refactor.md"],
  "worker-operations": ["purpose.md", "method.md", "dev-server.md"],
  "worker-validation": ["purpose.md", "method.md", "baseline.md"],
  "worker-visual": ["purpose.md", "method.md"],
}

const readSections = async (
  directory: string,
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> =>
  (await Promise.all(names.map((name) => readSource(`${directory}/${name}`)))).map((text) =>
    text.trim(),
  )

/** Roles that get the writing bar, for the instruction text they write or judge. */
const WRITING_BAR: ReadonlySet<string> = new Set(["Worker.implementation", "Reviewer.artifact"])

/**
 * Roles that start with a built-in review of Claude Code, `/code-review` and `/security-review`.
 * Both are prompt commands that only the Skill tool can run, and neither needs more: the shell
 * reads of `/security-review` run through the host's own shell, whatever tools the agent lists.
 */
const BUILTIN_REVIEW: ReadonlySet<string> = new Set(["Reviewer.code", "Reviewer.security"])

const t3 = (names: ReadonlyArray<string>) => names.map((name) => `mcp__t3-code__${name}`)

/**
 * The T3 Code inspection tools the `interface-inspection` skill names (`preview_*`, `device_*` and
 * `html_*`), in order of appearance, so the skill stays their one source.
 */
export const inspectionTools = (skill: string): ReadonlyArray<string> => [
  ...new Set(
    Array.from(
      skill.matchAll(/\b(?:mcp__t3-code__)?((?:preview|device|html)(?:_[a-z]+)+)\b/g),
      ([, name = ""]) => name,
    ),
  ),
]

const capabilityTools = (
  capabilities: ReadonlyArray<Capability>,
  inspection: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  ...(capabilities.includes("Search") ? WEB : []),
  ...(capabilities.includes("Write") ? WRITING : []),
  ...(capabilities.includes("Shell") ? ["Bash"] : []),
  ...(capabilities.includes("VisualInspection") ? t3(inspection) : []),
]

/**
 * The tools of a specialist: reading for all, then what its capabilities call for. Reviewer.code
 * keeps Bash without a Shell capability, since it reads diffs with git. The roles of
 * {@link BUILTIN_REVIEW} get Skill, and a role with Bash gets Monitor for its long commands.
 */
const toolsOf = (route: Route, inspection: ReadonlyArray<string>): ReadonlyArray<string> => {
  const granted = [
    "Read",
    "Grep",
    "Glob",
    ...capabilityTools(route.capabilities, inspection),
    ...(route.roleTask === "Reviewer.code" ? ["Bash"] : []),
    ...(BUILTIN_REVIEW.has(route.roleTask) ? ["Skill"] : []),
  ]
  const unique = [...new Set(granted)]
  return unique.includes("Bash") ? [...unique, "Monitor"] : unique
}

const skillsOf = (route: Route): ReadonlyArray<string> => [
  ...(MERGE_READY.has(route.roleTask) ? [`${PLUGIN_NAME}:merge-ready`] : []),
  ...(route.capabilities.includes("VisualInspection")
    ? [`${PLUGIN_NAME}:interface-inspection`]
    : []),
]

const firstSentence = (text: string): string => {
  const paragraph = text.trim().split("\n")[0] ?? ""
  return /^.*?\.(?=\s|$)/.exec(paragraph)?.[0] ?? paragraph
}

/** What the root reads to pick the specialist: its purpose first, then how it runs. */
const describe = (route: Route, role: string): string =>
  `Use for ${route.agent}: ${firstSentence(role)} ${route.mutability === "ReadOnly" ? "Read-only" : "Writes inside its ownership paths"}; independence ${route.independence}; ${route.model}, ${route.effort} effort.`

const frontmatter = (source: string, lines: ReadonlyArray<string>): string =>
  ["---", `# ${generatedNote(source)}`, ...lines, "---"].join("\n")

const specialist = async (
  route: Route,
  specialistText: ReadonlyArray<string>,
  writingBar: string,
  inspection: ReadonlyArray<string>,
): Promise<GeneratedFile> => {
  const source = `${INSTRUCTIONS_DIRECTORY}/roles/${route.agent}`
  const [role = "", ...rest] = await readSections(source, ROLE_SECTIONS[route.agent] ?? [])
  const skills = skillsOf(route)
  const head = frontmatter(source, [
    `name: ${route.agent}`,
    `description: ${JSON.stringify(describe(route, role))}`,
    `model: ${route.model}`,
    `effort: ${route.effort}`,
    "background: true",
    `tools: ${toolsOf(route, inspection).join(", ")}`,
    ...(skills.length === 0 ? [] : ["skills:", ...skills.map((skill) => `  - ${skill}`)]),
    "experimental:",
    "  cacheTtl: 1h",
  ])
  const body = [
    `You are the ${PLUGIN_NAME} ${route.agent} specialist. Independence: ${route.independence}.`,
    role,
    ...rest,
    ...specialistText,
    ...(WRITING_BAR.has(route.roleTask) ? [writingBar] : []),
  ].join("\n\n")
  return {
    path: `${DIST_DIRECTORY}/agents/${route.agent}.md`,
    content: `${head}\n\n${body}\n`,
  }
}

/**
 * The root agent: the main thread, which dispatches every specialist. Its body is the files of
 * `root/` in order.
 */
const rootAgent = async (): Promise<GeneratedFile> => {
  const source = `${INSTRUCTIONS_DIRECTORY}/root`
  const tools = [
    `Agent(${ROUTES.map((route) => `${PLUGIN_NAME}:${route.agent}`).join(", ")})`,
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
    "Grep",
    "Glob",
    "Bash",
    ...t3(ROOT_T3_TOOLS),
  ]
  const head = frontmatter(source, [
    `name: ${PLUGIN_NAME}`,
    `description: ${JSON.stringify(ROOT_DESCRIPTION)}`,
    "model: opus",
    `tools: ${tools.join(", ")}`,
  ])
  return {
    path: `${DIST_DIRECTORY}/agents/${PLUGIN_NAME}.md`,
    content: `${head}\n\n${(await readSections(source, ROOT_SECTIONS)).join("\n\n")}\n`,
  }
}

/** The root agent and one agent for each route, with paths relative to the plugin folder. */
export const agentFiles = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const [specialistText, [writingBar = ""], skill] = await Promise.all([
    readSections(`${INSTRUCTIONS_DIRECTORY}/specialist`, SPECIALIST_SECTIONS),
    readSections(`${INSTRUCTIONS_DIRECTORY}/specialist`, [WRITING_BAR_SECTION]),
    readSource(`${INSTRUCTIONS_DIRECTORY}/skills/interface-inspection/SKILL.md`),
  ])
  const inspection = inspectionTools(skill)
  return [
    await rootAgent(),
    ...(await Promise.all(
      ROUTES.map((route) => specialist(route, specialistText, writingBar, inspection)),
    )),
  ]
}
