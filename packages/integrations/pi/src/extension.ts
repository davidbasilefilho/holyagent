import nodePath, { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  BeforeAgentStartEventResult,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  MessageEndEventResult,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent"
import { Cause, Data, Effect, Exit, Schema } from "effect"

import { workflowRefusal } from "../../../runtime/src/cli/workflow-check.ts"
import { Config } from "../../../runtime/src/config/schema.ts"
import { toPosix } from "../../../runtime/src/domain/paths.ts"
import {
  DEFAULT_PI_ROLE,
  parseOutput,
  PI_ROLES,
  PI_ROOT_PLACEHOLDER,
  piContext,
  PiRoleSchema,
  type ProjectState,
} from "../../../runtime/src/hooks/pi-context.ts"
import { PI_PROJECT_FLAG } from "../../../runtime/src/hooks/pi-project.ts"
import { hasStateFolder } from "../../../runtime/src/hooks/state-folder.ts"
import { toolArgs } from "../../../runtime/src/pi/tools.ts"
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
    return `unknown --${ROLE_FLAG} value "${this.value.slice(0, 40)}": use ${PI_ROLES.join(", ")}; no HolyAgent context was added`
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
  /** False once the config is read and `pi.enable` is off, which adds no context and no settings. */
  readonly enabled?: false
  /**
   * True once the user-level config, read alone, has `pi.enable` off: the only thing that switches
   * the tool gates off. A project's config cannot, since a cloned repository would then lift the
   * guard.
   */
  readonly gatesOff?: true
  readonly delivery?: Delivery
  /**
   * The process-wide variables the config decides (`PI_CODEMODE_MAX_WORKERS`), present once the
   * config is read and `pi.enable` is on.
   */
  readonly environment?: Readonly<Record<string, string>>
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
}

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

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

const notice = (text: string): Delivery => ({
  customType: NOTICE_MESSAGE,
  content: `holyagent: ${oneLine(text).slice(0, NOTICE_CHARS)}`,
  display: true,
})

// What `git rev-parse` says, with exit 128, outside a repository.
const NOT_A_REPOSITORY = /not a git repository/i

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

    const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(Config), {
      onExcessProperty: "error",
    })

    const collect = (cwd: string, signal: AbortSignal, reason: Reason) =>
      Effect.gen(function* () {
        // Every command starts in the package's folder, so a relative `cwd` would resolve against
        // that folder, not the project's: it is made absolute here, once.
        const project = resolve(cwd)
        const located = yield* topOf(signal, project)
        // The loader reads files with Bun, which Pi's Node does not have, so the wrapper loads it.
        // The state folder does not depend on the config or on `status`, so it is asked meanwhile;
        // its failure counts only once the config says the extension is on.
        const [config, folder] = yield* Effect.all(
          [
            holyagent(signal, project, "config", join(located.top, STATE_DIRECTORY)).pipe(
              Effect.flatMap(decodeConfig),
            ),
            Effect.result(stateFolderOf(signal, project, located)),
          ],
          { concurrency: "unbounded" },
        )
        if (!config.pi.enable) {
          // The merged config says off; only the user's own file may also lift the gates, so it is
          // read alone (no project folder). A file that cannot be read leaves them on.
          const userOff = yield* holyagent(signal, project, "config").pipe(
            Effect.flatMap(decodeConfig),
            Effect.map((user) => !user.pi.enable),
            Effect.orElseSucceed(() => false),
          )
          return (
            userOff ? { enabled: false, gatesOff: true } : { enabled: false }
          ) satisfies Collected
        }
        // A child the package launched is a specialist whatever the flag says: the flag defaults to
        // the root in every Pi session, and a child has no launch line of its own.
        const flag = isChild() ? "specialist" : (pi.getFlag(ROLE_FLAG) ?? DEFAULT_PI_ROLE)
        const role = yield* Schema.decodeUnknownEffect(PiRoleSchema)(flag).pipe(
          Effect.mapError(() => new UnknownRole({ value: String(flag) })),
        )
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
        const environment = toolArgs(config, "root").env
        return content === undefined
          ? ({ environment } satisfies Collected)
          : ({
              delivery: { customType: CONTEXT_MESSAGE, content, display: false },
              environment,
            } satisfies Collected)
      }).pipe(
        // Every command of the collection shares one deadline, as the Claude hook has one timeout.
        Effect.timeoutOrElse({
          duration: deadlineMs,
          orElse: () => Effect.fail(new DeadlineExceeded({ ms: deadlineMs })),
        }),
        // A failure adds one line and nothing else, and never reaches Pi.
        Effect.catch((error) =>
          Effect.succeed<Collected | undefined>({ delivery: notice(error.message) }),
        ),
        Effect.catchCause((cause) =>
          Effect.succeed<Collected | undefined>({ delivery: notice(Cause.pretty(cause)) }),
        ),
      )

    // Safe to call twice, and with nothing held. The promise settles once every collection ever
    // started has ended, the ones of an older start or compaction included, and every child they
    // started has exited or its stop grace (STOP_GRACE_MS, the graceMs option) has passed.
    const release = (): Promise<void> => {
      const taken = held
      held = undefined
      taken?.current?.abort()
      return Effect.runPromise(
        Effect.forEach([...running], (ended) => Effect.promise(() => ended), {
          concurrency: "unbounded",
          discard: true,
        }),
      )
    }

    // A newer collection stops the older one, and the result of a stopped one is dropped: nobody
    // reads it, and a session that ended has nothing to be told.
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
      held = { current: undefined, pending: undefined, gatesOff: false }
      return gather(held, ctx, event.reason)
    })

    pi.on("session_compact", (_event, ctx) =>
      held === undefined ? undefined : gather(held, ctx, "compact"),
    )

    // The message is delivered once: the run that reads it takes it, and the next start or
    // compaction brings a new one. The system prompt of the root and of other sessions is never
    // touched. Before each run of the root the host variables are written, since the `holyagent`
    // calls of the run read them and the active tools can change; the settings the config decides
    // are written once, when the config is known. A child fills the package folder into its
    // prompt instead and leaves the process environment to the root.
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
        const override =
          filled === undefined || filled === event.systemPrompt ? {} : { systemPrompt: filled }
        const taken = held
        const pending = taken?.pending
        if (taken !== undefined) taken.pending = undefined
        const result = (
          collected: Collected | undefined,
        ): BeforeAgentStartEventResult | undefined => {
          if (!child && collected?.environment !== undefined)
            applyEnvironment(env, { ...collected.environment, [CACHE_RETENTION_ENV]: "long" }, true)
          const message = collected?.delivery
          return message === undefined && Object.keys(override).length === 0
            ? undefined
            : { ...(message === undefined ? {} : { message }), ...override }
        }
        return pending === undefined ? result(undefined) : pending.then(result)
      },
    )

    // Only a specialist the package launched is held to a complete report.
    pi.on("message_end", (event) => {
      if (!isChild()) return undefined
      const message = failedFinalMessage(event.message)
      return message === undefined ? undefined : { message }
    })

    // The gates stand down only for the user's own `pi.enable: false`; a project's cannot lift them.
    pi.on("tool_call", (event) =>
      held?.gatesOff === true
        ? undefined
        : Effect.runPromise(
            refuseNonSpecialistWorkflow(event).pipe(
              Effect.map((refusal) => refuseNonSpecialist(event) ?? refusal),
            ),
          ),
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
