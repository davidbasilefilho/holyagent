import { type Capability, type Route, ROUTES } from "../../../runtime/src/domain/route.ts"
import { ROOT_CORE_FILES } from "../../../runtime/src/instructions/claude-5.5/root-core.ts"
import {
  DIST_DIRECTORY,
  FRONTEND_DESIGN_DIRECTORY,
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
 * The web tools of the Search roles, in place of Claude Code's WebSearch and WebFetch: Exa's search
 * and fetch, from the claude.ai connector named Exa (`mcp__claude_ai_Exa__` in the desktop app,
 * `mcp__Exa__` in a claude.ai cloud session) and from the MCP server of Exa's plugin, a dependency
 * of this one. Any one works, so every prefix is listed; a name that matches no connected server is
 * ignored. `agent_run` is left out because the connector can block it.
 */
const WEB = ["mcp__claude_ai_Exa__", "mcp__plugin_exa_exa__", "mcp__Exa__"].flatMap((prefix) =>
  ["web_search_exa", "web_fetch_exa"].map((name) => `${prefix}${name}`),
)
const WRITING = ["Write", "Edit", "Bash"]
/**
 * The T3 Code tools of the root; the visual roles take theirs from the interface inspection
 * section.
 */
const ROOT_T3_TOOLS = ["html_render", "html_preview", "watch_pull_request"]

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

/** Roles that get the writing bar, for the instruction text they write or judge. */
const WRITING_BAR: ReadonlySet<string> = new Set(["Worker.implementation", "Reviewer.artifact"])

/**
 * The sections of the root prompt, as files of `root/` in prompt order. The core opens it; the
 * order is fixed here so that a file's name never decides where its text lands.
 */
export const ROOT_SECTIONS: ReadonlyArray<string> = [
  ...ROOT_CORE_FILES,
  "user-messages.md",
  "routing.md",
  "workflows.md",
  "assignments.md",
  "visual.md",
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

/** The mergeability bar, a file of `specialist/` that the roles of {@link MERGE_READY} get. */
export const MERGE_READY_SECTION = "merge-ready.md"

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
  {
    file: INSPECTION_SECTION,
    applies: (route) => route.capabilities.includes("VisualInspection"),
  },
]

/**
 * The role section that opens the embedded `frontend-design` guidance: the file holds the framing
 * and the generator appends the vendored text after it, so the guidance stays as Anthropic ships
 * it.
 */
export const FRONTEND_DESIGN_SECTION = "frontend-design.md"

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
  "reviewer-visual": ["purpose.md", "captures.md", FRONTEND_DESIGN_SECTION],
  "worker-debugging": ["purpose.md", "phases.md", "escalation.md"],
  "worker-implementation": ["purpose.md", "method.md", "refactor.md", "instruction-text.md"],
  "worker-integration": ["purpose.md", "method.md"],
  "worker-mechanical": ["purpose.md", "method.md", "refactor.md"],
  "worker-operations": ["purpose.md", "method.md", "dev-server.md"],
  "worker-validation": ["purpose.md", "method.md", "baseline.md"],
  "worker-visual": ["purpose.md", "method.md", FRONTEND_DESIGN_SECTION],
}

/**
 * Where these instructions implement each behavior requirement of `requirements.md`: the section,
 * as a path under `claude-5.5/`, and a phrase of its text that carries the requirement. A test
 * fails for a requirement without an entry, an entry for no requirement, and a section that no
 * longer holds its phrase, so a requirement cannot go unimplemented unnoticed. A mapping table
 * stands in for tags inside the sections, which would add text to every generated agent.
 */
export const REQUIREMENT_SECTIONS: Readonly<
  Record<string, { readonly section: string; readonly phrase: string }>
