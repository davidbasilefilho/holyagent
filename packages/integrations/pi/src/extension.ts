import nodePath, { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  BeforeAgentStartEventResult,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  Theme,
  ToolCallEventResult,
  ToolRenderers,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { Cause, Data, Effect, Exit, Schema } from "effect"

import { literalWorkflowName, workflowRefusal } from "../../../runtime/src/cli/workflow-check.ts"
import { Config, defaultConfig } from "../../../runtime/src/config/schema.ts"
import { toPosix } from "../../../runtime/src/domain/paths.ts"
import {
  DEFAULT_PI_ROLE,
  parseOutput,
  PI_ROLES,
  PI_ROOT_PLACEHOLDER,
  piContext,
  type PiRole,
  PiRoleSchema,
  type ProjectState,
} from "../../../runtime/src/hooks/pi-context.ts"
import { PI_PROJECT_FLAG } from "../../../runtime/src/hooks/pi-project.ts"
import { hasStateFolder } from "../../../runtime/src/hooks/state-folder.ts"
import { validateModelCatalog } from "../../../runtime/src/pi/catalog.ts"
import { providerEnv } from "../../../runtime/src/pi/provider.ts"
import { type CommandRunner, requireProviderReady } from "../../../runtime/src/pi/readiness.ts"
import { PI_ROOT_PROMPT } from "../../../runtime/src/pi/root-prompt.ts"
import {
  rootActiveTools,
  type ToolArgs,
  toolArgs,
  toolMatches,
} from "../../../runtime/src/pi/tools.ts"
import { STATE_DIRECTORY } from "../../../runtime/src/state/layout.ts"
import { SPECIALIST_NAMES } from "./specialists.ts"

/** The launch flag that tells the extension what the session is for: root, specialist or session. */
export const ROLE_FLAG = "holyagent-role"

/**
 * The custom message that carries the status context, which the model reads and the user does not
 * see.
 */
export const CONTEXT_MESSAGE = "holyagent-context"

/** The custom message that carries a one-line notice of what failed, shown to the user. */
export const NOTICE_MESSAGE = "holyagent-notice"

/** The longest a command may run, in milliseconds, as the Claude hook's ten seconds allow. */
export const COMMAND_TIMEOUT_MS = 8_000

/**
 * The longest the whole collection may take, in milliseconds: the Claude hook's ten seconds, which
 * every command, however many run, shares.
 */
export const SESSION_DEADLINE_MS = 10_000

/**
 * The longest to wait for a stopped command to exit, in milliseconds. A grandchild that holds the
 * command's pipes would otherwise keep a gather, and the shutdown that waits for it, from ending.
 */
export const STOP_GRACE_MS = 2_000

/** The environment variable that names the agent host to the `holyagent` CLI. */
export const HOST_ENV = "HOLYAGENT_HOST"

/** The environment variable that tells the `holyagent` CLI whether the host offers workflows. */
export const WORKFLOWS_ENV = "HOLYAGENT_WORKFLOWS"

/**
 * The environment variable that makes Pi's providers keep their prompt cache for the long retention
 * (one hour on providers that have it).
 */
export const CACHE_RETENTION_ENV = "PI_CACHE_RETENTION"

/** The name of the package's tool that launches a specialist. */
export const AGENT_TOOL = "Agent"

/** The name of the package's tool that runs a workflow script. */
export const WORKFLOW_TOOL = "SubagentWorkflow"

/** The name of Pi's built-in codemode tool. */
export const CODEMODE_TOOL_NAME = "codemode"

/**
 * The name of the specialist a session is, or undefined for any other session. The package names a
 * child's session `<agent>#<first 8 characters of its id>` before it binds the child's extensions,
 * so the name is readable when the child's `session_start` fires. A session name a user chose does
 * not count unless it names a specialist and has the `#`.
 */
export const childAgent = (sessionName: string | undefined): string | undefined => {
  const at = sessionName?.indexOf("#") ?? -1
  const agent = at < 0 ? undefined : sessionName?.slice(0, at)
  return agent !== undefined && SPECIALIST_NAMES.includes(agent) ? agent : undefined
}

/**
 * The variables the `holyagent` calls of the root need: the host (`pi`) and whether workflows are
 * on. Workflows are on when both `SubagentWorkflow` and `codemode` are active tools: the workflow
 * tool is what runs one, and under codemode `only` the root reaches it through a script. The
 * package can withdraw `SubagentWorkflow` after load, so this is read again before each run.
 */
export const hostEnvironment = (
  activeTools: ReadonlyArray<string>,
): Readonly<Record<string, string>> => ({
  [HOST_ENV]: "pi",
  [WORKFLOWS_ENV]:
    activeTools.includes(WORKFLOW_TOOL) && activeTools.includes(CODEMODE_TOOL_NAME) ? "1" : "0",
})

/**
 * Writes `values` into `target`. Without `keep` it replaces what is there; with it, a variable the
 * user or an earlier run already set stays, so the value is set once for the process and an
 * explicit setting wins. Pi's children run in this process and share `target`, so a variable set
 * here reaches every child and the `holyagent` calls of every session.
 */
export const applyEnvironment = (
  target: Record<string, string | undefined>,
  values: Readonly<Record<string, string>>,
  keep: boolean,
): void => {
  for (const [name, value] of Object.entries(values))
    if (!keep || target[name] === undefined) target[name] = value
}

/**
 * A specialist's prompt with `${HOLYAGENT_PI_ROOT}` replaced by the package folder, written with
 * `/` only so the shell takes it for a path (see {@link wrapperPath}). The agent files hold the
 * placeholder because the install folder is not known when they are built; the extension fills it
 * when the child starts.
 */
export const fillPackageRoot = (
  prompt: string,
  packageRoot: string,
  platformPath: Pick<typeof nodePath, "sep"> = nodePath,
): string => prompt.replaceAll(PI_ROOT_PLACEHOLDER, () => toPosix(packageRoot, platformPath.sep))

/**
 * Refuses an `Agent` call whose `subagent_type` is not one of the 18 specialists. The package's
 * settings already stop its own agents and the fallback, but an agent file in the project's
 * `.pi/agents` outranks a package's, so the model could still launch a type that has the wrong
 * prompt and tools. A resume names an existing agent, so its type is not checked. The call's
 * `model` and `thinking` are left as given: they come per call by design. Returns the `tool_call`
 * result that blocks the call, or undefined to let it run.
 */
export const refuseNonSpecialist = (event: {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}): ToolCallEventResult | undefined => {
  if (event.toolName !== AGENT_TOOL) return undefined
  const { resume, subagent_type: type } = event.input
  if (typeof resume === "string" && resume.trim() !== "") return undefined
  const requested = typeof type === "string" ? type.trim() : ""
  if (SPECIALIST_NAMES.includes(requested)) return undefined
  return {
    block: true,
    reason: `${requested === "" ? "No agent type given" : `"${requested}" is not a HolyAgent specialist`}. Use one of: ${SPECIALIST_NAMES.join(", ")}.`,
  }
}

const WORKFLOW_SPECIALISTS: ReadonlySet<string> = new Set(SPECIALIST_NAMES)

// The inputs of an inline workflow call; any other key (a scriptPath, a saved name, ...) makes the
// package run something the script check did not read.
const INLINE_WORKFLOW_INPUTS: ReadonlySet<string> = new Set(["script", "args"])

const present = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== ""

/**
 * Refuses a `SubagentWorkflow` call unless every `agent()` call of its script names one of the 18
 * specialists by a string-literal `agentType`. Without an `agentType` the package starts its own
 * `general-purpose` agent with every tool, and settings cannot switch that off on this path, so the
 * script is read before it runs, with the runtime's check of the Claude `Workflow` tool (the script
 * must be plain, see `workflow-check.ts`) in its Pi mode, which parses the meta fragment and the
 * program the package runs. Only an inline `script` can be read here: a `scriptPath` or a saved
 * `name` is refused, since the file may change before the package reads it. A refusal never asks
 * for confirmation. Returns the `tool_call` result that blocks the call, or undefined to let it
 * run.
 */
export const refuseNonSpecialistWorkflow = (event: {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}): Effect.Effect<ToolCallEventResult | undefined> => {
  if (event.toolName !== WORKFLOW_TOOL) return Effect.succeed(undefined)
  const { script, scriptPath, name } = event.input
  const refuse = (reason: string): ToolCallEventResult => ({
    block: true,
    reason: `${reason} Start only HolyAgent specialists, by a string-literal agentType: ${SPECIALIST_NAMES.join(", ")}.`,
  })
  if (Object.keys(event.input).some((key) => !INLINE_WORKFLOW_INPUTS.has(key)))
    return Effect.succeed(
      refuse("A workflow is run only from an inline `script` and its `args`, with no other input."),
    )
  if (present(scriptPath) || (!present(script) && present(name)))
    return Effect.succeed(
      refuse(
        "A workflow is run only from an inline `script`; a `scriptPath` or a saved `name` cannot be checked.",
      ),
    )
  if (!present(script)) return Effect.succeed(refuse("No inline `script` given."))
  return workflowRefusal(script, WORKFLOW_SPECIALISTS, "pi").pipe(
    Effect.map((why) =>
      why === undefined ? undefined : refuse(`The workflow script is refused: it ${why}.`),
    ),
  )
}

/** The longest workflow name the call line shows. */
const WORKFLOW_NAME_LIMIT = 80

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" })

// The C0 and C1 controls (ESC and CSI among them, which start escape sequences) and the Unicode
// line and paragraph separators.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

// Unicode format characters (category Cf: bidi overrides and marks, zero-width characters, word
// joiners, the Arabic letter mark, the Mongolian vowel separator, the tag block and the like) and the
// variation selectors. They draw nothing, so they can make a line read as something else or
// carry text only the model reads.
const INVISIBLES = /[\p{Cf}\p{Variation_Selector}\u{e0000}-\u{e007f}]/gu

// Text that is safe to draw in the terminal and to hand to the model: control characters become
// spaces, invisible format characters are dropped, and the result is trimmed.
const printable = (raw: string): string => raw.replace(CONTROLS, " ").replace(INVISIBLES, "").trim()

/**
 * The text of a workflow name that is safe to draw, or undefined when nothing is left: it is
 * {@link printable}, cut to {@link WORKFLOW_NAME_LIMIT} grapheme clusters.
 */
export const sanitizeWorkflowName = (raw: string): string | undefined => {
  const cleaned = printable(raw)
  if (cleaned === "") return undefined
  let shown = ""
  let count = 0
  for (const { segment } of GRAPHEME_SEGMENTER.segment(cleaned)) {
    if (count++ === WORKFLOW_NAME_LIMIT) break
    shown += segment
  }
  return shown
}

/**
 * Wraps a function of one string so that the last argument's result is reused. The call line is
 * redrawn on every streamed update with the same, growing script, so one slot is enough and the
 * cache stays bounded.
 */
export const memoizeLast = <A>(fn: (key: string) => A): ((key: string) => A) => {
  let last: { readonly key: string; readonly value: A } | undefined
  return (key) => {
    if (last?.key === key) return last.value
    const value = fn(key)
    last = { key, value }
    return value
  }
}

/** The name the call line shows for a script, read without evaluating it; cached per script text. */
const shownWorkflowName = memoizeLast((script: string): string | undefined => {
  const raw = Effect.runSync(literalWorkflowName(script))
  return raw === undefined ? undefined : sanitizeWorkflowName(raw)
})

/**
 * The line that draws a `SubagentWorkflow` call: the tool's name and, when the script's meta
 * fragment is a vetted object of literals, the workflow's `name`, read without evaluating anything.
 * The package draws the call by evaluating that fragment on the host thread (`workflowCallName`),
 * and Pi draws a call on every streamed update and when a session is reloaded, before the
 * `tool_call` gate sees the script, so the script is untrusted here. The name loses its control
 * characters, which could move the cursor or restyle the terminal, and its bidi overrides and
 * zero-width characters, which could make the line read as something else; it is cut to
 * {@link WORKFLOW_NAME_LIMIT} grapheme clusters, so a surrogate pair is never split. The name is
 * cached per script text (see {@link memoizeLast}), since streaming redraws the same growing call.
 */
export const workflowCallLine = (args: unknown, theme: Pick<Theme, "fg" | "bold">): string => {
  const script = (args as { readonly script?: unknown } | null | undefined)?.script
  const shown = (typeof script === "string" ? shownWorkflowName(script) : undefined) ?? "workflow"
  return `${theme.fg("toolTitle", "\u25b8 ")}${theme.bold(theme.fg("toolTitle", WORKFLOW_TOOL))}  ${theme.fg("muted", shown)}`
}

/**
 * Chooses how Pi draws calls to the `SubagentWorkflow` tool: the package's result card and shell
 * stay, and the call line is {@link workflowCallLine}'s, which evaluates no script code. Any other
 * tool, and a workflow tool that is not registered, keep what the remaining resolvers and the
 * registered tool would use.
 */
export const workflowRenderers = (
  toolName: string,
  next: () => ToolRenderers | undefined,
): ToolRenderers | undefined => {
  const base = next()
  if (toolName !== WORKFLOW_TOOL || base === undefined) return base
  return {
    ...base,
    renderCall: (args, theme) => new Text(workflowCallLine(args, theme), 0, 0),
  }
}

/** Why a specialist whose last message has no text failed. */
export const EMPTY_REPORT = "the specialist's final message was empty"

/** Why a specialist whose last message stopped at the token limit failed. */
export const CUT_OFF_REPORT = "the specialist's final message was cut off at the output token limit"

/**
 * The failed form of a specialist's final message, or undefined when it is fine. The package counts
 * a child as completed when its last message stopped for any reason but a provider error or a
 * length stop without text, which leaves an empty report as "No output." and a truncated report as
 * a success. The final message is one with no tool calls: it is empty when it has no text, and cut
 * off when it stopped at the token limit. The failed form keeps the content and has the stop reason
 * `error`, which the package turns into a failed result with the reason as its error; the wording
 * avoids the words Pi retries a provider error on.
 */
export const failedFinalMessage = (
  message: MessageEndEvent["message"],
): MessageEndEventResult["message"] | undefined => {
  if (message.role !== "assistant") return undefined
  if (message.content.some((block) => block.type === "toolCall")) return undefined
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("")
    .trim()
  const errorMessage =
    message.stopReason === "length"
      ? CUT_OFF_REPORT
      : message.stopReason === "stop" && text === ""
        ? EMPTY_REPORT
        : undefined
  return errorMessage === undefined ? undefined : { ...message, stopReason: "error", errorMessage }
}

// A notice is one line and never a dump.
const NOTICE_CHARS = 400

/** The reasons for which the context is collected: Pi's session start reasons and a compaction. */
type Reason = "startup" | "reload" | "new" | "resume" | "fork" | "compact"

// The reasons after which the Running rows need a check, as the Claude hook's `RESUMED`.
const RECONCILED: ReadonlySet<Reason> = new Set(["resume", "compact"])

/**
 * A `holyagent` command of the package's wrapper that did not start, ran out of time or exited
 * non-zero.
 */
class CommandFailed extends Data.TaggedError("CommandFailed")<{
  readonly command: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `\`holyagent ${this.command}\` failed: ${this.reason}`
  }
}

