import { statSync } from "node:fs"
import { constants as osConstants } from "node:os"

import { Data, Effect, Stream } from "effect"
import {
  Bash,
  bytesOutput,
  type CommandName,
  decodeBytesToUtf8,
  defineCommand,
  type ExecResult,
  getCommandNames,
  getJavaScriptCommandNames,
  InMemoryFs,
  latin1FromBytes,
  MountableFs,
  parse,
  ReadWriteFs,
  type ResolvedCommandContext,
  stdoutAsBytes,
  unsafeBytesFromLatin1,
} from "just-bash"

import {
  hostPathValue,
  hostSearchFolders,
  programExtensions,
  scanHostPrograms,
  variable,
} from "./hosts.ts"
import { DRIVE_ROOTS, toHostArgument, toHostPath, toVirtualPath } from "./paths.ts"
import { type EnvChanges, type ShellFrame, type ShellRequest } from "./protocol.ts"
import { typeScriptFirst } from "./typescript.ts"

/**
 * The just-bash commands that only print a refusal. `node` tells the model to use `js-exec`, which
 * would hide the host's real `node`, so a host program of that name takes its place; with no host
 * `node` the refusal stays, since it names the way forward.
 */
export const REFUSING_BUILTINS: ReadonlyArray<string> = ["node"]

/**
 * The just-bash commands that cannot work here and are not registered: `sqlite3` needs a worker
 * file that the one-file bundle does not have (see `bundle.ts`). A host program of the name runs
 * instead.
 */
export const UNAVAILABLE_BUILTINS: ReadonlyArray<string> = ["sqlite3"]

/** The prefix of the alias that reaches a host program a just-bash command shadows: `host-cat`. */
export const HOST_PREFIX = "host-"

/** The `PATH` the shell itself has: the two folders where its commands are mounted. */
export const SHELL_PATH = "/usr/bin:/bin"

// Large but finite: a limit that never fires. A run is ended from outside (Pi's timeout or abort
// kills the shell process), so the limits only guard against a runaway the caller cannot see, and
// just-bash's defaults (100000 commands, 30 s of JavaScript) stop work that is meant to run.
const RAISED = 1e12
const A_DAY_MS = 24 * 60 * 60 * 1000

/** Just-bash's execution limits, raised so that only Pi's timeout and abort end a run. */
export const SHELL_LIMITS = {
  maxCommandCount: RAISED,
  maxLoopIterations: RAISED,
  maxAwkIterations: RAISED,
  maxSedIterations: RAISED,
  maxJqIterations: RAISED,
  maxWorkUnits: RAISED,
  maxExecutionTimeMs: A_DAY_MS,
  maxJsTimeoutMs: A_DAY_MS,
} as const

/** The shell could not run the command, or could not be set up. */
export class ShellFailed extends Data.TaggedError("ShellFailed")<{ readonly reason: string }> {
  /** The description shown to the user. */
  override get message() {
    return this.reason
  }
}

/** What each name in the shell runs. */
export interface CommandPlan {
  /** The names just-bash implements itself; they win over a host program of the same name. */
  readonly builtins: ReadonlySet<string>
  /** The host programs just-bash lacks, by name, with the file each runs. */
  readonly passthrough: ReadonlyMap<string, string>
  /** `host-<name>` for each host program a built-in shadows, with the file it runs. */
  readonly aliases: ReadonlyMap<string, string>
}

/**
 * Decides what each command name runs: where just-bash implements a command, its own runs and the
 * host program of that name is not registered (but stays reachable as `host-<name>`); a name
 * just-bash lacks, a {@link REFUSING_BUILTINS} one and an {@link UNAVAILABLE_BUILTINS} one run the
 * host program when there is one.
 */
export const planCommands = (
  hosts: ReadonlyMap<string, string>,
  builtinNames: Iterable<string>,
): CommandPlan => {
  const builtins = new Set([...builtinNames].filter((name) => !UNAVAILABLE_BUILTINS.includes(name)))
  const passthrough = new Map<string, string>()
  const aliases = new Map<string, string>()
  for (const [name, path] of hosts) {
    if (builtins.has(name) && !REFUSING_BUILTINS.includes(name))
      aliases.set(`${HOST_PREFIX}${name}`, path)
    else passthrough.set(name, path)
  }
  for (const name of passthrough.keys()) builtins.delete(name)
  return { builtins, passthrough, aliases }
}

