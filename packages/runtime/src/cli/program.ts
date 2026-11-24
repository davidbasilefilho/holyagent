import { constants, fstatSync, type Stats } from "node:fs"
import { open, stat } from "node:fs/promises"
import { resolve } from "node:path"

import { Cause, Effect, Schema } from "effect"

import { version } from "../../../../package.json" with { type: "json" }
import { type AgentHost, type HostWords, wordsFor } from "../domain/host.ts"
import { PI_PROJECT_FLAG, projectOf } from "../hooks/pi-project.ts"
import { StateIo } from "../state/errors.ts"
import { stateDirectory } from "../state/layout.ts"
import { WorkTree } from "../state/local.ts"
import { updateState } from "../state/store.ts"
import { resolveState } from "../state/tree.ts"
import { encodeRecord } from "../toon.ts"
import { vcsLive } from "../vcs/live.ts"
import { adaptAgentInput, agentInputHelp } from "./agent-input.ts"
import { INPUT_FLAG, parseArgs, stringFlag } from "./args.ts"
import { COMMANDS } from "./commands.ts"
import { agentHostOf, loadConfig } from "./config.ts"
import { decodeInputValueBy, decodeJsonInputBy, readInputBy, readReport } from "./context.ts"
import { describeFailure, plainText, StdinMissing, Usage } from "./errors.ts"
import { PUBLIC_MAINTENANCE_COMMANDS } from "./public-maintenance.ts"
import { PUBLIC_SETUP_COMMANDS, SETUP_COMMANDS } from "./setup.ts"
import {
  type Call,
  type CliSurface,
  type Command,
  type Host,
  Streamed,
  Verbatim,
  WithTrailer,
} from "./types.ts"

/** What one run prints and the exit code it ends with. */
export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly code: number
}

export { encodeRecord } from "../toon.ts"

/** Renders a structured command result and its optional plain-text trailer. */
export const renderRecord = (output: unknown): string =>
  output instanceof WithTrailer
    ? `${encodeRecord(output.fields)}\n${plainText(output.label)}:\n${plainText(output.text)}\n`
    : `${encodeRecord(output)}\n`

const toon = (output: unknown, code = 0): Result => ({
  stdout: `${encodeRecord(output)}\n`,
  stderr: "",
  code,
})

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

const [, hostDoctor] = SETUP_COMMANDS
const publicCommands: ReadonlyArray<Command> = [
  ...PUBLIC_SETUP_COMMANDS,
  {
    ...hostDoctor,
    notes: hostDoctor.notes.filter((note) => !/internal Claude|claude\.ai cloud/.test(note)),
  },
  ...PUBLIC_MAINTENANCE_COMMANDS,
]
const agentCommands = COMMANDS.filter(
  ({ path: [group] }) =>
    group !== "setup" && group !== "doctor" && group !== "hook" && group !== "browser-server",
)
const commandsFor = (surface: CliSurface) =>
  surface === "agent" ? agentCommands : surface === "public" ? publicCommands : COMMANDS

/** The commands a host's help lists: those that name no hosts, or name this one. */
const listed = (commands: ReadonlyArray<Command>, host: AgentHost) =>
  commands.filter((command) => command.hosts === undefined || command.hosts.includes(host))

const topHelp = (commands: ReadonlyArray<Command>, words: HostWords, surface: CliSurface): string =>
  [
    ...(surface === "public"
      ? ["Manage your HolyAgent installation.", "Run holyagent <command> [options]."]
      : [
          "Run holyagent <command> [args]. Give JSON with --input '<json>' or stdin; results use TOON.",
          "Errors go to stderr with a hint: line. Exit codes: 2 for usage, 3 for refused work, 4 for state or I/O failure.",
        ]),
    ...commands
      .filter((command) => surface !== "public" || command.path.length === 1)
      .map((command) => {
        const { usage, summary } = forWords(command, words)
        return `${usage}  ${summary}`
      }),
    "Run holyagent help [command] for details.",
  ].join("\n")

