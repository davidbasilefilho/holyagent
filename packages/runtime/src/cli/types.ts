import type { Effect, Schema } from "effect"

import type { ExecutionConfig } from "../domain/directive.ts"
import type { InvalidDraft } from "../domain/errors.ts"
import type { FlagSpec, Parsed } from "./args.ts"
import type { StdinMissing, Usage } from "./errors.ts"

/**
 * A result printed as TOON fields, then a line `<label>:` alone, then the text verbatim to the end
 * of the output. TOON has no multi-line string, so text meant to be copied as it is goes here.
 */
export class WithTrailer {
  /** Builds a result from its TOON fields, the trailer label and the verbatim text. */
  constructor(
    readonly fields: Readonly<Record<string, unknown>>,
    readonly label: string,
    readonly text: string,
  ) {}
}

/**
 * A result printed exactly as it is, with its own exit code, for a caller that reads stdout as
 * something other than TOON, such as a host hook.
 */
export class Verbatim {
  /** Builds a result from the text of stdout and stderr and the exit code. */
  constructor(
    readonly stdout: string,
    readonly stderr: string,
    readonly code: number,
  ) {}
}

/** What the CLI needs from the process it runs in; tests supply their own. */
export interface Host {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The text on stdin, or StdinMissing when stdin is a terminal. */
  readonly stdin: Effect.Effect<string, StdinMissing>
}

/** Everything a command may use while it runs. */
export interface Call {
  readonly args: Parsed
  /** The `.holyagent` folder of the state root. */
  readonly directory: string
  /** The warm-reuse settings from the environment and the settings files. */
  readonly config: Effect.Effect<ExecutionConfig, Usage>
  /** Reads stdin as raw text; blank input is StdinMissing. */
  readonly text: Effect.Effect<string, StdinMissing>
  /** Reads stdin as JSON and decodes it strictly; unknown fields are refused. */
  readonly input: <S extends Schema.Decoder<unknown>>(
    schema: S,
  ) => Effect.Effect<S["Type"], StdinMissing | InvalidDraft, S["DecodingServices"]>
  /** Like `input`, with the schema chosen from the parsed JSON, for a command with two shapes. */
  readonly inputBy: <S extends Schema.Decoder<unknown>>(
    pick: (raw: unknown) => S,
  ) => Effect.Effect<S["Type"], StdinMissing | InvalidDraft, S["DecodingServices"]>
}

/** One CLI command: its words, help and implementation. */
export interface Command {
  readonly path: ReadonlyArray<string>
  /** The usage line without the program name, such as `intent show [id]`. */
  readonly usage: string
  readonly summary: string
  /** The shape of the JSON on stdin, when the command reads any. */
  readonly input?: string
  /** What stdout holds when it is more than TOON, such as a trailer after the fields. */
  readonly output?: string
  readonly flags: FlagSpec
  /** How many positional arguments the command takes. */
  readonly positionals: number
  /** True when the last positional may be left out. */
  readonly optional?: true
  /** Produces the value printed as TOON. */
  readonly run: (call: Call) => Effect.Effect<unknown, unknown>
}