// What just-bash keeps for itself in the environment, never part of what a call changes.
const SHELL_MANAGED: ReadonlySet<string> = new Set([
  "PWD",
  "OLDPWD",
  "PATH",
  "HOME",
  "?",
  "_",
  "IFS",
  "OPTIND",
  "OSTYPE",
  "MACHTYPE",
  "HOSTTYPE",
  "HOSTNAME",
  "SHELLOPTS",
  "BASHOPTS",
  "SHLVL",
])

/**
 * What a run changed in the shell's variables, against the environment it started with: the
 * variables now set to another value, and those no longer there. Names just-bash keeps for itself
 * (`PWD`, `PATH`, `SHELLOPTS`, ...) are never reported.
 */
export const envChanges = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): EnvChanges => {
  const set: Record<string, string> = {}
  for (const [name, value] of Object.entries(after))
    if (!SHELL_MANAGED.has(name) && before[name] !== value) set[name] = value
  const unset = Object.keys(before).filter((name) => !SHELL_MANAGED.has(name) && !(name in after))
  return { set, unset }
}

// A variable name just-bash accepts; Windows has others (`ProgramFiles(x86)`, `=C:`), which only
// host programs see.
const VALID_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** What one run of the shell needs besides its request. */
export interface ShellOptions {
  /** Where the frames go: output as it arrives, and the end. */
  readonly emit: (frame: ShellFrame) => void
  /** The platform whose paths and programs apply; the process's by default. */
  readonly platform?: NodeJS.Platform
}

// Output is written in pieces of this size so that no single line of the protocol is huge.
const CHUNK_BYTES = 256 * 1024

const emitData = (emit: ShellOptions["emit"], bytes: Uint8Array): void => {
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES)
    emit({
      type: "data",
      data: Buffer.from(bytes.subarray(at, at + CHUNK_BYTES)).toString("base64"),
    })
}

const folderExists = (path: string): boolean =>
  Effect.runSync(
    Effect.try(() => statSync(path).isDirectory()).pipe(Effect.orElseSucceed(() => false)),
  )

// Whether the command line is one simple command of a host program: no pipe, list, redirection or
// assignment around it. Its output is sent as it arrives, so a long build shows progress; any other
// line is collected and sent when it ends, since a pipe hands the output to the next command.
const isSingleHostCommand = (command: string, hosts: ReadonlySet<string>): boolean =>
  Effect.runSync(
    Effect.try(() => {
      const [statement, ...more] = parse(command).statements
      if (statement === undefined || more.length > 0 || statement.background) return false
      const [pipeline, ...rest] = statement.pipelines
      if (pipeline === undefined || rest.length > 0 || pipeline.negated) return false
      const [simple, ...piped] = pipeline.commands
      if (simple === undefined || piped.length > 0 || simple.type !== "SimpleCommand") return false
      if (simple.redirections.length > 0 || simple.assignments.length > 0) return false
      const [part, ...others] = simple.name?.parts ?? []
      return (
        part?.type === "Literal" &&
        others.length === 0 &&
        hosts.has((part as { value: string }).value)
      )
    }).pipe(Effect.orElseSucceed(() => false)),
  )

/** The state of the one run in progress, which the host commands read. */
interface Run {
  readonly streaming: boolean
  readonly hostPath: string
  /** Variables the shell cannot hold (see {@link VALID_NAME}), which a host program still gets. */
  readonly outsideEnv: Readonly<Record<string, string>>
  readonly drives: ReadonlySet<string>
  readonly platform: NodeJS.Platform
  readonly emit: ShellOptions["emit"]
}

// A program a signal ended has no exit code: the shell's convention is 128 plus the signal number.
const exitCodeOf = (code: number | null, signal: NodeJS.Signals | number | null): number =>
  code ??
  128 +
    (typeof signal === "number" ? signal : signal === null ? 0 : (osConstants.signals[signal] ?? 0))