/** The launch flag holds a value that is not a role. */
class UnknownRole extends Data.TaggedError("UnknownRole")<{ readonly value: string }> {
  /** The description shown to the user. */
  override get message() {
    return `unknown --${ROLE_FLAG} value "${this.value.slice(0, 40)}": use ${PI_ROLES.join(", ")}; no HolyAgent context was added, and the session is held to the root's tools and prompt`
  }
}

/** The collection did not finish within its overall deadline. */
class DeadlineExceeded extends Data.TaggedError("DeadlineExceeded")<{ readonly ms: number }> {
  /** The description shown to the user. */
  override get message() {
    return `the status took longer than ${this.ms / 1000}s and was stopped`
  }
}

/** What the next run is told: a message and whether the user sees it. */
interface Delivery {
  readonly customType: typeof CONTEXT_MESSAGE | typeof NOTICE_MESSAGE
  readonly content: string
  readonly display: boolean
}

/** What one collection yields: what the next run is told, and the settings the config decides. */
interface Collected {
  /**
   * False once the config is read and `pi.enable` is off, which adds no context and no settings;
   * only the root's prompt and exclusions remain, unless the user's own config is off.
   */
  readonly enabled?: false
  /**
   * True once the user-level config, read alone, has `pi.enable` off: the only thing that switches
   * the tool gates off. A project's config cannot, since a cloned repository would then lift the
   * guard.
   */
  readonly gatesOff?: true
  readonly delivery?: Delivery
  /**
   * Present when the user-level config, read alone, could not be read: the root then keeps only the
   * defaults' exclusions, and the next run says so beside the other notices.
   */
  readonly homeNotice?: Delivery
  /**
   * The process-wide variables the config decides (`PI_CODEMODE_MAX_WORKERS`), present once the
   * config is read and `pi.enable` is on.
   */
  readonly environment?: Readonly<Record<string, string>>
  /**
   * The variables the selected provider needs (its region), present with `environment`; they apply
   * to the root and to every child, since the provider is used by both.
   */
  readonly providerEnvironment?: Readonly<Record<string, string>>
  /** True for the root once the config is read and `pi.enable` is on: it gets the root prompt. */
  readonly rootPrompt?: true
  /** The root's tool selection, present for the root once the config is read and `pi.enable` is on. */
  readonly tools?: Pick<ToolArgs, "tools" | "excludeTools">
  /** The config the provider checks read, present for the root after a collection that ended well. */
  readonly config?: Config
}

