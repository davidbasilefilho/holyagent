import type { Effect, Layer, Schema } from "effect"

import type { ExecutionConfig } from "../domain/directive.ts"
import type { InvalidDraft } from "../domain/errors.ts"
import type { Snapshot, StateChange, updateState } from "../state/store.ts"
import type { Ensure } from "../state/tree.ts"
import type { Git } from "../vcs/git.ts"
import type { GitHub } from "../vcs/github.ts"
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

/**
 * What a command returns after it printed its own lines through {@link Call.emit}: nothing is
 * encoded, and the run ends with this exit code.
 */
export class Streamed {
  /** Ends the run with the exit code. */
  constructor(readonly code: number) {}
}

/** What the CLI needs from the process it runs in; tests supply their own. */
export interface Host {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The text on stdin, or StdinMissing when stdin is a terminal. */
  readonly stdin: Effect.Effect<string, StdinMissing>
  /** Writes text to stdout as it happens; without it the text joins the output at the end. */
  readonly emit?: (text: string) => Effect.Effect<void>
  /** Git and GitHub for the `vcs` commands; the real ones when absent. */
  readonly vcs?: Layer.Layer<Git | GitHub>
  /**
   * The folder of the bundled search tools for the `rg` and `fd` commands; the plugin's when
   * absent.
   */
  readonly tools?: string
}

/** Everything a command may use while it runs. */
export interface Call {
  readonly args: Parsed
  /** The working directory of the process. */
  readonly cwd: string
  /** The environment of the process. */
  readonly env: Host["env"]
  /** The top-level folder of the work tree the command runs in. */
  readonly root: string
  /**
   * The `.holyagent` folder that holds the state: the one in the state worktree, the same from
   * every work tree of the clone.
   */
  readonly directory: string
  /**
   * Applies a transition to the state and commits the changed records on the state branch (see
   * `updateState`), with the environment of the process.
   */
  readonly update: <A extends StateChange, E>(
    transition: (snapshot: Snapshot) => Effect.Effect<A, E>,
  ) => ReturnType<typeof updateState<A, E>>
  /** The warm-reuse settings from the environment and the settings files. */
  readonly config: Effect.Effect<ExecutionConfig, Usage>
  /** Reads stdin as raw text; blank input is StdinMissing. */
  readonly text: Effect.Effect<string, StdinMissing>
  /** Prints text now, for a command whose output arrives over time. */
  readonly emit: (text: string) => Effect.Effect<void>
  /** Git and GitHub for the `vcs` commands. */
  readonly vcs: Layer.Layer<Git | GitHub>
  /** The folder of the bundled search tools, with one subfolder for each target. */
  readonly tools: string
  /**
   * Reads the JSON payload, from the inline `--input` flag when the command has it and it was
   * given, else from stdin, and decodes it strictly; unknown fields are refused. With the flag,
   * stdin is not read, so a pipe that never closes cannot block the command.
   */
  readonly input: <S extends Schema.Decoder<unknown>>(
    schema: S,
  ) => Effect.Effect<S["Type"], StdinMissing | Usage | InvalidDraft, S["DecodingServices"]>
  /** Like `input`, with the schema chosen from the parsed JSON, for a command with two shapes. */
  readonly inputBy: <S extends Schema.Decoder<unknown>>(
    pick: (raw: unknown) => S,
  ) => Effect.Effect<S["Type"], StdinMissing | Usage | InvalidDraft, S["DecodingServices"]>
}

/** One CLI command: its words, help and implementation. */
export interface Command {
  readonly path: ReadonlyArray<string>
  /** The usage line without the program name, such as `intent show [id]`. */
  readonly usage: string
  readonly summary: string
  /**
   * The shape of the JSON payload (stdin, or `--input` when the command takes the flag), when the
   * command reads any.
   */
  readonly input?: string
  /** What stdout holds when it is more than TOON, such as a trailer after the fields. */
  readonly output?: string
  /** Further help lines, for what the model must know to use the command without a manual. */
  readonly notes?: ReadonlyArray<string>
  readonly flags: FlagSpec
  /** True when the command needs neither the state root nor git, so no git runs before it. */
  readonly stateless?: true
  /**
   * How far the command goes to find the state (see {@link Ensure}); `ifPresent` when absent. A
   * function chooses from the parsed arguments, for a command that only sometimes writes.
   */
  readonly state?: Ensure | ((args: Parsed) => Ensure)
  /** True when the command reads its own arguments: they arrive unparsed in `args.positionals`. */
  readonly raw?: true
  /**
   * True when the command hands its arguments to another program, so `--help` and `-h` reach that
   * program instead of showing the help of the command. Only for a `raw` command.
   */
  readonly passthrough?: true
  /** How many positional arguments the command takes. */
  readonly positionals: number
  /** True when the last positional may be left out. */
  readonly optional?: true
  /** Produces the value printed as TOON. */
  readonly run: (call: Call) => Effect.Effect<unknown, unknown>
}
