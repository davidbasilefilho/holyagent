import { stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type {
  BeforeAgentStartEventResult,
  ExecResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Cause, Data, Effect, Schema } from "effect"

import { Config } from "../../../runtime/src/config/schema.ts"
import {
  DEFAULT_PI_ROLE,
  parseOutput,
  PI_ROLES,
  piContext,
  PiRoleSchema,
  type ProjectState,
} from "../../../runtime/src/hooks/pi-context.ts"
import { hasCode, io } from "../../../runtime/src/state/files.ts"
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

/** What the next run is told: a message and whether the user sees it. */
interface Delivery {
  readonly customType: typeof CONTEXT_MESSAGE | typeof NOTICE_MESSAGE
  readonly content: string
  readonly display: boolean
}

/**
 * What a session holds from its start until its shutdown: the way to stop its commands, and its
 * result.
 */
interface Held {
  readonly stop: AbortController
  pending: Promise<Delivery | undefined> | undefined
}

/** Where the extension finds what it runs. */
export interface ExtensionOptions {
  /**
   * The folder of the installed package, which holds `scripts/holyagent`; the extension's own by
   * default.
   */
  readonly packageRoot?: string
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

const notice = (text: string): Delivery => ({
  customType: NOTICE_MESSAGE,
  content: `holyagent: ${oneLine(text).slice(0, NOTICE_CHARS)}`,
  display: true,
})

const reasonOf = (result: ExecResult): string => {
  if (result.killed) return "it timed out or was stopped"
  const line = result.stderr
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "")
  return line === undefined ? `exit ${result.code}` : line.replace(/^error: /, "")
}

/**
 * Builds the extension factory. Pi calls the factory with the extension API once per load; the
 * factory registers the launch flag and its handlers and starts nothing. `session_start` takes what
 * the session needs (a way to stop its commands, and the context it collects), `session_shutdown`
 * gives it back, and the result reaches the model as a message on its next run.
 */
export const createExtension =
  ({
    packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url))),
  }: ExtensionOptions = {}) =>
  (pi: ExtensionAPI): void => {
    const wrapper = join(packageRoot, "scripts", "holyagent")
    let held: Held | undefined

    const exec = (
      ctx: ExtensionContext,
      signal: AbortSignal,
      command: string,
      args: ReadonlyArray<string>,
    ) =>
      Effect.tryPromise({
        try: () =>
          pi.exec(command, [...args], { cwd: ctx.cwd, signal, timeout: COMMAND_TIMEOUT_MS }),
        catch: (cause) => new CommandFailed({ command: args.join(" "), reason: String(cause) }),
      })

    // The wrapper runs the package's bundled runtime with Bun; its stdout is the command's output.
    const holyagent = (
      ctx: ExtensionContext,
      signal: AbortSignal,
      ...args: ReadonlyArray<string>
    ) =>
      exec(ctx, signal, "sh", [wrapper, ...args]).pipe(
        Effect.flatMap((result) =>
          result.code === 0 && !result.killed
            ? Effect.succeed(result.stdout)
            : Effect.fail(new CommandFailed({ command: args.join(" "), reason: reasonOf(result) })),
        ),
      )

    // The top of the work tree holds the project's config; outside git the working directory does.
    const topOf = (ctx: ExtensionContext, signal: AbortSignal) =>
      exec(ctx, signal, "git", ["rev-parse", "--show-toplevel"]).pipe(
        Effect.map((result) => (result.code === 0 ? result.stdout.trim() : "")),
        Effect.orElseSucceed(() => ""),
        Effect.map((top) => (top === "" ? ctx.cwd : top)),
      )

    // A missing folder is false, not a failure.
    const folderExists = (directory: string) =>
      io(directory, () => stat(directory)).pipe(
        Effect.as(true),
        Effect.catchIf(
          (error) => hasCode(error.cause, "ENOENT"),
          () => Effect.succeed(false),
        ),
      )

    const collect = (ctx: ExtensionContext, signal: AbortSignal, reason: Reason) =>
      Effect.gen(function* () {
        // The loader reads files with Bun, which Pi's Node does not have, so the wrapper loads it.
        const config = yield* holyagent(
          ctx,
          signal,
          "config",
          join(yield* topOf(ctx, signal), STATE_DIRECTORY),
        ).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Config), {
              onExcessProperty: "error",
            }),
          ),
        )
        if (!config.pi.enable) return undefined
        const flag = pi.getFlag(ROLE_FLAG) ?? DEFAULT_PI_ROLE
        const role = yield* Schema.decodeUnknownEffect(PiRoleSchema)(flag).pipe(
          Effect.mapError(() => new UnknownRole({ value: String(flag) })),
        )
        // Status first: for a project that keeps state it makes the state worktree the next calls read.
        const [status, reconcile] = yield* Effect.all(
          [
            holyagent(ctx, signal, "status").pipe(
              Effect.flatMap((text) => parseOutput("status", text)),
            ),
            RECONCILED.has(reason)
              ? holyagent(ctx, signal, "reconcile").pipe(
                  Effect.flatMap((text) => parseOutput("reconcile", text)),
                )
              : Effect.succeed(undefined),
          ],
          { concurrency: "unbounded" },
        )
        const where = yield* holyagent(ctx, signal, "state", "mode").pipe(
          Effect.flatMap((text) => parseOutput("state mode", text)),
        )
        const directory = where["directory"]
        const state: ProjectState | undefined =
          typeof directory === "string" && (yield* folderExists(directory))
            ? { status, ...(reconcile === undefined ? {} : { reconcile }) }
            : undefined
        const content = piContext(role, packageRoot, state)
        return content === undefined
          ? undefined
          : ({ customType: CONTEXT_MESSAGE, content, display: false } satisfies Delivery)
      }).pipe(
        // A failure adds one line and nothing else, and never reaches Pi.
        Effect.catch((error) => Effect.succeed<Delivery | undefined>(notice(error.message))),
        Effect.catchCause((cause) =>
          Effect.succeed<Delivery | undefined>(notice(Cause.pretty(cause))),
        ),
      )

    // Safe to call twice, and with nothing held.
    const release = (): void => {
      const taken = held
      held = undefined
      taken?.stop.abort()
    }

    const gather = (taken: Held, ctx: ExtensionContext, reason: Reason): Promise<void> => {
      taken.pending = Effect.runPromise(collect(ctx, taken.stop.signal, reason))
      return taken.pending.then(() => undefined)
    }

    pi.registerFlag(ROLE_FLAG, {
      description: `What this session is for: ${PI_ROLES.join(", ")} (default ${DEFAULT_PI_ROLE})`,
      type: "string",
      default: DEFAULT_PI_ROLE,
    })

    pi.on("session_start", (event, ctx) => {
      release()
      held = { stop: new AbortController(), pending: undefined }
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

    pi.on("session_shutdown", () => release())
  }

/**
 * The HolyAgent extension for Pi. Pi calls this factory when it loads the package and passes the
 * extension API. It registers the `--holyagent-role` flag and its handlers and starts no process,
 * socket, watcher or timer; see {@link createExtension}.
 */
export default createExtension()