/**
 * What a session holds from its start until its shutdown: the way to stop the commands of its
 * current collection, and its result. The collections that still run are tracked apart, since a
 * stopped one is no longer current.
 */
interface Held {
  current: AbortController | undefined
  pending: Promise<Collected | undefined> | undefined
  /**
   * True once a collection has read the user-level config and found `pi.enable` off. A config that
   * could not be read, and a project config that says off alone, leave the gates on.
   */
  gatesOff: boolean
  /**
   * True once a collection has found the root with `pi.enable` on or off in a project's config
   * alone: every run gets the root prompt. Only the user's `pi.enable: false` takes it away.
   */
  rootPrompt: boolean
  /**
   * The patterns of the tools the root may not call: the defaults' from the session's start, then
   * the union of the defaults', the user's and the merged config's, or the defaults' when the
   * config cannot be read. Empty for every other session and with the user's `pi.enable` off.
   */
  excluded: ReadonlyArray<string>
  /**
   * True once the work of a session's start (the root's tools and the provider checks) has run. The
   * first collection that ends does it, whether it is the start's or a compaction's that stopped
   * the start's, so it runs once.
   */
  started: boolean
  /** Stops the provider checks of the session. */
  probe: AbortController | undefined
  /** The notice the provider checks produced, until the next run delivers it. */
  readiness: Delivery | undefined
  /**
   * The notice about the session's setup, until the next run delivers it: the root's tools were not
   * applied, the user-level config could not be read, or both in one line.
   */
  setupNotice: Delivery | undefined
}

