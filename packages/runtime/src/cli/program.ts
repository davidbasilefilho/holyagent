import { join } from "node:path"

import { encode } from "@toon-format/toon"
import { Cause, Effect } from "effect"

import packageJson from "../../package.json" with { type: "json" }
import { STATE_DIRECTORY } from "../state/layout.ts"
import { vcsLive } from "../vcs/live.ts"
import { parseArgs } from "./args.ts"
import { COMMANDS } from "./commands.ts"
import { loadConfig } from "./config.ts"
import { readInput, readInputBy, readReport, stateRoot } from "./context.ts"
import { describeFailure, Usage } from "./errors.ts"
import { type Call, type Command, type Host, Streamed, Verbatim, WithTrailer } from "./types.ts"

/** What one run prints and the exit code it ends with. */
export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

const help = (command: Command): string =>
  [
    `${command.usage}  ${command.summary}`,
    ...(command.input === undefined ? [] : [`stdin: ${command.input}`]),
    ...(command.output === undefined ? [] : [`stdout: ${command.output}`]),
    ...(command.notes ?? []).map((note) => `note: ${note}`),
  ].join("\n")

const topHelp = (): string =>
  [
    "holyagent <command> [args]; JSON on stdin, TOON on stdout; errors go to stderr as `error:` and `hint:` lines",
    "exit codes: 2 usage, 3 refused by the current state, 4 state or I/O failure; every error's `hint:` says what to do next",
    ...COMMANDS.map((command) => `${command.usage}  ${command.summary}`),
    "help [command] or <command> --help shows a command's stdin shape, stdout and rules",
  ].join("\n")

const callFor = (args: Call["args"], host: Host, emit: Call["emit"], stateless: boolean) =>
  Effect.gen(function* () {
    // A stateless command never reads the state, so a git failure must not stop it.
    const root = stateless ? host.cwd : yield* stateRoot(host.cwd)
    return {
      args,
      cwd: host.cwd,
      env: host.env,
      directory: join(root, STATE_DIRECTORY),
      config: loadConfig(host.env, root),
      text: readReport(host),
      emit,
      vcs: host.vcs ?? vcsLive(root, host.env),
      input: (schema) => readInput(host, schema),
      inputBy: (pick) => readInputBy(host, pick),
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
    if (first === undefined || first === "--help" || first === "-h")
      return { stdout: `${topHelp()}\n`, stderr: "", code: 0 }
    if (first === "--version") return { stdout: `${packageJson.version}\n`, stderr: "", code: 0 }
    const command = COMMANDS.find((candidate) =>
      candidate.path.every((word, index) => argv[index] === word),
    )
    if (command === undefined) {
      const group = COMMANDS.filter((candidate) => candidate.path[0] === first)
      if (group.length > 0 && (argv.length === 1 || argv.includes("--help") || argv.includes("-h")))
        return { stdout: `${group.map(help).join("\n")}\n`, stderr: "", code: 0 }
      return yield* new Usage({
        message: `Unknown command ${argv.slice(0, 2).join(" ")}`,
        hint:
          group.length > 0
            ? `Run \`holyagent ${first} --help\` for its commands.`
            : "Run `holyagent --help` for the commands.",
      })
    }
    const rest = argv.slice(command.path.length)
    if (rest.includes("--help") || rest.includes("-h"))
      return { stdout: `${help(command)}\n`, stderr: "", code: 0 }
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
    const output = yield* command.run(yield* callFor(args, host, emit, command.stateless === true))
    if (output instanceof Verbatim) return output
    if (output instanceof Streamed)
      return { stdout: emitted.join(""), stderr: "", code: output.code }
    const stdout =
      output instanceof WithTrailer
        ? `${encode(output.fields)}\n${output.label}:\n${output.text}\n`
        : `${encode(output)}\n`
    return { stdout, stderr: "", code: 0 }
  })

const failed = (error: unknown): Result => {
  const { tag, message, hint, code } = describeFailure(error)
  return { stdout: "", stderr: `error: ${tag}: ${message}\nhint: ${hint}\n`, code }
}

/**
 * Runs one command line and returns what to print and the exit code; it never fails. A failure
 * prints `error: <Tag>: <message>` and `hint: <what to do>` and exits 2 for a usage or input
 * problem, 3 when the current state refuses the step and 4 for a state or I/O failure.
 */
export const run = (argv: ReadonlyArray<string>, host: Host): Effect.Effect<Result> =>
  execute(argv, host).pipe(
    Effect.catch((error) => Effect.succeed(failed(error))),
    Effect.catchCause((cause) =>
      Effect.succeed(failed({ _tag: "Defect", message: Cause.pretty(cause) })),
    ),
  )