const agentCommandHelp = (entry: Command, words: HostWords, detailed: boolean) => {
  const command = forWords(entry, words)
  const path = command.path.join(" ")
  const flags = agentInputHelp(command.path)
  const usage = flags?.usage ?? command.usage
  const search = command.path[0] === "rg" || command.path[0] === "fd"
  const output = search
    ? "One TOON document with exitCode, stdout and stderr."
    : path === "assignment dispatch"
      ? "One TOON document. Use the decoded prompt field as the specialist prompt."
      : command.output
  const notes = search
    ? ["Uses the installed search program and its exit code. It does not read stdin."]
    : path === "assignment reports"
      ? [
          "Pass the path of a regular workflow journal or supported session file.",
          "The returned paths can be passed as --report-file to assignment close.",
          ...(words.reportsNote === undefined ? [] : [words.reportsNote]),
        ]
      : (flags?.notes ?? command.notes)
  const summary =
    path === "assignment close"
      ? "Finish an Assignment using the specialist's report file and optionally accept its evidence"
      : path === "assignment accept"
        ? "Accept an Assignment using its stored report or a corrected report file"
        : command.summary
  return {
    usage,
    summary,
    ...(detailed && output !== undefined ? { output } : {}),
    ...(detailed && notes !== undefined ? { notes: notes.map(agentCommandNames) } : {}),
  }
}

