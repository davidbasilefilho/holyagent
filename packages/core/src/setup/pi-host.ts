import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, win32 } from "node:path"

import { Context, Effect, Option, Schema } from "effect"

import { cmdExeArguments, isBatchFile } from "../pi/bash/cmd.ts"
import { spawn } from "../state/process.ts"
import { definedEnv, type Env, firstNonEmpty } from "./environment.ts"
import { SetupFailure } from "./errors.ts"
import { pathKey, Shell, type ShellResult } from "./shell.ts"

const PROBE_COMMAND = "holyagent-compatibility-probe"
const PROBE_APIS = [
  "on",
  "registerCommand",
  "registerTool",
  "registerToolRenderer",
  "registerFlag",
  "getFlag",
  "getAllTools",
  "getActiveTools",
  "setActiveTools",
  "getSessionName",
  "exec",
  "registerMcpServer",
]
const PROBE_EXTENSION = `
export default function (pi) {
  if (${JSON.stringify(PROBE_APIS)}.every((name) => typeof pi[name] === "function")) {
    pi.registerCommand(${JSON.stringify(PROBE_COMMAND)}, {
      description: "Temporary offline capability probe",
      handler: () => {}
    });
  }
}
`
const RPC_INPUT =
  '{"id":"ha-state","type":"get_state"}\n{"id":"ha-commands","type":"get_commands"}\n'
const SAFE_FLAGS = ["--offline", "--no-session", "--no-extensions", "--no-approve", "--no-skills"]
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const TIMEOUT_MS = 7_000
const fail = (message: string) => new SetupFailure({ message })

/** The exact subprocess invocation of the disposable Pi probe. No user config is inherited. */
export interface PiProbeRequest {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly stdin?: string
}

/** Test seam for the Pi-only process transport; the production path uses detached subprocesses. */
export class PiProbeTransport extends Context.Service<
  PiProbeTransport,
  { readonly run: (request: PiProbeRequest) => Effect.Effect<ShellResult> }
>()("holyagent/PiProbeTransport") {}

const commandFor = (executable: string, args: ReadonlyArray<string>, env: Env) => {
  if (process.platform !== "win32" || !isBatchFile(executable)) return { program: executable, args }
  const windows = firstNonEmpty(
    caseInsensitiveEnv(env, "SYSTEMROOT"),
    caseInsensitiveEnv(env, "WINDIR"),
  )
  const wrapped = cmdExeArguments(executable, args)
  return windows !== undefined && /^[a-z]:[/\\]/i.test(windows) && wrapped.ok
    ? { program: win32.join(windows, "System32", "cmd.exe"), args: wrapped.args }
    : undefined
}

/** Call the exact host verified by setup, never a second lookup of pi in another cwd. */
export const runVerifiedPi = (
  shell: Shell["Service"],
  env: Env,
  executable: string,
  args: ReadonlyArray<string>,
  options: Parameters<Shell["Service"]["run"]>[2],
) => {
  const call = commandFor(executable, args, env)
  return call === undefined
    ? Effect.succeed({
        exitCode: 127,
        stdout: "",
        stderr: "The verified Pi shim cannot be started safely",
      })
    : shell.run(call.program, call.args, options)
}

const liveRun = ({ executable, args, cwd, env, stdin }: PiProbeRequest) =>
  Effect.gen(function* () {
    const call = commandFor(executable, args, env)
    if (call === undefined) return { exitCode: 127, stdout: "", stderr: "" }
    const result = yield* spawn(call.program, call.args, { cwd, env, stdin })
    return {
      exitCode: result.code,
      stdout: new TextDecoder().decode(result.stdout),
      stderr: result.stderr,
    }
  }).pipe(Effect.catchDefect(() => Effect.succeed({ exitCode: 127, stdout: "", stderr: "" })))

const caseInsensitiveEnv = (env: Env, name: string) =>
  Object.entries(env).find(([key, value]) => key.toUpperCase() === name && value !== undefined)?.[1]

const isolatedEnv = (env: Env, directory: string) =>
  definedEnv({
    [pathKey(env)]: env[pathKey(env)],
    SystemRoot: caseInsensitiveEnv(env, "SYSTEMROOT"),
    WINDIR: caseInsensitiveEnv(env, "WINDIR"),
    PATHEXT: caseInsensitiveEnv(env, "PATHEXT"),
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    LOCALAPPDATA: directory,
    XDG_CONFIG_HOME: directory,
    XDG_STATE_HOME: directory,
    XDG_DATA_HOME: directory,
    XDG_CACHE_HOME: directory,
    PI_CODING_AGENT_DIR: directory,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    NODE_DISABLE_COMPILE_CACHE: "1",
    TEMP: directory,
    TMP: directory,
    TMPDIR: directory,
    TERM: "dumb",
    NO_COLOR: "1",
  })

