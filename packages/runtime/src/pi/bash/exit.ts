import { Effect } from "effect"
import {
  type Command,
  type CommandNode,
  defineCommand,
  type ExecResult,
  parse,
  type ResolvedCommandContext,
  type TransformPlugin,
  type WordNode,
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

// Whether `node` is a simple command whose name is one literal word from `names`.
const isNamed = (
  node: unknown,
  names: ReadonlySet<string>,
): node is Extract<CommandNode, { type: "SimpleCommand" }> => {
  if (typeof node !== "object" || node === null) return false
  const { type, name } = node as { type?: unknown; name?: { parts?: ReadonlyArray<unknown> } }
  if (type !== "SimpleCommand" || name?.parts?.length !== 1) return false
  const [part] = name.parts as ReadonlyArray<{ type?: unknown; value?: unknown }>
  return part?.type === "Literal" && typeof part.value === "string" && names.has(part.value)
}

const EXIT_COMMAND: ReadonlySet<string> = new Set(["exit"])

const isExit = (node: unknown): node is Extract<CommandNode, { type: "SimpleCommand" }> =>
  isNamed(node, EXIT_COMMAND)

// `{ holyagent-snapshot <locals>; exit; }` with the real `exit` command put in the place of the
// second one, so that its arguments and redirections stay as written.
const around = (exit: CommandNode, locals: ReadonlyArray<string>): CommandNode => {
  const [statement] = parse(`{ ${[SNAPSHOT, ...locals].join(" ")}; exit; }`).statements
  const group = statement?.pipelines[0]?.commands[0]
  if (group?.type !== "Group") return exit
  const last = group.body[1]?.pipelines[0]
  if (last === undefined) return exit
  last.commands[0] = exit
  return group
}

const LOCAL_COMMANDS: ReadonlySet<string> = new Set(["local", "declare", "typeset"])

// The variable a word of `local` names, when it is written out literally (`a`, `a=1`, `a=$X`).
const declaredName = (word: WordNode): string | undefined => {
  const [first] = word.parts
  if (first?.type !== "Literal") return undefined
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(=|$)/.exec(first.value)
  return match !== null && (match[2] === "=" || word.parts.length === 1) ? match[1] : undefined
}

const literalOf = (word: WordNode): string | undefined =>
  word.parts.length === 1 && word.parts[0]?.type === "Literal" ? word.parts[0].value : undefined

// Collects the variables that `local` (or `declare` and `typeset` without `-g`) makes local to a
// function, anywhere below `node`.
const collectLocals = (node: unknown, found: Set<string>): void => {
  if (Array.isArray(node)) return node.forEach((item) => collectLocals(item, found))
  if (typeof node !== "object" || node === null) return
  if (isNamed(node, LOCAL_COMMANDS)) {
    const [command] = node.name?.parts ?? []
    const global =
      command?.type === "Literal" &&
      command.value !== "local" &&
      node.args.some((word) => /^-\w*g/.test(literalOf(word) ?? ""))
    if (!global)
      for (const word of node.args) {
        const name = declaredName(word)
        if (name !== undefined) found.add(name)
      }
  }
  for (const value of Object.values(node)) collectLocals(value, found)
}

// Replaces every `exit` command below `node` (functions, subshells and substitutions included) and
// reports how many there were. `locals` are the names an `exit` inside a function leaves out.
const wrapExits = (node: unknown, locals: ReadonlyArray<string>, inFunction: boolean): number => {
  if (Array.isArray(node)) {
    let count = 0
    node.forEach((item, at) => {
      count += wrapExits(item, locals, inFunction)
      if (isExit(item)) {
        node[at] = around(item, inFunction ? locals : [])
        count += 1
      }
    })
    return count
  }
  if (typeof node !== "object" || node === null) return 0
  const inside = inFunction || (node as { type?: unknown }).type === "FunctionDef"
  return Object.values(node).reduce<number>(
    (count, value) => count + wrapExits(value, locals, inside),
    0,
  )
}

const status = (ctx: ResolvedCommandContext): Effect.Effect<ExecResult> =>
  Effect.succeed({ stdout: "", stderr: "", exitCode: Number(ctx.env.get("?") ?? 0) || 0 })

/**
 * Keeps the shell's state across an `exit`. just-bash drops the folder and the variables of a run
 * that `exit` ends, and has neither `trap ... EXIT` nor a way to override `exit`, so the script is
 * changed before it runs: each `exit` command is preceded by {@link SNAPSHOT}, which records the
 * state, and {@link DONE} is added at the end, which tells a script that ran to its end (whose state
 * just-bash reports itself) from one `exit` ended. Both commands pass the exit status on unchanged,
 * so `exit` with no argument and `$?` behave as before. An `exit` inside a function is given the
 * names that `local` declares anywhere in the script (the function may be called from another one),
 * which are not session state: the snapshot leaves them out and keeps the value the run `start`ed
 * with. Only the first script of a run is changed, which is the command line; scripts that commands
 * start (`bash -c`) are left alone. A script with no `exit` is not changed at all.
 */
export const watchExit = (start: Readonly<Record<string, string>>): ExitWatch => {
  let first = true
  let completed = false
  let recorded: ExitState | undefined
  const snapshot = defineCommand(SNAPSHOT, (locals, ctx) => {
    // A local variable is not the session's: it goes, and the value the run started with stands in.
    const env = Object.fromEntries(ctx.env)
    for (const name of locals) {
      delete env[name]
      const original = start[name]
      if (original !== undefined) env[name] = original
    }
    recorded = { cwd: ctx.cwd, env }
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
        const locals = new Set<string>()
        collectLocals(ast.statements, locals)
        if (wrapExits(ast.statements, [...locals].sort(), false) > 0) {
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
