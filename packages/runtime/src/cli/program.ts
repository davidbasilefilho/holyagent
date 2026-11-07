import { encode } from "@toon-format/toon"
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
import { describeFailure, Usage } from "./errors.ts"
import { BUNDLED_TOOLS } from "./tools.ts"
import { type Call, type Command, type Host, Streamed, Verbatim, WithTrailer } from "./types.ts"

/** What one run prints and the exit code it ends with. */
export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

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
    "holyagent <command> [args]; JSON inline as `--input '<json>'` or on stdin, TOON on stdout; errors go to stderr as `error:` and `hint:` lines",
    "exit codes: 2 usage, 3 refused by the current state, 4 state or I/O failure; every error's `hint:` says what to do next",
    ...listed(host).map((command) => {
      const { usage, summary } = forWords(command, words)
      return `${usage}  ${summary}`
    }),
    "help [command] or <command> --help shows a command's input shape, stdout and rules",
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
            typeof command.state === "function"
              ? command.state(args)
              : (command.state ?? "ifPresent"),
            // A hook runs at session start and on every launch, where a network wait is not worth it.
            command.path[0] !== "hook",
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
      tools: host.tools ?? BUNDLED_TOOLS,
      input: (schema) => readInput(host, schema, inline),
      inputBy: (pick) => readInputBy(host, pick, inline),
    } satisfies Call
  })

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
      const agent = yield* agentHostOf(host.env)
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
        const agent = yield* agentHostOf(host.env)
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
      const agent = yield* agentHostOf(host.env)
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
    const emit = host.emit ?? ((text: string) => Effect.sync(() => void emitted.push(text)))
    const call = yield* callFor(args, host, emit, command)
    // The Intent in use is kept per work tree: every read and write of the run resolves it from here.
    const output = yield* command.run(call).pipe(Effect.provideService(WorkTree, call.root))
    if (output instanceof Verbatim) return output
    if (output instanceof Streamed)
      return { stdout: emitted.join(""), stderr: "", code: output.code }
    const stdout =
      output instanceof WithTrailer
        ? `${encode(output.fields)}\n${output.label}:\n${output.text}\n`
        : `${encode(output)}\n`
    return { stdout, stderr: "", code: 0 }
  })

// A host setting that cannot be read is no reason to lose the failure being reported: Claude's
// words stand in for it.
const failed = (error: unknown, env: Host["env"]) =>
  agentHostOf(env).pipe(
    Effect.orElseSucceed((): AgentHost => "claude"),
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