/**
 * The tools the root may not use under every config given, each once: a config can add an exclusion
 * but never take away another's, so turning a feature off in a project (computer use, a web mode)
 * cannot lift the tools its packages still register.
 */
const rootExclusions = (configs: ReadonlyArray<Config>): ReadonlyArray<string> => [
  ...new Set(configs.flatMap((config) => toolArgs(config, "root").excludeTools)),
]

/**
 * What a config decides for a session of `role`: the worker cap and the provider's variables for
 * every role, and for the root also its prompt and its tool selection. The root's exclusions are
 * those of `config` and of `bound`, the configs whose exclusions it keeps whatever `config` says
 * (the defaults and the user's).
 */
const settingsFor = (
  config: Config,
  role: PiRole,
  bound: ReadonlyArray<Config> = [],
): Collected => {
  const rootArgs = toolArgs(config, "root")
  return {
    environment: rootArgs.env,
    providerEnvironment: providerEnv(config),
    ...(role === "root"
      ? {
          rootPrompt: true,
          tools: {
            tools: rootArgs.tools,
            excludeTools: rootExclusions([config, ...bound]),
          },
        }
      : {}),
  }
}

/**
 * Refuses a call to a tool the root may not use. Taking a tool out of the active set does not stop
 * a `codemode` script from calling it: Pi lets a script call every registered tool whose exposure
 * is `codemode` or `deferred`, active or not, which is how the computer-use tools beyond the core
 * set and `pi-web-kit`'s web tools are registered. Pi runs a script's call through `tool_call`
 * (with a `parentToolCallId`), so the same gate stops the call from a script, from `tool_search`
 * once it activates the tool, and from the model. `excluded` is the root's `--exclude-tools`
 * patterns; it is empty for every other session. Returns the `tool_call` result that blocks the
 * call, or undefined to let it run.
 */
export const refuseExcludedTool = (
  event: { readonly toolName: string },
  excluded: ReadonlyArray<string>,
): ToolCallEventResult | undefined =>
  excluded.some((pattern) => toolMatches(pattern, event.toolName))
    ? {
        block: true,
        reason: `The root may not use ${event.toolName}. Delegate the work to a specialist that has it.`,
      }
    : undefined

/** Where the extension finds what it runs. */
export interface ExtensionOptions {
  /**
   * The folder of the installed package, which holds `scripts/holyagent`; the extension's own by
   * default.
   */
  readonly packageRoot?: string
  /** The overall deadline of one collection in milliseconds; {@link SESSION_DEADLINE_MS} by default. */
  readonly deadlineMs?: number
  /**
   * The longest to wait for a stopped command to exit in milliseconds; {@link STOP_GRACE_MS} by
   * default.
   */
  readonly graceMs?: number
  /**
   * The environment the extension sets the `holyagent` and Pi variables in; the process's own by
   * default. A test passes its own, so the process keeps its variables.
   */
  readonly env?: Record<string, string | undefined>
  /**
   * The path module of the platform the package is installed on; the process's own by default. A
   * test passes `win32` to stand in for Windows.
   */
  readonly platformPath?: Pick<typeof nodePath, "join" | "sep">
}

/**
 * The wrapper script of an installed package, written with `/` only. The shell reads a `$0` without
 * a `/` as a bare name and refuses it, which a Windows path (`C:\pkg\scripts\holyagent`) is; Git
 * for Windows' `sh` takes the `C:/pkg/scripts/holyagent` form. The path module is a parameter so a
 * test can stand in for Windows.
 */
export const wrapperPath = (
  packageRoot: string,
  platformPath: Pick<typeof nodePath, "join" | "sep"> = nodePath,
): string => toPosix(platformPath.join(packageRoot, "scripts", "holyagent"), platformPath.sep)

// A notice is built from text a project or Pi printed, so it loses its control characters.
const oneLine = (text: string): string => printable(text).replace(/\s+/g, " ").trim()

const notice = (text: string): Delivery => ({
  customType: NOTICE_MESSAGE,
  content: `holyagent: ${oneLine(text).slice(0, NOTICE_CHARS)}`,
  display: true,
})

// Two notices in one, so that a handler that returns one message can deliver both.
const joinNotices = (first: Delivery | undefined, second: Delivery): Delivery => {
  const added = second.content.replace(/^holyagent: /, "")
  return first === undefined
    ? second
    : first.content.includes(added)
      ? first
      : { ...first, content: `${first.content}; ${added}` }
}