const agentCommandNames = (text: string) =>
  text.replaceAll(/(`|Usage: )holyagent (?=[a-z-])/g, (prefix) =>
    prefix.replace("holyagent", "holyagent-cli"),
  )

const showHelp = (
  commands: ReadonlyArray<Command>,
  agent: AgentHost,
  surface: CliSurface,
  path: ReadonlyArray<string> = [],
): Result => {
  const words = wordsFor(agent)
  if (surface === "agent") {
    return toon({
      usage:
        path.length === 0
          ? "holyagent-cli <command> [flags]"
          : `holyagent-cli ${path.join(" ")} --help`,
      commands: commands.map((command) => agentCommandHelp(command, words, path.length > 0)),
      ...(path.length === 0
        ? {
            notes: [
              "Run holyagent-cli help <command> for its flags.",
              "Give --project <dir> before the command to select a different working directory.",
              "Exit codes: 2 for invalid input, 3 for refused operations, 4 for state or I/O errors.",
            ],
          }
        : {}),
    })
  }
  const output =
    path.length === 0
      ? topHelp(commands, words, surface)
      : commands.map((command) => help(command, words)).join("\n")
  return { stdout: `${output}\n`, stderr: "", code: 0 }
}

const agentReportError = (path: string) =>
  new Usage({
    message: `Could not read a nonempty regular report file at ${path}`,
    hint: "Pass a readable file with --report-file.",
  })

// The model can invoke the Bun bundle directly. A redirected /dev/stdin may look like a regular
// file. Compare the actual descriptor so alternate spellings and symlinks also refuse it.
const aliasesStdin = (file: Stats) =>
  Effect.try({ try: () => fstatSync(0), catch: () => undefined }).pipe(
    Effect.map((stdin) => stdin.isFile() && stdin.dev === file.dev && stdin.ino === file.ino),
    Effect.orElseSucceed(() => false),
  )

const readAgentReport = (path: string) =>
  Effect.gen(function* () {
    const fail = () => agentReportError(path)
    const file = yield* Effect.tryPromise({ try: () => stat(path), catch: fail })
    if (!file.isFile() || (yield* aliasesStdin(file))) return yield* fail()
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => open(path, constants.O_RDONLY | constants.O_NONBLOCK),
        catch: fail,
      }),
      (handle) =>
        Effect.gen(function* () {
          const opened = yield* Effect.tryPromise({ try: () => handle.stat(), catch: fail })
          if (!opened.isFile() || (yield* aliasesStdin(opened))) return yield* fail()
          const contents = yield* Effect.tryPromise({
            try: () => handle.readFile("utf8"),
            catch: fail,
          })
          if (contents.trim() === "") return yield* fail()
          return contents
        }),
      (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
    )
  })

const missingReport = Effect.fail(new StdinMissing({ reason: "no report file was given" }))

const callFor = (
  args: Call["args"],
  host: Host,
  emit: Call["emit"],
  command: Command,
  surface: CliSurface,
  input: unknown,
  report: string | undefined,
) =>
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
    const inputBy: Call["inputBy"] = (pick) => {
      if (surface !== "agent") return readInputBy(host, pick, inline)
      if (input !== undefined) return decodeInputValueBy(input, pick, "flags")
      return report === undefined ? missingReport : decodeJsonInputBy(report, pick, "--report-file")
    }
    return {
      args,
      surface,
      cwd: host.cwd,
      env: host.env,
      root,
      directory,
      update: (transition) => updateState(directory, transition, host.env, undefined, resolved),
      config: loadConfig(host.env, root),
      text:
        surface === "agent"
          ? report === undefined
            ? missingReport
            : Effect.succeed(report)
          : readReport(host),
      emit,
      vcs: host.vcs ?? vcsLive(root, host.env),
      terminal: surface === "agent" ? undefined : host.terminal,
      t3Workflow: surface === "public" || (host.t3Workflow ?? false),
      installedPackageRoot: surface === "public" ? host.installedPackageRoot : undefined,
      setupTui: host.setupTui,
      input: (schema) => inputBy(() => schema),
      inputBy,
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

const isHelp = (arg: string | undefined) => arg === "--help" || arg === "-h"
const requestsHelp = (args: ReadonlyArray<string>) =>
  args.slice(0, args.indexOf("--") < 0 ? args.length : args.indexOf("--")).some(isHelp)

const noninteractiveEnvironment = (env: Host["env"]): Host["env"] => ({
  ...env,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  CLICOLOR_FORCE: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",
  GIT_EDITOR: "false",
  GCM_INTERACTIVE: "never",
  GH_PROMPT_DISABLED: "1",
  SSH_ASKPASS_REQUIRE: "never",
})

const projectContext = (given: ReadonlyArray<string>, host: Host, surface: CliSurface) =>
  Effect.gen(function* () {
    if (surface === "host") return { argv: given, host }
    const { directory, rest } = projectOf(given)
    if (given[0] !== PI_PROJECT_FLAG) return { argv: given, host }
    if (directory === undefined || directory.trim() === "" || directory.startsWith("--"))
      return yield* new Usage({
        message: "Missing project directory",
        hint: `Give a directory after ${PI_PROJECT_FLAG}.`,
      })
    const cwd = resolve(host.cwd, directory)
    const location = yield* Effect.tryPromise({
      try: () => stat(cwd),
      catch: (cause) => new StateIo({ path: cwd, cause }),
    })
    if (!location.isDirectory())
      return yield* new Usage({
        message: `Project is not a directory: ${cwd}`,
        hint: `Give a directory after ${PI_PROJECT_FLAG}.`,
      })
    return { argv: rest, host: { ...host, cwd } }
  })

const execute = (given: ReadonlyArray<string>, initialHost: Host, surface: CliSurface) =>
  Effect.gen(function* () {
    const { argv: projectArgs, host } = yield* projectContext(given, initialHost, surface)
    const request = asFlag(projectArgs)
    const argv =
      surface === "public" && request[0] === "install" ? ["setup", ...request.slice(1)] : request
    const [first, second] = argv
    const commands = commandsFor(surface)
    if (first === undefined || isHelp(first)) {
      const agent = yield* hostForText(host.env)
      return showHelp(listed(commands, agent), agent, surface)
    }
    if (first === "--version" || first === "-v") {
      if (surface === "agent" && argv.length > 1)
        return yield* new Usage({
          message: "The version flag takes no arguments",
          hint: "Run holyagent-cli --version.",
        })
      return surface === "agent"
        ? toon({ version })
        : { stdout: `${version}\n`, stderr: "", code: 0 }
    }
    const command = commands.find((candidate) =>
      candidate.path.every((word, index) => argv[index] === word),
    )
    if (command === undefined) {
      const group = commands.filter((candidate) => candidate.path[0] === first)
      if (
        group.length > 0 &&
        (argv.length === 1 ||
          (surface === "agent" ? argv.length === 2 && isHelp(argv[1]) : requestsHelp(argv)))
      ) {
        const agent = yield* hostForText(host.env)
        return showHelp(listed(group, agent), agent, surface, [first])
      }
      const program = surface === "agent" ? "holyagent-cli" : "holyagent"
      return yield* new Usage({
        message: `Unknown command ${argv.slice(0, 2).join(" ")}`,
        hint:
          group.length > 0
            ? `Run \`${program} ${first} --help\` for its commands.`
            : `Run \`${program} --help\` for the commands.`,
      })
    }
    if (
      surface === "public" &&
      first === "setup" &&
      command.path.length === 1 &&
      second !== undefined &&
      !second.startsWith("-")
    )
      return yield* new Usage({
        message: `Unknown setup harness ${second}`,
        hint: "Choose pi or claude. Run `holyagent setup --help` for options.",
      })
    const provided = argv.slice(command.path.length)
    if ((surface === "agent" || command.passthrough !== true) && requestsHelp(provided)) {
      const agent = yield* hostForText(host.env)
      return showHelp([command], agent, surface, command.path)
    }
    const adapted = surface === "agent" ? yield* adaptAgentInput(command.path, provided) : undefined
    const rest = adapted?.argv ?? provided
    const usage =
      surface === "agent" ? (agentInputHelp(command.path)?.usage ?? command.usage) : command.usage
    const args =
      command.raw === true
        ? { positionals: rest, flags: {} }
        : yield* parseArgs(rest, command.flags, usage)
    const count = args.positionals.length
    if (
      command.raw !== true &&
      count !== command.positionals &&
      !(command.optional && count === command.positionals - 1)
    )
      return yield* new Usage({
        message: `Expected ${command.positionals} argument(s), got ${count}`,
        hint: `Usage: holyagent ${usage}`,
      })
    const emitted: Array<string> = []
    const capture = (text: string) => Effect.sync(() => void emitted.push(text))
    const write = surface === "agent" ? capture : (host.emit ?? capture)
    const emit = (text: string) => write(plainText(text))
    const report =
      adapted?.reportFile === undefined
        ? undefined
        : yield* readAgentReport(resolve(host.cwd, adapted.reportFile))
    if (surface === "agent" && command.path.join(" ") === "assignment reports") {
      const path = resolve(host.cwd, args.positionals[0] ?? "")
      const source = yield* Effect.tryPromise(() => stat(path)).pipe(
        Effect.orElseSucceed(() => undefined),
      )
      if (source !== undefined && (yield* aliasesStdin(source)))
        return yield* agentReportError(path)
    }
    if (report !== undefined && args.flags["report-json"] === true)
      yield* decodeJsonInputBy(report, () => Schema.Unknown, "--report-file")
    const call = yield* callFor(args, host, emit, command, surface, adapted?.input, report)
    // The Intent in use is kept per work tree: every read and write of the run resolves it from here.
    const output = yield* command.run(call).pipe(Effect.provideService(WorkTree, call.root))
    if (surface === "agent") {
      const stdout = emitted.join("")
      if (output instanceof Verbatim)
        return toon(
          { exitCode: output.code, stdout: `${stdout}${output.stdout}`, stderr: output.stderr },
          output.code,
        )
      if (output instanceof Streamed)
        return toon({ exitCode: output.code, stdout, stderr: "" }, output.code)
      if (output instanceof WithTrailer)
        return toon({ ...output.fields, [output.label]: output.text })
      return toon(output)
    }
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

