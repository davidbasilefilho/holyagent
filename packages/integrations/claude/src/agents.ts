import { type Capability, type Route, ROUTES } from "../../../runtime/src/domain/route.ts"
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
  specialistText: string,
  writingBar: string,
  inspection: ReadonlyArray<string>,
): Promise<GeneratedFile> => {
  const source = `${INSTRUCTIONS_DIRECTORY}/roles/${route.agent}.md`
  const role = await readSource(source)
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
    role.trim(),
    specialistText.trim(),
    ...(WRITING_BAR.has(route.roleTask) ? [writingBar.trim()] : []),
  ].join("\n\n")
  return {
    path: `${DIST_DIRECTORY}/agents/${route.agent}.md`,
    content: `${head}\n\n${body}\n`,
  }
}

/** The root agent: the main thread, which dispatches every specialist. Its body is root.md as it is. */
const rootAgent = async (): Promise<GeneratedFile> => {
  const source = `${INSTRUCTIONS_DIRECTORY}/root.md`
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
    content: `${head}\n\n${await readSource(source)}`,
  }
}

/** The root agent and one agent for each route, with paths relative to the plugin folder. */
export const agentFiles = async (): Promise<ReadonlyArray<GeneratedFile>> => {
  const [specialistText, writingBar, skill] = await Promise.all([
    readSource(`${INSTRUCTIONS_DIRECTORY}/specialist.md`),
    readSource(`${INSTRUCTIONS_DIRECTORY}/writing-bar.md`),
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
