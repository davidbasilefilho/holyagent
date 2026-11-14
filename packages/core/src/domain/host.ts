import { PI_WORKFLOW_AGENT_PREFIX, WORKFLOW_AGENT_PREFIX } from "./directive.ts"

/**
 * The agent hosts the runtime serves: Claude Code, and pi with the `@tintinweb/pi-subagents`
 * launcher.
 */
export const AGENT_HOSTS = ["claude", "pi"] as const

/** The agent host a command runs under. */
export type AgentHost = (typeof AGENT_HOSTS)[number]

/** The known external Pi names and their optional snake_case aliases. */
export const PI_TOOL_ALIASES: Readonly<Record<string, string>> = {
  agent: "Agent",
  subagent_workflow: "SubagentWorkflow",
  fff_multi_grep: "fff-multi-grep",
}

/** Return the original name for a known alias, preserving every other name. */
export const canonicalPiToolName = (name: string): string => PI_TOOL_ALIASES[name] ?? name

/**
 * What the output names that depends on the host: its tools and the way it reaches a warm
 * specialist. Every sentence of the help, `plan` and `assignment dispatch` that names one is built
 * from these, so one host's words never reach the other's output.
 */
export interface HostWords {
  /** The tool that runs an inline workflow script, named with `tool` after it. */
  readonly workflowTool: string
  /** The tool that launches one subagent. */
  readonly agentTool: string
  /** The tool a specialist reads its brief with. */
  readonly readTool: string
  /** How the root reaches a warm specialist, after "by". */
  readonly message: string
  /** How the root confirms that an agent is gone, in the parentheses of the reconcile result. */
  readonly confirmGone: string
  /** The start of the hint that asks a subagent for the missing support of its report. */
  readonly askForSupport: string
  /** The same ask inside the help of `assignment close`, as a clause. */
  readonly askAgain: string
  /** The prefix of the agent id of a specialist a workflow launched, before `<run-id>/<id>`. */
  readonly workflowAgentPrefix: string
  /** What a workflow run's journal is called in the help, with its first letter as the help has it. */
  readonly journal: string
  /** The help note of `assignment record` on whether a hook records the agent or the root does. */
  readonly recordNote: string
  /** A help note of `assignment reports` on the journals it reads, for a host with a limit there. */
  readonly reportsNote?: string
  /** A help note on how agent ids are recorded, for a host that records them in a form of its own. */
  readonly agentIdNote?: string
  /** A help note on the form of the model and effort the dispatch prints, for a host with its own. */
  readonly launchNote?: string
}

/**
 * The words of Claude Code: its Workflow, Agent and Read tools, and SendMessage for a warm
 * specialist. Existing output is built from these, so changing one changes the plugin's text.
 */
export const CLAUDE_WORDS: HostWords = {
  workflowTool: "Workflow",
  agentTool: "Agent",
  readTool: "Read",
  message: "SendMessage",
  confirmGone: "SendMessage or transcript",
  askForSupport: "SendMessage the subagent",
  askAgain: "SendMessage the missing support to the same subagent",
  workflowAgentPrefix: WORKFLOW_AGENT_PREFIX,
  journal: "Workflow run's journal",
  recordNote:
    "a hook records an agent spawned from a dispatch prompt and says so in its note; record it yourself when the note says it did not, or for a continued agent",
}

/**
 * The words of pi with `@tintinweb/pi-subagents`: its `SubagentWorkflow` and `Agent` tools, `read`
 * for the brief, and the `Agent` tool's `resume` (a finished agent's id) for a warm specialist,
 * with `get_subagent_result` to see whether an agent is still there.
 */
export const PI_WORDS: HostWords = {
  workflowTool: "SubagentWorkflow",
  agentTool: "Agent",
  readTool: "read",
  message: "the Agent tool's resume",
  confirmGone: "get_subagent_result or transcript",
  askForSupport: "Resume the subagent with the Agent tool",
  askAgain: "resume the same subagent with the Agent tool and ask for the missing support",
  workflowAgentPrefix: PI_WORKFLOW_AGENT_PREFIX,
  journal: "workflow run's journal",
  recordNote:
    "the pi launcher records no agent by hook: the launcher glue or the root records each agent, with the ID the Agent tool returns, including a continued one",
  reportsNote:
    "under the pi host the file is a <run id>.workflow.jsonl of @tintinweb/pi-subagents, whose entries are matched to Assignments by the key of their dispatched call, or the root session file, which holds the record of each Assignment recorded as pi:<agent-id>; an entry that failed, has no text or matches no call is listed with the run and its index",
  agentIdNote:
    "under the pi host an agent is recorded as pi:<agent-id>, the ID the Agent tool returns (strip pi: to message it), and a workflow's agent as pi-workflow:<run-id>/<id>, with the run ID and the label the script gave the agent (the Assignment id); any other form is refused",
  launchNote:
    "under the pi host model is the Pi route table's `<provider>/<id>` and effort its thinking level for the specialist (pi.routes in config.json), as @tintinweb/pi-subagents takes them: pass model as it is, and effort as agent()'s effort or the Agent tool's thinking. With pi.enable off both are left out and the specialist inherits the session's",
}

/** The words of a host. */
export const wordsFor = (host: AgentHost): HostWords => (host === "pi" ? PI_WORDS : CLAUDE_WORDS)