const RecordValue = Schema.Record(Schema.String, Schema.Unknown)
const Response = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      id: Schema.String,
      type: Schema.Literal("response"),
      command: Schema.String,
      success: Schema.Literal(true),
      data: RecordValue,
    }),
    [RecordValue],
  ),
)
const State = Schema.StructWithRest(
  Schema.Struct({ sessionId: Schema.NonEmptyString, isStreaming: Schema.Boolean }),
  [RecordValue],
)
const Command = Schema.StructWithRest(Schema.Struct({ name: Schema.String }), [RecordValue])
const Commands = Schema.StructWithRest(Schema.Struct({ commands: Schema.Array(Command) }), [
  RecordValue,
])
const hasState = Schema.is(State)
const hasCommands = Schema.is(Commands)
const parseResponse = Schema.decodeUnknownOption(Response, { onExcessProperty: "error" })

const hasRpc = (text: string) => {
  const replies = text.split(/\r?\n/).flatMap((line) => Option.toArray(parseResponse(line)))
  const state = replies.find(({ id, command }) => id === "ha-state" && command === "get_state")
  const commands = replies.find(
    ({ id, command }) => id === "ha-commands" && command === "get_commands",
  )?.data
  return (
    hasState(state?.data) &&
    hasCommands(commands) &&
    commands.commands.some(({ name }) => name === PROBE_COMMAND)
  )
}

/**
 * Verifies the installed CLI's package commands and a real offline RPC/extension handshake. Failure
 * never upgrades the install. The version is diagnostic, not an eligibility policy.
 */
export const probePiHost = Effect.fn("probePiHost")(function* (env: Env) {
  const shell = yield* Shell
  const found = yield* shell.which("pi")
  if (Option.isNone(found)) return yield* fail("not found on PATH")
  const path = found.value
  if (!isAbsolute(path))
    return yield* fail("the Pi executable is relative on PATH; use its absolute installation path")
  const transport = yield* Effect.serviceOption(PiProbeTransport)
  const run = Option.isSome(transport) ? transport.value.run : liveRun
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "holyagent-pi-probe-")),
      catch: () => fail("could not create a disposable Pi probe profile"),
    }),
    (directory) =>
      Effect.gen(function* () {
        const childEnv = isolatedEnv(env, directory)
        const invoke = (args: ReadonlyArray<string>, stdin?: string) =>
          run({
            executable: path,
            args,
            cwd: directory,
            env: childEnv,
            ...(stdin === undefined ? {} : { stdin }),
          }).pipe(
            Effect.timeoutOption(TIMEOUT_MS),
            Effect.flatMap((result) =>
              Option.isSome(result)
                ? Effect.succeed(result.value)
                : Effect.fail(fail(`isolated Pi ${args[0] ?? "probe"} timed out`)),
            ),
          )
        const versionResult = yield* invoke(["--version"])
        const version = versionResult.stdout.trim()
        if (versionResult.exitCode !== 0 || !VERSION.test(version))
          return yield* fail(
            `${path} did not report a version for --version (exit ${versionResult.exitCode})`,
          )
        const helpResult = yield* invoke(["--help"])
        const help = helpResult.stdout
        if (
          helpResult.exitCode !== 0 ||
          !/\bpi install\b[^\r\n]*\[-l\]/.test(help) ||
          !/\bpi remove\b[^\r\n]*\[-l\]/.test(help)
        )
          return yield* fail(
            `${version} at ${path} does not advertise local package install and remove`,
          )
        const options = new Set(help.match(/--[a-z][a-z0-9-]*/g))
        if (![...SAFE_FLAGS, "--mode", "--extension"].every((flag) => options.has(flag)))
          return yield* fail(
            `${version} at ${path} does not advertise isolated RPC and extension options`,
          )
        const extension = join(directory, "probe.mjs")
        yield* Effect.tryPromise({
          try: () => writeFile(extension, PROBE_EXTENSION, { mode: 0o600, flag: "wx" }),
          catch: () => fail("could not stage the disposable Pi probe extension"),
        })
        const rpc = yield* invoke(
          ["--mode", "rpc", ...SAFE_FLAGS, "--extension", extension],
          RPC_INPUT,
        )
        if (rpc.exitCode !== 0 || !hasRpc(rpc.stdout))
          return yield* fail(
            `${version} at ${path} did not complete the isolated RPC/extension capability check`,
          )
        return { path, version }
      }),
    (directory) =>
      Effect.tryPromise(() => rm(directory, { force: true, recursive: true, maxRetries: 3 })).pipe(
        Effect.ignore,
      ),
  )
})