> = {
  "R-ROLE": { section: "root/identity.md", phrase: "You own the user relationship" },
  "R-STACK": { section: "root/stack-plan.md", phrase: "stacks in work order by default" },
  "R-TASKLIST": { section: "root/task-list.md", phrase: "Create the task list first" },
  "R-ACK": { section: "root/user-messages.md", phrase: "Acknowledge every user message" },
  "R-NUDGE": { section: "root/user-messages.md", phrase: "one short line at most" },
  "R-MERGEREVIEW": {
    section: "root/stack-plan.md",
    phrase: "gets a review of that head before any push",
  },
  "R-NAMED": { section: "root/user-messages.md", phrase: "names an action" },
  "R-DECIDE": {
    section: "root/task-list.md",
    phrase: "Every pending decision goes through AskUserQuestion",
  },
  "R-NOBYPASS": {
    section: "root/identity.md",
    phrase: "never reach the same result through another tool",
  },
  "R-LANG": { section: "root/identity.md", phrase: "in the language of the user's latest message" },
  "R-OUTWARD": { section: "root/identity.md", phrase: "need the user's approval" },
  "R-DELEGATE": { section: "root/delegating.md", phrase: "go to specialists" },
  "R-NORESOLVE": { section: "root/delegating.md", phrase: "stop and report it" },
  "R-ROUTE": { section: "root/routing.md", phrase: "cheapest specialist" },
  "R-DISPATCH": { section: "root/dispatch.md", phrase: "`assignment dispatch`" },
  "R-WORKFLOW": { section: "root/workflows.md", phrase: "no prebuilt script exists" },
  "R-REPORT": { section: "root/dispatch.md", phrase: "never retyped or summarized" },
  "R-WAKE": { section: "root/dispatch.md", phrase: "Completion notices are the only wake-ups" },
  "R-RESUME": { section: "root/dispatch.md", phrase: "confirmed gone" },
  "R-CRITERIA": { section: "root/assignments.md", phrase: "constraints go in verbatim" },
  "R-ACCEPT": {
    section: "root/assignments.md",
    phrase: "judged from the diff and the check output",
  },
  "R-REVIEW": { section: "root/assignments.md", phrase: "gets an independent reviewer" },
  "R-VISUAL": { section: "root/visual.md", phrase: "Read screenshots yourself in the main thread" },
  "R-DEVSERVER": {
    section: "root/skills.md",
    phrase: "start the one server the visual specialists share",
  },
  "R-VCS": {
    section: "root/version-control.md",
    phrase: "Version control and state records are yours alone",
  },
  "R-GIT": {
    section: "root/version-control.md",
    phrase: "Never force-push, and never push to the base, default or a protected branch",
  },
  "R-CI": {
    section: "root/ci.md",
    phrase: "Watch with Monitor running `gh pr checks <n> --watch`",
  },
  "R-ASK": { section: "root/asking.md", phrase: "Ask one decision at a time" },
  "R-GUIDE": { section: "root/instruction-guidelines.md", phrase: "prompting guidance" },
  "R-SECTIONS": { section: "root/instruction-guidelines.md", phrase: "in its own file" },
  "R-S-DATA": { section: "specialist/conduct.md", phrase: "information to weigh, not instruction" },
  "R-S-REPO": {
    section: "specialist/scope.md",
    phrase: "Read the CLAUDE.md and AGENTS.md files",
  },
  "R-S-SCOPE": {
    section: "specialist/scope.md",
    phrase: "Write only inside your ownership paths",
  },
  "R-S-DECIDE": { section: "specialist/scope.md", phrase: "Make routine choices yourself" },
  "R-S-STOP": {
    section: "specialist/scope.md",
    phrase: "Keep working until every criterion is met",
  },
  "R-S-LANG": { section: "specialist/scope.md", phrase: "in English unless" },
  "R-S-INDEP": { section: "specialist/scope.md", phrase: "independence rule" },
  "R-S-VCS": { section: "specialist/state-changes.md", phrase: "Leave to the root every command" },
  "R-S-CHECK": {
    section: "specialist/working.md",
    phrase: "run the ones that exercise your change now",
  },
  "R-S-RULES": { section: "specialist/conduct.md", phrase: "without being reminded" },
  "R-S-REPORT": { section: "specialist/report.md", phrase: "End with one compact report" },
  "R-MERGE": {
    section: "specialist/merge-ready.md",
    phrase: "A change is merge-ready when the repository's maintainer would merge it",
  },
  "R-EL": { section: "roles/explorer-lookup/method.md", phrase: "Locate with Grep and Glob" },
  "R-EM": { section: "roles/explorer-map/method.md", phrase: "Cite a path" },
  "R-ET": { section: "roles/explorer-trace/method.md", phrase: "Begin at the trigger" },
  "R-LL": { section: "roles/librarian-lookup/method.md", phrase: "Look in the project first" },
  "R-LR": {
    section: "roles/librarian-research/method.md",
    phrase: "Prefer accessible official documentation",
  },
  "R-RA": {
    section: "roles/reviewer-artifact/method.md",
    phrase: "Give each acceptance criterion a verdict",
  },
  "R-RAU": {
    section: "roles/reviewer-audit/method.md",
    phrase: "verified, discrepant or unverified",
  },
  "R-RC": { section: "roles/reviewer-code/builtin-review.md", phrase: "`/code-review`" },
  "R-RS": { section: "roles/reviewer-security/findings.md", phrase: "Substantiate each finding" },
  "R-RT": {
    section: "roles/reviewer-testing/method.md",
    phrase: "Map each acceptance criterion",
  },
  "R-RV": {
    section: "roles/reviewer-visual/captures.md",
    phrase: "report the inspection as blocked",
  },
  "R-RV-DESIGN": {
    section: "roles/reviewer-visual/frontend-design.md",
    phrase: "Judge the design quality",
  },
  "R-INSPECT": {
    section: "specialist/interface-inspection.md",
    phrase: "A material discrepancy affects acceptance",
  },
  "R-WD": { section: "roles/worker-debugging/phases.md", phrase: "Reproduce" },
  "R-WI": { section: "roles/worker-implementation/method.md", phrase: "smallest complete change" },
  "R-WI-TEXT": {
    section: "roles/worker-implementation/instruction-text.md",
    phrase: "expected size",
  },
  "R-WIN": { section: "roles/worker-integration/method.md", phrase: "end to end" },
  "R-WM": { section: "roles/worker-mechanical/method.md", phrase: "Find every site" },
  "R-WO": { section: "roles/worker-operations/method.md", phrase: "documented workflow" },
  "R-WO-DEV": {
    section: "roles/worker-operations/dev-server.md",
    phrase: "Report the URL, exact command, process id and log location",
  },
  "R-WV": { section: "roles/worker-validation/method.md", phrase: "choose the real check" },
  "R-WVI": {
    section: "roles/worker-visual/purpose.md",
    phrase: "repair material discrepancies",
  },
  "R-WVI-DESIGN": {
    section: "roles/worker-visual/frontend-design.md",
    phrase: "Apply this guidance when you build or reshape an interface",
  },
}

