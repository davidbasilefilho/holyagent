import { Data, Effect, Option } from "effect"

import { definedEnv } from "../setup/environment.ts"
import { installAdvice, locateTool, SEARCH_TOOLS, type Tool } from "../setup/search-tools.ts"
import { findCommand } from "../setup/shell.ts"
import { type Command, Verbatim } from "./types.ts"

/** A search program is not installed: none of its executables is on PATH. */
export class ToolMissing extends Data.TaggedError("ToolMissing")<{
  readonly tool: Tool
}> {
  /** The description shown to the user, with the install commands per platform. */
  override get message() {
    const { title, commands } = SEARCH_TOOLS[this.tool]
    return `${title} (${commands.join(" or ")}) is not on PATH; ${installAdvice}`
  }
}

// Preserve other bytes, including non-UTF-8 data, while rendering terminal controls visibly.
const visibleBytes = (bytes: Uint8Array, previous: number, final: boolean) => {
  const result: Array<number> = []
  const escape = (code: number) => {
    for (const character of `\\u${code.toString(16).padStart(4, "0")}`)
      result.push(character.charCodeAt(0))
  }
  // -1 holds C2 until the next byte identifies a UTF-8 C1 control. Positive values count the
  // remaining bytes of another UTF-8 character, whose continuation bytes are ordinary data.
  let pending = previous
  for (const byte of bytes) {
    if (pending === -1) {
      pending = 0
      if (byte >= 0x80 && byte <= 0x9f) {
        escape(byte)
        continue
      }
      result.push(0xc2)
      if (byte >= 0xa0 && byte <= 0xbf) {
        result.push(byte)
        continue
      }
    }
    if (pending > 0 && byte >= 0x80 && byte <= 0xbf) {
      result.push(byte)
      pending--
      continue
    }
    pending = 0
    if (byte === 0xc2) pending = -1
    else if (byte >= 0xc3 && byte <= 0xdf) {
      result.push(byte)
      pending = 1
    } else if (byte >= 0xe0 && byte <= 0xef) {
      result.push(byte)
      pending = 2
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      result.push(byte)
      pending = 3
    } else if ((byte < 0x20 && byte !== 0x09 && byte !== 0x0a) || (byte >= 0x7f && byte <= 0x9f))
      escape(byte)
    else result.push(byte)
  }
  if (final && pending === -1) result.push(0xc2)
  return { bytes: Uint8Array.from(result), pending: final ? 0 : pending }
}

const forward = (stream: ReadableStream<Uint8Array>, target: NodeJS.WriteStream) => {
  const reader = stream.getReader()
  const read = (pending: number): Effect.Effect<void, unknown> =>
    Effect.tryPromise(() => reader.read()).pipe(
      Effect.flatMap(({ done, value }) => {
        const output = visibleBytes(value ?? new Uint8Array(), pending, done)
        return Effect.callback<void, Error>((resume) => {
          target.write(output.bytes, (error) => resume(error ? Effect.fail(error) : Effect.void))
        }).pipe(Effect.andThen(done ? Effect.void : Effect.suspend(() => read(output.pending))))
      }),
    )
  return read(0)
}

/** Runs a search program without terminal styling and returns its own exit code. */
const runTool = (options: {
  readonly tool: Tool
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}) =>
  Effect.gen(function* () {
    const found = yield* locateTool(options.tool, options.cwd, (command, whichOptions) =>
      Effect.sync(() => findCommand(options.env, command, whichOptions)),
    )
    if (Option.isNone(found)) return yield* new ToolMissing({ tool: options.tool })
    const path = found.value
    const env = { ...definedEnv(options.env), NO_COLOR: "1", FORCE_COLOR: "0", CLICOLOR_FORCE: "0" }
    const child = yield* Effect.try(() =>
      Bun.spawn([path, ...options.args], {
        cwd: options.cwd,
        env,
        stdin: "inherit",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    const [code] = yield* Effect.all(
      [
        Effect.promise(() => child.exited),
        forward(child.stdout, process.stdout),
        forward(child.stderr, process.stderr),
      ],
      { concurrency: "unbounded" },
    ).pipe(Effect.ensuring(Effect.sync(() => child.kill())))
    return code
  })

const toolCommand = (tool: Tool, summary: string): Command => ({
  path: [tool],
  usage: `${tool} <${SEARCH_TOOLS[tool].title} arguments…>`,
  summary,
  notes: [
    `arguments and exit codes follow ${tool}; terminal control bytes in output are displayed as escapes`,
    "the program is the one on PATH (fd also as fdfind, its name on Debian and Ubuntu); when it is not installed, holyagent itself fails with ToolMissing, exits 4 and prints an `error:` line on stderr with the install commands",
  ],
  flags: {},
  stateless: true,
  raw: true,
  passthrough: true,
  positionals: 0,
  run: (call) =>
    runTool({ tool, args: call.args.positionals, cwd: call.cwd, env: call.env }).pipe(
      Effect.map((code) => new Verbatim("", "", code)),
    ),
})

/**
 * The `rg` and `fd` commands: the search programs installed on the machine, behind one interface so
 * that every agent searches the same way.
 */
export const TOOL_COMMANDS: ReadonlyArray<Command> = [
  toolCommand(
    "rg",
    "Search file contents with the ripgrep installed on this machine; runs it with your arguments",
  ),
  toolCommand(
    "fd",
    "Find files and folders by name with the fd installed on this machine (fdfind on Debian and Ubuntu); runs it with your arguments",
  ),
]