const agentHint = (tag: string, hint: string) => {
  if (tag === "StdinMissing") return "Pass a readable file with --report-file."
  if (tag === "InvalidDraft")
    return "Check the typed flags in the command's --help. Unknown fields are refused."
  if (tag === "InsufficientAcceptance")
    return "Save the corrected specialist report to a regular file and pass it with --report-file to assignment close or assignment accept."
  return agentCommandNames(hint)
}

const failed = (error: unknown, env: Host["env"], surface: CliSurface) =>
  hostForText(env).pipe(
    Effect.map((agent): Result => {
      const { tag, message, hint, code } = describeFailure(error, wordsFor(agent))
      if (surface === "agent")
        return toon({ error: { tag, message, hint: agentHint(tag, hint), code } }, code)
      if (surface === "public") return { stdout: "", stderr: `Error: ${message}\n${hint}\n`, code }
      return { stdout: "", stderr: `error: ${tag}: ${message}\nhint: ${hint}\n`, code }
    }),
  )

/**
 * Runs one command line with the selected presentation and command set. It returns one result,
 * including exit 2 for invalid input, 3 for a refused operation and 4 for state or I/O errors.
 */
export const run = (
  argv: ReadonlyArray<string>,
  host: Host,
  surface: CliSurface = "host",
): Effect.Effect<Result> =>
  execute(
    argv,
    surface === "agent" ? { ...host, env: noninteractiveEnvironment(host.env) } : host,
    surface,
  ).pipe(
    Effect.catch((error) => failed(error, host.env, surface)),
    Effect.catchCause((cause) =>
      failed({ _tag: "Defect", message: Cause.pretty(cause) }, host.env, surface),
    ),
  )