// What `git rev-parse` says, with exit 128, outside a repository.
const NOT_A_REPOSITORY = /not a git repository/i

// What Node says when a program cannot be started, which Pi's exec passes on as exit 1.
const SPAWN_FAILURE = /^spawn \S+ E[A-Z0-9]+$/

const reasonOf = (result: ExecResult): string => {
  if (result.killed) return "it timed out or was stopped"
  const line = result.stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "")
  return line === undefined ? `exit ${result.code}` : line.replace(/^error: /, "")
}

// Ends once the promise settles, or after the grace, whichever comes first.
const exited = (settled: Promise<unknown>, graceMs: number): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    const timer = setTimeout(() => resume(Effect.void), graceMs)
    void settled.then(() => {
      clearTimeout(timer)
      resume(Effect.void)
    })
    return Effect.sync(() => clearTimeout(timer))
  })

/**
 * Builds the extension factory. Pi calls the factory with the extension API once per load; the
 * factory registers the launch flag and its handlers and starts nothing. `session_start` takes what
 * the session needs (a way to stop its commands, and the context it collects), `session_shutdown`
 * gives it back, and the result reaches the model as a message on its next run.
 */
export const createExtension =
  ({
    packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
    deadlineMs = SESSION_DEADLINE_MS,
    graceMs = STOP_GRACE_MS,
    env = process.env,
    platformPath = nodePath,
  }: ExtensionOptions = {}) =>
  (pi: ExtensionAPI): void => {
    const wrapper = wrapperPath(packageRoot, platformPath)
    // The text the model reads names the package folder with `/` only, for the same reason.
    const root = toPosix(packageRoot, platformPath.sep)
    const isChild = () => childAgent(pi.getSessionName()) !== undefined
    let held: Held | undefined
    // Every collection started and not yet ended, the stopped ones included: their commands are
    // children of this process until they exit, and the shutdown waits for all of them.
    const running = new Set<Promise<void>>()

    // Every program starts in the package's own folder, never the project's: on Windows a bare
    // `sh` or `git` is looked up in the working directory first, where a project could plant one.
    // The project is named in the arguments instead.
    //
    // A command that is stopped (the deadline, a sibling that failed, a newer collection or the
    // shutdown) is awaited: the effect ends only once Pi's exec has settled, or the grace has passed
    // for a process that does not exit, so no process outlives the gather. On Windows a process still
    // running holds its working directory, here the project's. A start that throws is a failed
    // command too.
    const exec = (signal: AbortSignal, command: string, args: ReadonlyArray<string>) => {
      const failed = (reason: string) => new CommandFailed({ command: args.join(" "), reason })
      type Answer = Effect.Effect<ExecResult, CommandFailed>
      return signal.aborted
        ? Effect.fail(failed("it was stopped"))
        : Effect.acquireUseRelease(
            Effect.try({
              try: () => {
                const stop = new AbortController()
                const settled = pi
                  .exec(command, [...args], {
                    cwd: packageRoot,
                    signal: AbortSignal.any([signal, stop.signal]),
                    timeout: COMMAND_TIMEOUT_MS,
                  })
                  .then<Answer, Answer>(
                    (result) => Effect.succeed(result),
                    (cause) => Effect.fail(failed(String(cause))),
                  )
                return { stop, settled }
              },
              catch: (cause) => failed(String(cause)),
            }),
            ({ settled }) =>
              Effect.callback<ExecResult, CommandFailed>((resume) => {
                void settled.then((answer) => resume(answer))
                const stopped = () => resume(Effect.fail(failed("it was stopped")))
                if (signal.aborted) stopped()
                signal.addEventListener("abort", stopped, { once: true })
                return Effect.sync(() => signal.removeEventListener("abort", stopped))
              }),
            ({ stop, settled }, exit) => {
              // A command that answered has exited; any other end stops it and waits for its exit.
              if (Exit.isSuccess(exit)) return Effect.void
              stop.abort()
              return exited(settled, graceMs)
            },
          )
    }

    // The wrapper runs the package's bundled runtime with Bun, which enters the project first; its
    // stdout is the command's output.
    const holyagent = (signal: AbortSignal, project: string, ...args: ReadonlyArray<string>) =>
      exec(signal, "sh", [wrapper, PI_PROJECT_FLAG, project, ...args]).pipe(
        Effect.flatMap((result) =>
          result.code === 0 && !result.killed
            ? Effect.succeed(result.stdout)
            : Effect.fail(new CommandFailed({ command: args.join(" "), reason: reasonOf(result) })),
        ),
      )

    // The top of the work tree holds the project's config; outside git the project folder does, and
    // so does its state. Only git's own answer that the folder is not in a repository means "not
    // git": a timeout, a refusal over ownership or a missing git would otherwise put a project in a
    // work tree under the wrong config, so those fail closed as the notice. Git exits 128 for every
    // fatal error and says which in English unless its locale is set otherwise, so a localized git
    // fails closed too.
    const topOf = (signal: AbortSignal, project: string) =>
      exec(signal, "git", ["-C", project, "rev-parse", "--show-toplevel"]).pipe(
        Effect.flatMap((result) => {
          const top = result.stdout.trim()
          if (result.code === 0 && !result.killed && top !== "")
            return Effect.succeed({ top, git: true })
          return !result.killed && result.code === 128 && NOT_A_REPOSITORY.test(result.stderr)
            ? Effect.succeed({ top: project, git: false })
            : Effect.fail(
                new CommandFailed({
                  command: "git rev-parse --show-toplevel",
                  reason: reasonOf(result),
                }),
              )
        }),
      )

    // The folder that holds the project's state: the one `holyagent state mode` reports in a git
    // work tree, and `.holyagent` of the project outside git, where that command fails.
    const stateFolderOf = (
      signal: AbortSignal,
      project: string,
      located: { readonly top: string; readonly git: boolean },
    ) =>
      located.git
        ? holyagent(signal, project, "state", "mode").pipe(
            Effect.flatMap((text) => parseOutput("state mode", text)),
            Effect.map((where) => where["directory"]),
          )
        : Effect.succeed<unknown>(join(located.top, STATE_DIRECTORY))

    // The configs whose exclusions the root keeps whatever the merged config says.
    const boundConfigs = (defaults: Config, user: Config | undefined): ReadonlyArray<Config> =>
      user === undefined ? [defaults] : [defaults, user]

    const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config), {
      onExcessProperty: "error",
    })

    // The session's role: a child the package launched is a specialist whatever the flag says, since
    // the flag defaults to the root in every Pi session and a child has no launch line of its own.
    const roleOf = Effect.suspend(() => {
      const flag = isChild() ? "specialist" : (pi.getFlag(ROLE_FLAG) ?? DEFAULT_PI_ROLE)
      return Schema.decodeUnknownEffect(PiRoleSchema)(flag).pipe(
        Effect.mapError(() => new UnknownRole({ value: String(flag) })),
      )
    })

    // What a failed collection leaves the session when the config decided nothing: the settings of
    // the defaults, so that the root keeps its prompt and its tool exclusions and a config nobody
    // can read cannot lift them. A role that cannot be read is the default role, the root. `config`
    // is the one that was read, when the failure came after it.
    const closedSettings = (
      config: Config | undefined,
      user: Config | undefined,
    ): Effect.Effect<Collected> =>
      Effect.gen(function* () {
        const role = yield* roleOf.pipe(Effect.orElseSucceed((): PiRole => DEFAULT_PI_ROLE))
        const defaults = yield* defaultConfig
        return settingsFor(config ?? defaults, role, boundConfigs(defaults, user))
      }).pipe(Effect.orDie)

    // The root's exclusions before any config is known: the defaults', so a run in flight while a
    // reload, resume or fork collects is gated. Other roles have none.
    const startingExclusions = Effect.gen(function* () {
      const role = yield* roleOf.pipe(Effect.orElseSucceed((): PiRole => DEFAULT_PI_ROLE))
      return role === "root" ? rootExclusions([yield* defaultConfig]) : []
    }).pipe(Effect.orDie)

    const collect = (cwd: string, signal: AbortSignal, reason: Reason) => {
      // What the config decided, kept once known so a later failure of the collection (the status
      // command, the deadline) still leaves the root its prompt, tools and provider settings.
      let configured: Collected | undefined
      let read: Config | undefined
      let user: Config | undefined
      let homeNotice: Delivery | undefined
      const failed = (text: string): Effect.Effect<Collected> =>
        (configured === undefined ? closedSettings(read, user) : Effect.succeed(configured)).pipe(
          Effect.map((kept): Collected => ({ ...kept, delivery: notice(text) })),
        )
      return Effect.gen(function* () {
        // Every command starts in the package's folder, so a relative `cwd` would resolve against
        // that folder, not the project's: it is made absolute here, once.
        const project = resolve(cwd)
        const located = yield* topOf(signal, project)
        // The loader reads files with Bun, which Pi's Node does not have, so the wrapper loads it.
        // The state folder does not depend on the config or on `status`, so it is asked meanwhile;
        // its failure counts only once the config says the extension is on.
        // The user's own file is read alone (no project folder) beside the merged config: only it
        // may lift the gates, and its exclusions stay whatever a project says. It is recorded as
        // soon as it is read, apart from the merged config and the state folder, whose failure
        // stops the folder command but must not stop this read. A file that cannot be read counts
        // for nothing, which leaves the gates on and the defaults' exclusions, and is reported.
        const [attempt] = yield* Effect.all(
          [
            Effect.result(
              Effect.all(
                [
                  holyagent(signal, project, "config", join(located.top, STATE_DIRECTORY)).pipe(
                    Effect.flatMap(decodeConfig),
                  ),
                  Effect.result(stateFolderOf(signal, project, located)),
                ],
                { concurrency: "unbounded" },
              ),
            ),
            holyagent(signal, project, "config").pipe(
              Effect.flatMap(decodeConfig),
              Effect.map((own) => {
                user = own
              }),
              Effect.catch((error) =>
                Effect.sync(() => {
                  homeNotice = notice(`the home-level config could not be read: ${error.message}`)
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        )
        const [config, folder] = yield* Effect.fromResult(attempt)
        read = config
        const bound = boundConfigs(yield* defaultConfig, user)
        if (!config.pi.enable) {
          if (user !== undefined && !user.pi.enable)
            return { enabled: false, gatesOff: true } satisfies Collected
          // Only the user's `pi.enable: false` stands the root's guard down; a project's adds no
          // context and no settings, and leaves the root its prompt and its exclusions.
          const off = settingsFor(
            config,
            yield* roleOf.pipe(Effect.orElseSucceed((): PiRole => DEFAULT_PI_ROLE)),
            bound,
          )
          return {
            enabled: false,
            ...(off.rootPrompt === undefined ? {} : { rootPrompt: off.rootPrompt }),
            ...(off.tools === undefined ? {} : { tools: off.tools }),
          } satisfies Collected
        }
        const role = yield* roleOf
        configured = settingsFor(config, role, bound)
        // Status first, then reconcile: for a project that keeps state, status makes the state
        // worktree that the next calls read.
        const status = yield* holyagent(signal, project, "status").pipe(
          Effect.flatMap((text) => parseOutput("status", text)),
        )
        const reconcile = RECONCILED.has(reason)
          ? yield* holyagent(signal, project, "reconcile").pipe(
              Effect.flatMap((text) => parseOutput("reconcile", text)),
            )
          : undefined
        const directory = yield* Effect.fromResult(folder)
        const state: ProjectState | undefined =
          typeof directory === "string" && (yield* hasStateFolder(directory))
            ? { status, ...(reconcile === undefined ? {} : { reconcile }) }
            : undefined
        const content = piContext(role, root, state)
        // The provider is checked only after a collection that ended well: a failed one already
        // carries a notice, and the checks would start commands after its deadline.
        const ended = { ...configured, ...(role === "root" ? { config } : {}) }
        return content === undefined
          ? ({ ...ended } satisfies Collected)
          : ({
              ...ended,
              delivery: { customType: CONTEXT_MESSAGE, content, display: false },
            } satisfies Collected)
      }).pipe(
        // Every command of the collection shares one deadline, as the Claude hook has one timeout.
        Effect.timeoutOrElse({
          duration: deadlineMs,
          orElse: () => Effect.fail(new DeadlineExceeded({ ms: deadlineMs })),
        }),
        // A failure adds one line and never reaches Pi; the settings stay as far as they are known,
        // and are the defaults' when the config could not be read (see closedSettings).
        Effect.catch((error) => failed(error.message)),
        Effect.catchCause((cause) => failed(Cause.pretty(cause))),
        Effect.map((collected): Collected =>
          homeNotice === undefined ? collected : { ...collected, homeNotice },
        ),
      )
    }

    // Safe to call twice, and with nothing held. The promise settles once every collection ever
    // started has ended, the ones of an older start or compaction included, and every child they
    // started has exited or its stop grace (STOP_GRACE_MS, the graceMs option) has passed.
    const release = (): Promise<void> => {
      const taken = held
      held = undefined
      taken?.current?.abort()
      taken?.probe?.abort()
      return Effect.runPromise(
        Effect.forEach([...running], (ended) => Effect.promise(() => ended), {
          concurrency: "unbounded",
          discard: true,
        }),
      )
    }

    // The notice for a provider that is not ready or lacks a route's model, or undefined when the
    // provider is fine or could not be asked. The checks are Pi's own CLI probes (`pi auth check`,
    // `pi --list-models`), run through `pi.exec` since the extension runs under Node and has no
    // Bun Shell. A probe that did not start, was stopped or timed out says nothing about the
    // provider, so it adds no notice; the probes have one deadline of their own, of the collection's
    // length, which bounds both together. They run with the provider's variables already applied,
    // since Pi's exec starts them with the process environment.
    const checkProvider = (signal: AbortSignal, config: Config) => {
      let unanswered = false
      const run: CommandRunner = (command, args) =>
        exec(signal, command, args).pipe(
          Effect.map((result) => {
            // Pi's exec reports a program that did not start (a missing `pi`) as exit 1 with the
            // spawn error on standard error, which `pi auth check` would read as "not logged in".
            const unstarted =
              result.code === 1 && result.stdout === "" && SPAWN_FAILURE.test(result.stderr.trim())
            unanswered ||= result.killed || unstarted
            return {
              exitCode: unstarted ? 127 : result.code,
              stdout: result.stdout,
              stderr: result.stderr,
            }
          }),
          Effect.catch(() => {
            unanswered = true
            return Effect.succeed({ exitCode: 127, stdout: "", stderr: "" })
          }),
        )
      return requireProviderReady(run, config).pipe(
        Effect.andThen(validateModelCatalog(run, config)),
        Effect.as<Delivery | undefined>(undefined),
        // Only the provider's own blockers are reported; a listing that failed or was not
        // recognised is not a statement about the provider.
        Effect.catch((error) =>
          Effect.succeed(
            !unanswered &&
              (error._tag === "ProviderNotReady" ||
                error._tag === "ProviderInvalid" ||
                error._tag === "ModelsNotInCatalog")
              ? notice(error._tag === "ModelsNotInCatalog" ? error.brief : error.message)
              : undefined,
          ),
        ),
        Effect.timeoutOrElse({ duration: deadlineMs, orElse: () => Effect.succeed(undefined) }),
      )
    }

    // Runs the provider checks beside the session: startup never waits for them, and the notice
    // reaches the first run that starts after they end.
    const startProviderCheck = (taken: Held, config: Config) => {
      taken.probe?.abort()
      const own = new AbortController()
      taken.probe = own
      const ended = Effect.runPromise(checkProvider(own.signal, config)).then((delivery) => {
        if (!own.signal.aborted) taken.readiness = delivery
      })
      running.add(ended)
      void ended.then(() => running.delete(ended))
    }

    // The root's tools: its active selection plus its own tools, minus its excluded ones. A
    // failure is a notice, not an error that reaches Pi.
    const applyRootTools = (tools: NonNullable<Collected["tools"]>): Delivery | undefined =>
      Effect.runSync(
        Effect.try({
          try: () =>
            pi.setActiveTools([
              ...rootActiveTools(
                tools,
                pi.getActiveTools(),
                pi.getAllTools().map(({ name }) => name),
              ),
            ]),
          catch: (cause) => notice(`the root's tools were not applied: ${String(cause)}`),
        }).pipe(
          Effect.as<Delivery | undefined>(undefined),
          Effect.catch((failure) => Effect.succeed(failure)),
        ),
      )

    // A newer collection stops the older one, and the result of a stopped one is dropped: nobody
    // reads it, and a session that ended has nothing to be told. The root's tools and provider
    // checks belong to a session's start, so they run once, from the first collection that ends:
    // a compaction that ends after the start's collection must not undo a change the user made to
    // the tools since, and one that stopped the start's collection must not skip them. The provider's
    // variables are applied before the checks start, since the checks inherit the environment.
    const gather = (taken: Held, ctx: ExtensionContext, reason: Reason): Promise<void> => {
      taken.current?.abort()
      const own = new AbortController()
      taken.current = own
      const collected = Effect.runPromise(collect(ctx.cwd, own.signal, reason))
      const ended = collected.then(() => undefined)
      running.add(ended)
      void ended.then(() => running.delete(ended))
      taken.pending = collected.then((result) => {
        if (own.signal.aborted) return undefined
        taken.gatesOff = result?.gatesOff === true
        if (result?.rootPrompt === true) taken.rootPrompt = true
        else if (result?.enabled === false) taken.rootPrompt = false
        if (result?.tools !== undefined) taken.excluded = result.tools.excludeTools
        else if (result?.enabled === false) taken.excluded = []
        if (result?.providerEnvironment !== undefined)
          applyEnvironment(env, result.providerEnvironment, true)
        if (!taken.started && result?.enabled !== false) {
          taken.started = true
          if (result?.config !== undefined) startProviderCheck(taken, result.config)
          if (result?.tools !== undefined) taken.setupNotice = applyRootTools(result.tools)
        }
        if (result?.homeNotice !== undefined)
          taken.setupNotice = joinNotices(taken.setupNotice, result.homeNotice)
        return result
      })
      return taken.pending.then(() => undefined)
    }

    pi.registerFlag(ROLE_FLAG, {
      description: `What this session is for: ${PI_ROLES.join(", ")} (default ${DEFAULT_PI_ROLE})`,
      type: "string",
      default: DEFAULT_PI_ROLE,
    })

    pi.on("session_start", (event, ctx) => {
      void release()
      held = {
        current: undefined,
        pending: undefined,
        gatesOff: false,
        rootPrompt: false,
        excluded: Effect.runSync(startingExclusions),
        started: false,
        probe: undefined,
        readiness: undefined,
        setupNotice: undefined,
      }
      return gather(held, ctx, event.reason)
    })

    pi.on("session_compact", (_event, ctx) =>
      held === undefined ? undefined : gather(held, ctx, "compact"),
    )

    // The message is delivered once: the run that reads it takes it, and the next start or
    // compaction brings a new one. The root's system prompt is the HolyAgent root prompt, in front
    // of Pi's own, on every run; the prompt of other sessions is never touched. It goes in front
    // rather than in place of Pi's, because Pi's prompt carries what the Claude root keeps through
    // its memory files: the project's AGENTS.md, the skills list, the date and the working folder.
    // Before each run of the root the host variables are written, since the `holyagent` calls of
    // the run read them and the active tools can change; the settings the config decides are
    // written once, when the config is known, and a variable the user set stays. The provider's
    // variables go to every session, root or child, since both use the provider, but are written when
    // the collection ends (see gather), ahead of the provider checks. A child fills the package
    // folder into its prompt instead and leaves the rest of the environment to the root.
    pi.on(
      "before_agent_start",
      (
        event,
      ):
        | Promise<BeforeAgentStartEventResult | undefined>
        | BeforeAgentStartEventResult
        | undefined => {
        const child = isChild()
        if (!child) applyEnvironment(env, hostEnvironment(pi.getActiveTools()), false)
        const filled = child
          ? fillPackageRoot(event.systemPrompt, packageRoot, platformPath)
          : undefined
        const taken = held
        const pending = taken?.pending
        if (taken !== undefined) taken.pending = undefined
        const result = (
          collected: Collected | undefined,
        ): BeforeAgentStartEventResult | undefined => {
          if (!child && collected?.environment !== undefined)
            applyEnvironment(env, { ...collected.environment, [CACHE_RETENTION_ENV]: "long" }, true)
          const rooted =
            !child && taken?.rootPrompt === true
              ? `${fillPackageRoot(PI_ROOT_PROMPT, packageRoot, platformPath)}\n\n${event.systemPrompt}`
              : undefined
          const prompt = rooted ?? filled
          const override =
            prompt === undefined || prompt === event.systemPrompt ? {} : { systemPrompt: prompt }
          const message = collected?.delivery
          return message === undefined && Object.keys(override).length === 0
            ? undefined
            : { ...(message === undefined ? {} : { message }), ...override }
        }
        return pending === undefined ? result(undefined) : pending.then(result)
      },
    )

    // The root's notices are their own messages, one per handler since a handler returns one, so
    // they never replace the context or each other. The setup notice is ready after the start's
    // collection; the provider notice comes from the checks that run beside the session, so it
    // reaches the first run that starts after they end. Each is delivered once.
    const noticeOnce =
      (slot: "readiness" | "setupNotice") => (): BeforeAgentStartEventResult | undefined => {
        const message = isChild() ? undefined : held?.[slot]
        if (held !== undefined) held[slot] = undefined
        return message === undefined ? undefined : { message }
      }
    pi.on("before_agent_start", noticeOnce("setupNotice"))
    pi.on("before_agent_start", noticeOnce("readiness"))

    // Only a specialist the package launched is held to a complete report.
    pi.on("message_end", (event) => {
      if (!isChild()) return undefined
      const message = failedFinalMessage(event.message)
      return message === undefined ? undefined : { message }
    })

    // Pi draws a call while the model still streams it, before the gate below sees the script, and
    // the package's own drawing of a workflow call evaluates the script's meta fragment on the host.
    // The drawing is replaced for every session, since the render path runs ahead of any gate.
    pi.registerToolRenderer(workflowRenderers)

    // The gates stand down only for the user's own `pi.enable: false`; a project's cannot lift them,
    // nor take an exclusion away. The root's excluded tools are refused first, whatever else the call is.
    pi.on("tool_call", (event) =>
      held?.gatesOff === true
        ? undefined
        : (refuseExcludedTool(event, held?.excluded ?? []) ??
          Effect.runPromise(
            refuseNonSpecialistWorkflow(event).pipe(
              Effect.map((refusal) => refuseNonSpecialist(event) ?? refusal),
            ),
          )),
    )

    // Pi finishes the shutdown when the handler's promise settles, and the folder may be removed
    // then: it settles only after every child has exited or its stop grace (STOP_GRACE_MS, 2 s,
    // the graceMs option) has passed.
    pi.on("session_shutdown", () => release())
  }

/**
 * The HolyAgent extension for Pi. Pi calls this factory when it loads the package and passes the
 * extension API. It registers the `--holyagent-role` flag and its handlers and starts no process,
 * socket, watcher or timer; see {@link createExtension}.
 */
export default createExtension()
