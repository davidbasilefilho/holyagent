import nodePath, { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  BeforeAgentStartEventResult,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Cause, Data, Effect, Exit, Schema } from "effect"

import { Config } from "../../../runtime/src/config/schema.ts"
import { toPosix } from "../../../runtime/src/domain/paths.ts"
import {
  DEFAULT_PI_ROLE,
  parseOutput,
  PI_ROLES,
  piContext,
  PiRoleSchema,
  type ProjectState,
} from "../../../runtime/src/hooks/pi-context.ts"
import { PI_PROJECT_FLAG } from "../../../runtime/src/hooks/pi-project.ts"
import { hasStateFolder } from "../../../runtime/src/hooks/state-folder.ts"
import { STATE_DIRECTORY } from "../../../runtime/src/state/layout.ts"

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

/**
 * What a session holds from its start until its shutdown: the way to stop the commands of its
 * current collection, and its result. The collections that still run are tracked apart, since a
 * stopped one is no longer current.
 */
interface Held {
  current: AbortController | undefined
  pending: Promise<Delivery | undefined> | undefined
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
  }: ExtensionOptions = {}) =>
  (pi: ExtensionAPI): void => {
    const wrapper = wrapperPath(packageRoot)
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
              Effect.flatMap(
                Schema.decodeUnknownEffect(Schema.fromJsonString(Config), {
                  onExcessProperty: "error",
                }),
              ),
            ),
            Effect.result(stateFolderOf(signal, project, located)),
          ],
          { concurrency: "unbounded" },
        )
        if (!config.pi.enable) return undefined
        const flag = pi.getFlag(ROLE_FLAG) ?? DEFAULT_PI_ROLE
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
        const content = piContext(role, packageRoot, state)
        return content === undefined
          ? undefined
          : ({ customType: CONTEXT_MESSAGE, content, display: false } satisfies Delivery)
      }).pipe(
        // Every command of the collection shares one deadline, as the Claude hook has one timeout.
        Effect.timeoutOrElse({
          duration: deadlineMs,
          orElse: () => Effect.fail(new DeadlineExceeded({ ms: deadlineMs })),
        }),
        // A failure adds one line and nothing else, and never reaches Pi.
        Effect.catch((error) => Effect.succeed<Delivery | undefined>(notice(error.message))),
        Effect.catchCause((cause) =>
          Effect.succeed<Delivery | undefined>(notice(Cause.pretty(cause))),
        ),
      )

    // Safe to call twice, and with nothing held. The promise settles once every collection ever
    // started has ended, the ones of an older start or compaction included, so no child of this
    // process is left when it resolves.
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
      taken.pending = collected.then((delivery) => (own.signal.aborted ? undefined : delivery))
      return taken.pending.then(() => undefined)
    }

    pi.registerFlag(ROLE_FLAG, {
      description: `What this session is for: ${PI_ROLES.join(", ")} (default ${DEFAULT_PI_ROLE})`,
      type: "string",
      default: DEFAULT_PI_ROLE,
    })

    pi.on("session_start", (event, ctx) => {
      void release()
      held = { current: undefined, pending: undefined }
      return gather(held, ctx, event.reason)
    })

    pi.on("session_compact", (_event, ctx) =>
      held === undefined ? undefined : gather(held, ctx, "compact"),
    )

    // The message is delivered once: the run that reads it takes it, and the next start or
    // compaction brings a new one. The system prompt is never touched.
    pi.on(
      "before_agent_start",
      (): Promise<BeforeAgentStartEventResult | undefined> | undefined => {
        const taken = held
        const pending = taken?.pending
        if (taken === undefined || pending === undefined) return undefined
        taken.pending = undefined
        return pending.then((delivery) =>
          delivery === undefined ? undefined : { message: delivery },
        )
      },
    )

    // Pi finishes the shutdown when the handler's promise settles, and the folder may be removed
    // then: it settles only after every child has exited.
    pi.on("session_shutdown", () => release())
  }

/**
 * The HolyAgent extension for Pi. Pi calls this factory when it loads the package and passes the
 * extension API. It registers the `--holyagent-role` flag and its handlers and starts no process,
 * socket, watcher or timer; see {@link createExtension}.
 */
export default createExtension()
