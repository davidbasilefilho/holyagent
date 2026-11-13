import { encode, escapeString, rawString } from "@toon-format/toon"
import { Cause, Effect } from "effect"

import { version } from "../../../../package.json" with { type: "json" }
import { type AgentHost, type HostWords, wordsFor } from "../domain/host.ts"
import { stateDirectory } from "../state/layout.ts"
import { WorkTree } from "../state/local.ts"
import { updateState } from "../state/store.ts"
import { resolveState } from "../state/tree.ts"
import { vcsLive } from "../vcs/live.ts"
import { INPUT_FLAG, parseArgs, stringFlag } from "./args.ts"
import { COMMANDS } from "./commands.ts"
import { agentHostOf, loadConfig } from "./config.ts"
import { readInput, readInputBy, readReport } from "./context.ts"
import { describeFailure, plainText, Usage } from "./errors.ts"
import { type Call, type Command, type Host, Streamed, Verbatim, WithTrailer } from "./types.ts"

/** What one run prints and the exit code it ends with. */
export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

/** Encodes TOON without terminal control bytes, preserving the decoded values and keys. */
export const encodeRecord = (value: unknown): string =>
  encode(value, {
    // TOON's encoder quotes keys containing C1 controls, but may leave such values unquoted.
    // Force only those values into quoted strings so the Unicode escapes decode correctly.
    replacer: (_key, item) =>
      typeof item === "string" && /[\u007f-\u009f]/.test(item)
        ? rawString(`"${escapeString(item)}"`)
        : item,
  }).replace(
    /[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  )

/** Renders a structured command result and its optional plain-text trailer. */
export const renderRecord = (output: unknown): string =>
  output instanceof WithTrailer
    ? `${encodeRecord(output.fields)}\n${plainText(output.label)}:\n${plainText(output.text)}\n`
    : `${encodeRecord(output)}\n`

/** The command with the help text of a host's `words`. */
const forWords = (command: Command, words: HostWords): Command =>
  command.forHost === undefined ? command : { ...command, ...command.forHost(words) }

const help = (command: Command, words: HostWords): string => {
  const { usage, summary, input, output, notes, flags } = forWords(command, words)
  return [
    `${usage}  ${summary}`,
    ...(input === undefined
      ? []
      : [`${INPUT_FLAG in flags ? "input (--input '<json>' or stdin)" : "stdin"}: ${input}`]),
    ...(output === undefined ? [] : [`stdout: ${output}`]),
    ...(notes ?? []).map((note) => `note: ${note}`),
  ].join("\n")
}

/** The commands a host's help lists: those that name no hosts, or name this one. */
const listed = (host: AgentHost): ReadonlyArray<Command> =>
  COMMANDS.filter((command) => command.hosts === undefined || command.hosts.includes(host))

const topHelp = (host: AgentHost, words: HostWords): string =>
  [
    "Run holyagent <command> [args]. Give JSON with --input '<json>' or stdin; results use TOON.",
    "Errors go to stderr with a hint: line. Exit codes: 2 for usage, 3 for refused work, 4 for state or I/O failure.",
    ...listed(host).map((command) => {
      const { usage, summary } = forWords(command, words)
      return `${usage}  ${summary}`
    }),
    "Run holyagent help [command] for details.",
  ].join("\n")

const callFor = (args: Call["args"], host: Host, emit: Call["emit"], command: Command) =>
  Effect.gen(function* () {
    // A stateless command never reads the state, so a git failure must not stop it.
    const { root, directory, resolved } =
      command.stateless === true
        ? { root: host.cwd, directory: stateDirectory(host.cwd), resolved: undefined }
        : yield* resolveState(
            host.cwd,
            host.env,
            command.core === true
              ? "peek"
              : typeof command.state === "function"
                ? command.state(args)
                : (command.state ?? "ifPresent"),
            // A hook runs at session start and on every launch, where a network wait is not worth it.
            command.core !== true && command.path[0] !== "hook",
          )
    const inline = stringFlag(args, INPUT_FLAG)
    return {
      args,
      cwd: host.cwd,
      env: host.env,
      root,
      directory,
      update: (transition) => updateState(directory, transition, host.env, undefined, resolved),
      config: loadConfig(host.env, root),
      text: readReport(host),
      emit,
      vcs: host.vcs ?? vcsLive(root, host.env),
      terminal: host.terminal,
      setupTui: host.setupTui,
      input: (schema) => readInput(host, schema, inline),
      inputBy: (pick) => readInputBy(host, pick, inline),
    } satisfies Call
  })

// A host setting that cannot be read is no reason to lose the failure being reported or the help
// being asked for: Claude's words stand in for it. Commands that load the config still refuse it.
const hostForText = (env: Host["env"]) =>
  agentHostOf(env).pipe(Effect.orElseSucceed((): AgentHost => "claude"))

/**
 * `help` is `--help` as a word: alone it is the top help, and `help assignment close` is that
 * command's.
 */
const asFlag = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  argv[0] === "help" ? (argv.length === 1 ? ["--help"] : [...argv.slice(1), "--help"]) : argv

const execute = (given: ReadonlyArray<string>, host: Host) =>
  Effect.gen(function* () {
    const argv = asFlag(given)
    const [first] = argv
    if (first === undefined || first === "--help" || first === "-h") {
      const agent = yield* hostForText(host.env)
      return { stdout: `${topHelp(agent, wordsFor(agent))}\n`, stderr: "", code: 0 }
    }
    if (first === "--version") return { stdout: `${version}\n`, stderr: "", code: 0 }
    const command = COMMANDS.find((candidate) =>
      candidate.path.every((word, index) => argv[index] === word),
    )
    if (command === undefined) {
      const group = COMMANDS.filter((candidate) => candidate.path[0] === first)
      if (
        group.length > 0 &&
        (argv.length === 1 || argv.includes("--help") || argv.includes("-h"))
      ) {
        const agent = yield* hostForText(host.env)
        const words = wordsFor(agent)
        const shown = listed(agent).filter((candidate) => group.includes(candidate))
        return {
          stdout: `${shown.map((entry) => help(entry, words)).join("\n")}\n`,
          stderr: "",
          code: 0,
        }
      }
      return yield* new Usage({
        message: `Unknown command ${argv.slice(0, 2).join(" ")}`,
        hint:
          group.length > 0
            ? `Run \`holyagent ${first} --help\` for its commands.`
            : "Run `holyagent --help` for the commands.",
      })
    }
    const rest = argv.slice(command.path.length)
    if (command.passthrough !== true && (rest.includes("--help") || rest.includes("-h"))) {
      const agent = yield* hostForText(host.env)
      return { stdout: `${help(command, wordsFor(agent))}\n`, stderr: "", code: 0 }
    }
    const args =
      command.raw === true
        ? { positionals: rest, flags: {} }
        : yield* parseArgs(rest, command.flags, command.usage)
    const count = args.positionals.length
    if (
      command.raw !== true &&
      count !== command.positionals &&
      !(command.optional && count === command.positionals - 1)
    )
      return yield* new Usage({
        message: `Expected ${command.positionals} argument(s), got ${count}`,
        hint: `Usage: holyagent ${command.usage}`,
      })
    const emitted: Array<string> = []
    const write = host.emit ?? ((text: string) => Effect.sync(() => void emitted.push(text)))
    const emit = (text: string) => write(plainText(text))
    const call = yield* callFor(args, host, emit, command)
    // The Intent in use is kept per work tree: every read and write of the run resolves it from here.
    const output = yield* command.run(call).pipe(Effect.provideService(WorkTree, call.root))
    if (output instanceof Verbatim)
      return {
        stdout: plainText(output.stdout),
        stderr: plainText(output.stderr),
        code: output.code,
      }
    if (output instanceof Streamed)
      return { stdout: emitted.join(""), stderr: "", code: output.code }
    const stdout = renderRecord(output)
    return { stdout, stderr: "", code: 0 }
  })

const failed = (error: unknown, env: Host["env"]) =>
  hostForText(env).pipe(
    Effect.map((agent): Result => {
      const { tag, message, hint, code } = describeFailure(error, wordsFor(agent))
      return { stdout: "", stderr: `error: ${tag}: ${message}\nhint: ${hint}\n`, code }
    }),
  )

/**
 * Runs one command line and returns what to print and the exit code; it never fails. A failure
 * prints `error: <Tag>: <message>` and `hint: <what to do>` and exits 2 for a usage or input
 * problem, 3 when the current state refuses the step and 4 for a state or I/O failure.
 */
export const run = (argv: ReadonlyArray<string>, host: Host): Effect.Effect<Result> =>
  execute(argv, host).pipe(
    Effect.catch((error) => failed(error, host.env)),
    Effect.catchCause((cause) =>
      failed({ _tag: "Defect", message: Cause.pretty(cause) }, host.env),
    ),
  )
