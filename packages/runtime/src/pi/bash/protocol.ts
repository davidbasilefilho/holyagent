import { Data, Effect, Schema } from "effect"

/**
 * The file name of the shell process's bundle in the Pi package's `scripts` folder, which the
 * extension starts with Bun for each call and the build writes from `entry.ts`.
 */
export const SHELL_BUNDLE = "just-bash.js"

/**
 * What the extension (under Node) sends the shell process (under Bun) on its standard input, as one
 * JSON line: the command, the working folder as the host names it, and the whole environment the
 * command runs with (the one Pi gives the call, with the changes earlier calls kept applied).
 */
export const ShellRequest = Schema.Struct({
  command: Schema.String,
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
})
/** One request to the shell process. */
export type ShellRequest = typeof ShellRequest.Type

/**
 * What a run changed in the shell's state, so the next call can start from it: the variables it set
 * or changed, and the ones it unset. Only changes against the request's environment are listed,
 * never the whole environment.
 */
export const EnvChanges = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.String),
  unset: Schema.Array(Schema.String),
})
/** The environment changes of one run. */
export type EnvChanges = typeof EnvChanges.Type

/**
 * One line the shell process writes on its standard output. `data` is a chunk of the command's
 * output (standard output and error together, as the model sees them), in base64 so binary output
 * passes unchanged; `end` closes the run with the exit code and the state the command left (the
 * working folder as the host names it, and the environment changes); `failure` says the shell
 * itself could not run the command.
 */
export const ShellFrame = Schema.Union([
  Schema.Struct({ type: Schema.Literal("data"), data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("end"),
    exitCode: Schema.Number,
    cwd: Schema.String,
    changes: EnvChanges,
  }),
  Schema.Struct({ type: Schema.Literal("failure"), message: Schema.String }),
])
/** One frame of the shell process's output. */
export type ShellFrame = typeof ShellFrame.Type

/** A line of the shell process's output, or its input, is not a frame or a request. */
export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  readonly line: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `the shell process wrote a line that is not a frame (${this.reason}): ${this.line.slice(0, 200)}`
  }
}

const strict = { onExcessProperty: "error" } as const

const decodeFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(ShellFrame), strict)

/** Reads one output line as a frame. */
export const parseFrame = (line: string): Effect.Effect<ShellFrame, ProtocolError> =>
  decodeFrame(line).pipe(
    Effect.mapError((error) => new ProtocolError({ line, reason: error.message })),
  )

/** The line that carries a frame: JSON and a newline. */
export const frameLine = (frame: ShellFrame): string => `${JSON.stringify(frame)}\n`

const decodeRequest = Schema.decodeUnknownEffect(Schema.fromJsonString(ShellRequest), strict)

/** Reads the request line the extension wrote. */
export const parseRequest = (text: string): Effect.Effect<ShellRequest, ProtocolError> =>
  decodeRequest(text).pipe(
    Effect.mapError((error) => new ProtocolError({ line: text, reason: error.message })),
  )

/** The line that carries a request: JSON and a newline. */
export const requestLine = (request: ShellRequest): string => `${JSON.stringify(request)}\n`