// Runs a host program for a command of the shell: its standard input is the pipe's, its output goes
// straight to Pi when the line is one simple command, else back into the pipeline.
const runHost = (
  path: string,
  args: ReadonlyArray<string>,
  ctx: ResolvedCommandContext,
  run: Run,
): Effect.Effect<ExecResult> =>
  Effect.gen(function* () {
    const stdin = Buffer.from(latin1FromBytes(ctx.stdin), "latin1")
    const env: Record<string, string> = {
      ...run.outsideEnv,
      ...(ctx.exportedEnv ?? Object.fromEntries(ctx.env)),
      PATH: run.hostPath,
    }
    const proc = yield* Effect.try({
      try: () =>
        Bun.spawn({
          cmd: [path, ...args.map((arg) => toHostArgument(arg, run.drives, run.platform))],
          cwd: toHostPath(ctx.cwd, run.drives, run.platform),
          env,
          stdin: stdin.length > 0 ? stdin : "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      catch: (cause) =>
        new ShellFailed({ reason: cause instanceof Error ? cause.message : String(cause) }),
    })
    const out: Array<Uint8Array> = []
    const err: Array<Uint8Array> = []
    const pump = (stream: ReadableStream<Uint8Array>, sink: Array<Uint8Array>) =>
      Stream.runForEach(
        Stream.fromReadableStream({
          evaluate: () => stream,
          onError: (cause) => new ShellFailed({ reason: String(cause) }),
        }),
        (chunk) =>
          Effect.sync(() => {
            if (run.streaming) emitData(run.emit, chunk)
            else sink.push(chunk)
          }),
      )
    yield* Effect.all([pump(proc.stdout, out), pump(proc.stderr, err)], {
      concurrency: "unbounded",
    })
    const code = yield* Effect.promise(() => proc.exited)
    return {
      ...bytesOutput(unsafeBytesFromLatin1(Buffer.concat(out).toString("latin1"))),
      stderr: Buffer.concat(err).toString("utf8"),
      exitCode: exitCodeOf(code, proc.signalCode),
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        ...bytesOutput(unsafeBytesFromLatin1("")),
        stderr: `bash: ${path}: cannot execute: ${error.message}\n`,
        exitCode: 126,
      }),
    ),
  )

// `js-exec` with TypeScript first: inline code (`-c`) and code on standard input are read as
// TypeScript and run with the types removed, or as JavaScript when TypeScript's grammar rejects
// them; a file is left to `js-exec`, which reads `.ts` and `.mts` as TypeScript by its extension.
const ARGUMENTS_WITH_VALUE = new Set(["-c"])
const NO_CODE = new Set(["--help", "-h", "--version", "-V"])

const runJsExec = (
  args: ReadonlyArray<string>,
  ctx: ResolvedCommandContext,
): Effect.Effect<ExecResult> =>
  Effect.gen(function* () {
    const original = ctx.origCommand
    if (original === undefined)
      return yield* Effect.fail(new ShellFailed({ reason: "js-exec has no original command" }))
    const flag = args.indexOf("-c")
    const inline = flag >= 0 ? args[flag + 1] : undefined
    if (inline !== undefined) {
      const prepared = yield* typeScriptFirst(inline)
      return yield* Effect.promise(() =>
        original([...args.slice(0, flag + 1), prepared.code, ...args.slice(flag + 2)]),
      )
    }
    const positional = args.filter(
      (arg, at) => !arg.startsWith("-") && !ARGUMENTS_WITH_VALUE.has(args[at - 1] ?? ""),
    )
    if (positional.length > 0 || args.some((arg) => NO_CODE.has(arg)))
      return yield* Effect.promise(() => original([...args]))
    const prepared = yield* typeScriptFirst(decodeBytesToUtf8(ctx.stdin))
    return yield* Effect.promise(() => original([...args, "-c", prepared.code]))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({
        ...bytesOutput(unsafeBytesFromLatin1("")),
        stderr: `js-exec: ${String(cause).slice(0, 300)}\n`,
        exitCode: 1,
      }),
    ),
  )

/**
 * Runs one command in a fresh just-bash and reports it through `options.emit`: the output, then an
 * `end` frame with the exit code and the state the command left. The shell sees the host's files at
 * their real paths (on Windows each drive is a folder, `/c`); `/usr/bin` and `/bin` hold a stub for
 * each command, which is how just-bash finds a command, and its `PATH` is those two folders. What
 * it does not implement runs as the host program found on the call's `PATH` and the other places a
 * developer's tools live (see `hostSearchFolders`), started with the real `PATH`.
 */
export const runShell = (
  request: ShellRequest,
  options: ShellOptions,
): Effect.Effect<void, ShellFailed> =>
  Effect.gen(function* () {
    const platform = options.platform ?? process.platform
    const windows = platform === "win32"
    const folders = hostSearchFolders(request.env, platform)
    const hosts = yield* scanHostPrograms(
      folders,
      platform,
      windows ? programExtensions(request.env) : [],
    )
    // `getCommandNames` is typed as strings; they are the names `commands` takes.
    const coreNames = getCommandNames().filter(
      (name) => !UNAVAILABLE_BUILTINS.includes(name),
    ) as Array<CommandName>
    const plan = planCommands(hosts, [...coreNames, ...getJavaScriptCommandNames()])
    const drives = new Set(
      windows
        ? DRIVE_ROOTS.filter((root) => folderExists(root)).map((root) =>
            (root[0] ?? "").toLowerCase(),
          )
        : [],
    )
    const outsideEnv: Record<string, string> = {}
    const shellEnv: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.env))
      if (VALID_NAME.test(name)) shellEnv[name] = value
      else outsideEnv[name] = value
    const pathKey = Object.keys(shellEnv).find(
      (name) => variable({ [name]: "x" }, "PATH", platform) !== undefined,
    )
    if (pathKey !== undefined) delete shellEnv[pathKey]
    shellEnv["PATH"] = SHELL_PATH
    const cwd = toVirtualPath(request.cwd, platform)
    shellEnv["PWD"] = cwd
    const before = { ...shellEnv }

    const run: Run = {
      streaming: isSingleHostCommand(request.command, new Set(plan.passthrough.keys())),
      hostPath: hostPathValue(request.env, platform),
      outsideEnv,
      drives,
      platform,
      emit: options.emit,
    }

    const stubs: Record<string, { content: string; mode: number }> = {}
    for (const name of [...plan.builtins, ...plan.passthrough.keys(), ...plan.aliases.keys()])
      stubs[`/${name}`] = { content: "", mode: 0o755 }
    const stubMounts = ["/usr/bin", "/bin"].map((mountPoint) => ({
      mountPoint,
      filesystem: new InMemoryFs(stubs),
    }))
    const hostFs = (root: string) => new ReadWriteFs({ root, allowSymlinks: true })
    const fs = windows
      ? new MountableFs({
          base: new InMemoryFs(),
          mounts: [
            ...stubMounts,
            ...[...drives].map((letter) => ({
              mountPoint: `/${letter}`,
              filesystem: hostFs(`${letter.toUpperCase()}:\\`),
            })),
          ],
        })
      : new MountableFs({ base: hostFs("/"), mounts: stubMounts })

    const hostCommands = [...plan.passthrough, ...plan.aliases].map(([name, path]) =>
      defineCommand(name, (args, ctx) => Effect.runPromise(runHost(path, args, ctx, run))),
    )
    const jsExec = defineCommand("js-exec", (args, ctx) => Effect.runPromise(runJsExec(args, ctx)))
    const bash = new Bash({
      fs,
      cwd,
      env: shellEnv,
      javascript: true,
      commands: coreNames,
      customCommands: [jsExec, ...hostCommands],
      // Bun's file API registers a FinalizationRegistry that the sandbox's guard blocks while a
      // command runs, which makes every write to the real disk fail with EIO.
      defenseInDepth: { excludeViolationTypes: ["finalization_registry"] },
      executionLimits: SHELL_LIMITS,
    })

    const result = yield* Effect.tryPromise({
      try: () =>
        bash.exec(request.command, { cwd, env: shellEnv, replaceEnv: true, rawScript: true }),
      catch: (cause) => new ShellFailed({ reason: String(cause) }),
    })
    if (!run.streaming) {
      emitData(options.emit, Buffer.from(latin1FromBytes(stdoutAsBytes(result)), "latin1"))
      emitData(options.emit, Buffer.from(result.stderr, "utf8"))
    } else emitData(options.emit, Buffer.from(result.stderr, "utf8"))
    options.emit({
      type: "end",
      exitCode: result.exitCode,
      cwd: toHostPath(result.env["PWD"] ?? cwd, drives, platform),
      changes: envChanges(before, result.env),
    })
  })