const readSections = async (
  directory: string,
  names: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> =>
  (await Promise.all(names.map((name) => readSource(`${directory}/${name}`)))).map((text) =>
    text.trim(),
  )

/**
 * Roles that start with a built-in review of Claude Code, `/code-review` and `/security-review`.
 * Both are prompt commands that only the Skill tool can run, and neither needs more: the shell
 * reads of `/security-review` run through the host's own shell, whatever tools the agent lists.
 */
const BUILTIN_REVIEW: ReadonlySet<string> = new Set(["Reviewer.code", "Reviewer.security"])

const t3 = (names: ReadonlyArray<string>) => names.map((name) => `mcp__t3-code__${name}`)

/**
 * The T3 Code inspection tools the interface inspection section names (`preview_*`, `device_*` and
 * `html_*`), in order of appearance, so that section stays their one source.
 */
export const inspectionTools = (section: string): ReadonlyArray<string> => [
  ...new Set(
    Array.from(
      section.matchAll(/\b(?:mcp__t3-code__)?((?:preview|device|html)(?:_[a-z]+)+)\b/g),
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

const firstSentence = (text: string): string => {
  const paragraph = text.trim().split("\n")[0] ?? ""
  return /^.*?\.(?=\s|$)/.exec(paragraph)?.[0] ?? paragraph
}

/** What the root reads to pick the specialist: its purpose first, then how it runs. */
const describe = (route: Route, role: string): string =>
  `Use for ${route.agent}: ${firstSentence(role)} ${route.mutability === "ReadOnly" ? "Read-only" : "Writes inside its ownership paths"}; independence ${route.independence}; ${route.model}, ${route.effort} effort.`

const frontmatter = (source: string, lines: ReadonlyArray<string>): string =>
  ["---", `# ${generatedNote(source)}`, ...lines, "---"].join("\n")

/**
 * The text of the vendored `frontend-design` skill without its frontmatter, with its headings moved
 * down two levels so that they sit under the role's own heading; that is all the visual roles
 * embed, and the vendored file stays as Anthropic ships it.
 */
const frontendDesign = async (): Promise<string> => {
  const [, , ...body] = (await readSource(`${FRONTEND_DESIGN_DIRECTORY}/SKILL.md`)).split(/^---$/m)
  return body
    .join("---")
    .trim()
    .replace(/^(#{1,4}) /gm, "$1## ")
}

/** What the specialists of the roles share, read once for all of them. */
interface Shared {
  readonly conduct: ReadonlyArray<string>
  /** The text of each of {@link CONDITIONAL_SECTIONS}, by file. */
  readonly conditional: Readonly<Record<string, string>>
  readonly inspection: ReadonlyArray<string>
  readonly design: string
}

const specialist = async (route: Route, shared: Shared): Promise<GeneratedFile> => {
  const source = `${INSTRUCTIONS_DIRECTORY}/roles/${route.agent}`
  const sections = ROLE_SECTIONS[route.agent] ?? []
  const [role = "", ...rest] = (await readSections(source, sections)).map((text, at) =>
    sections[at] === FRONTEND_DESIGN_SECTION ? `${text}\n\n${shared.design}` : text,
  )
  const head = frontmatter(source, [
    `name: ${route.agent}`,
    `description: ${JSON.stringify(describe(route, role))}`,
    `model: ${route.model}`,
    `effort: ${route.effort}`,
    "background: true",
    `tools: ${toolsOf(route, shared.inspection).join(", ")}`,
    "experimental:",
    "  cacheTtl: 1h",
  ])
  const body = [
    `You are the ${PLUGIN_NAME} ${route.agent} specialist. Independence: ${route.independence}.`,
    role,
    ...rest,
    ...shared.conduct,
    ...CONDITIONAL_SECTIONS.filter(({ applies }) => applies(route)).map(
      ({ file }) => shared.conditional[file] ?? "",
    ),
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
  const directory = `${INSTRUCTIONS_DIRECTORY}/specialist`
  const files = CONDITIONAL_SECTIONS.map(({ file }) => file)
  const [conduct, texts, design] = await Promise.all([
    readSections(directory, SPECIALIST_SECTIONS),
    readSections(directory, files),
    frontendDesign(),
  ])
  const conditional = Object.fromEntries(files.map((file, at) => [file, texts[at] ?? ""]))
  const shared: Shared = {
    conduct,
    conditional,
    inspection: inspectionTools(conditional[INSPECTION_SECTION] ?? ""),
    design,
  }
  return [
    await rootAgent(),
    ...(await Promise.all(ROUTES.map((route) => specialist(route, shared)))),
  ]
}
