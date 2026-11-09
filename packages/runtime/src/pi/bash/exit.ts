import { Effect } from "effect"
import {
  type Command,
  type CommandNode,
  defineCommand,
  type ExecResult,
  parse,
  type ResolvedCommandContext,
  type TransformPlugin,
} from "just-bash"

/** The command that records the shell's state just before an `exit`; it stands in for no program. */
export const SNAPSHOT = "holyagent-snapshot"

/** The command that marks a script as having run to its end, so no `exit` ended it. */
export const DONE = "holyagent-done"

/** The state a script left when `exit` ended it. */
export interface ExitState {
  /** The working folder, as the shell names it. */
  readonly cwd: string
  /** Every variable of the shell. */
  readonly env: Readonly<Record<string, string>>
}

/** What {@link watchExit} gives the shell: the plugin, the commands it needs, and the result. */
export interface ExitWatch {
  /** Rewrites the script about to run, once: see {@link watchExit}. */
  readonly plugin: TransformPlugin
  /** The two commands the rewritten script calls; register them with the shell. */
  readonly commands: ReadonlyArray<Command>
  /** The state `exit` left, or `undefined` when the script ended any other way. */
  readonly exited: () => ExitState | undefined
}

const isExit = (node: unknown): node is Extract<CommandNode, { type: "SimpleCommand" }> => {
  if (typeof node !== "object" || node === null) return false
  const { type, name } = node as { type?: unknown; name?: { parts?: ReadonlyArray<unknown> } }
  if (type !== "SimpleCommand" || name?.parts?.length !== 1) return false
  const [part] = name.parts as ReadonlyArray<{ type?: unknown; value?: unknown }>
  return part?.type === "Literal" && part.value === "exit"
}

// `{ holyagent-snapshot; exit; }` with the real `exit` command put in the place of the second one,
// so that its arguments and redirections stay as written.
const around = (exit: CommandNode): CommandNode => {
  const [statement] = parse(`{ ${SNAPSHOT}; exit; }`).statements
  const group = statement?.pipelines[0]?.commands[0]
  if (group?.type !== "Group") return exit
  const last = group.body[1]?.pipelines[0]
  if (last === undefined) return exit
  last.commands[0] = exit
  return group
}

// Replaces every `exit` command below `node` (functions, subshells and substitutions included) and
// reports how many there were.
const wrapExits = (node: unknown): number => {
  if (Array.isArray(node)) {
    let count = 0
    node.forEach((item, at) => {
      count += wrapExits(item)
      if (isExit(item)) {
        node[at] = around(item)
        count += 1
      }
    })
    return count
  }
  if (typeof node !== "object" || node === null) return 0
  return Object.values(node).reduce<number>((count, value) => count + wrapExits(value), 0)
}

const status = (ctx: ResolvedCommandContext): Effect.Effect<ExecResult> =>
  Effect.succeed({ stdout: "", stderr: "", exitCode: Number(ctx.env.get("?") ?? 0) || 0 })

/**
 * Keeps the shell's state across an `exit`. just-bash drops the folder and the variables of a run
 * that `exit` ends, and has neither `trap ... EXIT` nor a way to override `exit`, so the script is
 * changed before it runs: each `exit` command is preceded by {@link SNAPSHOT}, which records the
 * state, and {@link DONE} is added at the end, which tells a script that ran to its end (whose state
 * just-bash reports itself) from one `exit` ended. Both commands pass the exit status on unchanged,
 * so `exit` with no argument and `$?` behave as before. Only the first script of a run is changed,
 * which is the command line; scripts that commands start (`bash -c`) are left alone. A script with
 * no `exit` is not changed at all.
 */
export const watchExit = (): ExitWatch => {
  let first = true
  let completed = false
  let recorded: ExitState | undefined
  const snapshot = defineCommand(SNAPSHOT, (_args, ctx) => {
    recorded = { cwd: ctx.cwd, env: Object.fromEntries(ctx.env) }
    return Effect.runPromise(status(ctx))
  })
  const done = defineCommand(DONE, (_args, ctx) => {
    completed = true
    return Effect.runPromise(status(ctx))
  })
  return {
    plugin: {
      name: "holyagent-exit",
      transform: ({ ast }) => {
        if (!first) return { ast }
        first = false
        if (wrapExits(ast.statements) > 0) {
          const [end] = parse(DONE).statements
          if (end !== undefined) ast.statements.push(end)
        }
        return { ast }
      },
    },
    commands: [snapshot, done],
    exited: () => (completed ? undefined : recorded),
  }
}
