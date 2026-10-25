import { stat } from "node:fs/promises"
import { join } from "node:path"

import { Effect, Schema } from "effect"

import { ROUTES } from "../domain/route.ts"
import { ROOT_CORE } from "../instructions/claude-5.5/root-core.ts"
import { hasCode, io } from "../state/files.ts"
import { STATE_DIRECTORY } from "../state/layout.ts"
import { readOpenState } from "../state/store.ts"
import { PLUGIN_NAMESPACE, recordLaunch } from "./assignment.ts"
import { stateRoot } from "./context.ts"
import { AgentIdMissing, describeFailure, StateFolderMissing } from "./errors.ts"
import { resolveIntent } from "./intent.ts"
import { resumeOf, statusOf } from "./overview.ts"
import { dispatchedAssignment } from "./report.ts"
import { type IntentRequirements, sessionContext } from "./sessioncontext.ts"
import { type GitWrite, gitWrites } from "./shell.ts"
import { type Call, type Command, Verbatim } from "./types.ts"

// The host reads a hook's stdout as JSON and treats exit 2 as a block, while any other failure
// lets the call through unless the hook asks to block on failure. So every failure here is exit 1
// with a line on stderr, and a hook that has nothing to say prints nothing and exits 0.

/** What a hook reads from the host's payload; the other fields are of no use here. */
const Payload = Schema.Struct({
  tool_name: Schema.optionalKey(Schema.String),
  tool_input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  agent_type: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  tool_response: Schema.optionalKey(Schema.Unknown),
})

const NOTHING = new Verbatim("", "", 0)

const output = (hookSpecificOutput: Readonly<Record<string, unknown>>) =>
  new Verbatim(`${JSON.stringify({ hookSpecificOutput })}\n`, "", 0)

const decision = (permissionDecision: "allow" | "deny", permissionDecisionReason: string) =>
  output({ hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason })

/**
 * Runs a hook: a failure becomes one stderr line and exit 1, a notice that authorizes nothing. A
 * `stateless` hook never looks for the state root, so a git failure cannot stop it; `agent-launch`
 * finds the root itself, inside its own failure handling, to report a git failure as context.
 */
const hook = (
  name: string,
  summary: string,
  run: (payload: typeof Payload.Type, call: Call) => Effect.Effect<Verbatim, unknown>,
  stateless?: true,
): Command => ({
  path: ["hook", name],
  usage: `hook ${name}`,
  summary,
  input: "the host's hook payload as JSON",
  output: "the JSON the host reads, or nothing; exit 1 with a stderr line on failure",
  flags: {},
  positionals: 0,
  ...(stateless === undefined ? {} : { stateless }),
  run: (call) =>
    call.text.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))),
      Effect.flatMap((payload) => run(payload, call)),
      Effect.catch((error) =>
        Effect.succeed(
          new Verbatim("", `holyagent hook ${name}: ${describeFailure(error).message}\n`, 1),
        ),
      ),
    ),
})

/** The agent types of the root: the plugin's `agent` setting applied, with or without namespace. */
const ROOT_AGENTS: ReadonlySet<string | undefined> = new Set(["holyagent", "holyagent:holyagent"])

const hasStateFolder = (directory: string) =>
  io(directory, () => stat(directory)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => hasCode(error.cause, "ENOENT"),
      () => Effect.succeed(false),
    ),
  )

/** The SessionStart sources after which pending notices are lost and the Running rows need a check. */
const RESUMED: ReadonlySet<string | undefined> = new Set(["resume", "compact"])

/**
 * The requirements of the Intent in use, as `intent show` resolves it, for a session that lost
 * them; nothing when no Intent is in use.
 */
const requirementsOf = (
  directory: string,
): Effect.Effect<IntentRequirements | undefined, unknown> =>
  readOpenState(directory).pipe(
    Effect.flatMap(resolveIntent),
    Effect.map(({ id, revision, requirements }) => ({ id, revision, requirements })),
    Effect.catchTag("NoActiveIntent", () => Effect.succeed(undefined)),
  )

/** Ids the host makes are short words; anything else is not echoed into a command to run. */
const SAFE_ID = /^[\w.:-]{1,80}$/

/**
 * The agent id of an Agent launch: `agentId` of the tool response, which a background launch
 * (`status: "async_launched"`) and a finished one (`status: "completed"`) both carry.
 */
const launchedAgent = (response: unknown): string | undefined => {
  const agentId =
    typeof response === "object" && response !== null && "agentId" in response
      ? response.agentId
      : undefined
  return typeof agentId === "string" && SAFE_ID.test(agentId) ? agentId : undefined
}

/**
 * What the root does about a launch the hook could not record, for the failures where recording by
 * hand cannot succeed; any other failure may pass on a retry, so it gets the record command.
 */
const HAND_BACK: Readonly<Record<string, string>> = {
  AgentMismatch:
    "The wrong agent was launched: dispatch the Assignment again with the printed agent.",
  StateFolderMissing: "Run the command from the project that holds the Assignment.",
  InvalidTransition: "Check the Assignment with `holyagent assignment show`; it is not Running.",
  UnknownRecord: "Check the id with `holyagent assignment list --all`.",
}

const postToolUse = (additionalContext: string) =>
  output({ hookEventName: "PostToolUse", additionalContext })

const REDIRECTS: Readonly<Record<GitWrite, string>> = {
  commit:
    "Commit with `holyagent vcs commit -m <headline> -- <paths…>`, which commits as the account owner with the Intent's state.",
  push: "Push with `holyagent vcs push [branches…]`.",
}

const SPECIALISTS: ReadonlySet<string> = new Set(ROUTES.map((route) => route.agent))

// An inline Workflow script is JavaScript the root writes on the spot, and the only way it starts an
// agent is the global `agent()`. The hook allows it without a prompt when every start is lexically
// visible and names one of our specialists, so it reads the script with a small lexer instead of
// running it. The lexer allows a narrow subset of JavaScript and reads everything else as unknown:
// ASCII code only outside strings, comments and template text, strict numbers, no computed member
// access, and only names the workflow needs. Anything it cannot place with certainty makes the
// script refused, and a refusal only means the normal permission flow.

/** One token of a script; `template` is a chunk of a template literal, whose text is dropped. */
interface Token {
  readonly kind: "ident" | "number" | "string" | "template" | "punct"
  readonly text: string
}

const PUNCTUATION = "()[]{},;:?.=<>+-*%&|^!~@"
// Names are ASCII: a non-ASCII character in code is refused, so no whitespace lookalike can fuse
// with a name and hide it.
const IDENTIFIER = /[\w$]/
const DIGIT = /\d/
/** The longest script the hook reads, and the deepest template nesting it follows. */
const MAX_SCRIPT = 1_000_000
const MAX_NESTING = 32
const OPENERS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["${", "}"],
])
const CLOSERS: ReadonlySet<string> = new Set(OPENERS.values())

/** The index of the next line end at or after `from`; U+2028 and U+2029 end a line in JavaScript. */
const lineEnd = (source: string, from: number): number => {
  for (let at = from; at < source.length; at += 1) {
    const code = source.charCodeAt(at)
    if (code === 10 || code === 13 || code === 0x2028 || code === 0x2029) return at
  }
  return source.length
}

/**
 * The index after the decimal number that starts at `from`: digits, an optional fraction and an
 * optional exponent, and nothing else (no hex, separator, suffix or member access).
 */
const numberEnd = (source: string, from: number): number => {
  let at = from
  while (DIGIT.test(source.charAt(at))) at += 1
  if (source.charAt(at) === "." && DIGIT.test(source.charAt(at + 1))) {
    at += 1
    while (DIGIT.test(source.charAt(at))) at += 1
  }
  if (source.charAt(at) === "e" || source.charAt(at) === "E") {
    const sign = source.charAt(at + 1) === "+" || source.charAt(at + 1) === "-" ? 1 : 0
    if (DIGIT.test(source.charAt(at + 1 + sign))) {
      at += 1 + sign
      while (DIGIT.test(source.charAt(at))) at += 1
    }
  }
  return at
}

/**
 * The tokens of a script, or undefined when it holds anything the lexer cannot place with
 * certainty: a script or template nesting past the caps, an unterminated string or comment, a
 * non-ASCII character or backslash outside a string, comment or template text (an escaped or
 * lookalike identifier), a number followed by a name or a dot (`5..constructor`), a `/` that is not
 * a comment (division and a regular expression look alike, and a regular expression can hide a
 * quote), a legacy HTML-style comment, or a character that starts no token.
 */
const tokenize = (source: string): ReadonlyArray<Token> | undefined => {
  if (source.length > MAX_SCRIPT) return undefined
  const tokens: Array<Token> = []
  const push = (kind: Token["kind"], text: string) => tokens.push({ kind, text })
  const stringEnd = (from: number): number | undefined => {
    const quote = source.charAt(from)
    for (let at = from + 1; at < source.length; at += 1) {
      const char = source.charAt(at)
      if (char === "\\") at += 1
      else if (char === quote) return at + 1
      else if (char === "\n" || char === "\r") return undefined
    }
    return undefined
  }
  // Reads a template literal that opens at `from` and returns the index after it.
  const template = (from: number, nesting: number): number | undefined => {
    if (nesting > MAX_NESTING) return undefined
    let at = from + 1
    while (at < source.length) {
      const char = source.charAt(at)
      if (char === "\\") at += 2
      else if (char === "`") {
        push("template", "")
        return at + 1
      } else if (source.startsWith("${", at)) {
        push("template", "")
        push("punct", "${")
        const end = code(at + 2, true, nesting + 1)
        if (end === undefined) return undefined
        at = end
      } else at += 1
    }
    return undefined
  }
  // Reads code from `from` to the end of the source, or inside a template substitution to the `}`
  // that closes it, and returns the index after it.
  const code = (from: number, substitution: boolean, nesting: number): number | undefined => {
    let depth = 0
    let at = from
    while (at < source.length) {
      const char = source.charAt(at)
      if (char === " " || char === "\t" || char === "\n" || char === "\r") at += 1
      else if (source.startsWith("//", at)) at = lineEnd(source, at)
      else if (source.startsWith("/*", at)) {
        const end = source.indexOf("*/", at + 2)
        if (end === -1) return undefined
        at = end + 2
      } else if (char === '"' || char === "'") {
        const end = stringEnd(at)
        if (end === undefined) return undefined
        push("string", source.slice(at, end))
        at = end
      } else if (char === "`") {
        const end = template(at, nesting)
        if (end === undefined) return undefined
        at = end
      } else if (DIGIT.test(char)) {
        const end = numberEnd(source, at)
        const next = source.charAt(end)
        if (next === "." || IDENTIFIER.test(next)) return undefined
        push("number", source.slice(at, end))
        at = end
      } else if (IDENTIFIER.test(char)) {
        let end = at
        while (end < source.length && IDENTIFIER.test(source.charAt(end))) end += 1
        push("ident", source.slice(at, end))
        at = end
      } else if (char === "}" && depth === 0) {
        if (!substitution) return undefined
        push("punct", "}")
        return at + 1
      } else if (source.startsWith("<!--", at) || source.startsWith("-->", at)) {
        return undefined
      } else if (source.startsWith("...", at)) {
        push("punct", "...")
        at += 3
      } else if (source.startsWith("?.", at) && !DIGIT.test(source.charAt(at + 2))) {
        push("punct", "?.")
        at += 2
      } else if (PUNCTUATION.includes(char)) {
        if (char === "{") depth += 1
        if (char === "}") depth -= 1
        push("punct", char)
        at += 1
      } else return undefined
    }
    return substitution ? undefined : at
  }
  return code(0, false, 0) === undefined ? undefined : tokens
}

/** The index of the token that closes the opener at `open`, or undefined when unbalanced. */
const closeOf = (tokens: ReadonlyArray<Token>, open: number): number | undefined => {
  const expected: Array<string> = []
  for (let at = open; at < tokens.length; at += 1) {
    const token = tokens[at]
    if (token?.kind !== "punct") continue
    const closer = OPENERS.get(token.text)
    if (closer !== undefined) expected.push(closer)
    else if (CLOSERS.has(token.text)) {
      if (expected.pop() !== token.text) return undefined
      if (expected.length === 0) return at
    }
  }
  return undefined
}

/** The index of the opener that the closer at `close` ends, or undefined when unbalanced. */
const openOf = (tokens: ReadonlyArray<Token>, close: number): number | undefined => {
  let depth = 0
  for (let at = close; at >= 0; at -= 1) {
    const token = tokens[at]
    if (token?.kind !== "punct") continue
    if (CLOSERS.has(token.text)) depth += 1
    else if (OPENERS.has(token.text)) depth -= 1
    if (depth === 0) return at
  }
  return undefined
}

/** True when every bracket of the script closes with its own kind, in order. */
const balanced = (tokens: ReadonlyArray<Token>): boolean => {
  const expected: Array<string> = []
  for (const token of tokens) {
    if (token.kind !== "punct") continue
    const closer = OPENERS.get(token.text)
    if (closer !== undefined) expected.push(closer)
    else if (CLOSERS.has(token.text) && expected.pop() !== token.text) return false
  }
  return expected.length === 0
}

/** The tokens split at the commas outside every bracket; a trailing comma adds no part. */
const splitTop = (tokens: ReadonlyArray<Token>): ReadonlyArray<ReadonlyArray<Token>> => {
  const parts: Array<Array<Token>> = [[]]
  let depth = 0
  for (const token of tokens) {
    if (token.kind === "punct") {
      if (OPENERS.has(token.text)) depth += 1
      else if (CLOSERS.has(token.text)) depth -= 1
      else if (token.text === "," && depth === 0) {
        parts.push([])
        continue
      }
    }
    parts.at(-1)?.push(token)
  }
  return parts.at(-1)?.length === 0 ? parts.slice(0, -1) : parts
}

/**
 * True for a string-literal token that reads `holyagent:<agent>` with a specialist of the route
 * table.
 */
const namesOurSpecialist = (token: Token | undefined): boolean => {
  if (token?.kind !== "string") return false
  const text = token.text.slice(1, -1)
  const prefix = `${PLUGIN_NAMESPACE}:`
  return (
    !text.includes("\\") && text.startsWith(prefix) && SPECIALISTS.has(text.slice(prefix.length))
  )
}

/** The options of `agent()` the hook lets a script set; any other key refuses the call. */
const AGENT_OPTIONS: ReadonlySet<string> = new Set([
  "agentType",
  "model",
  "effort",
  "label",
  "phase",
])

/**
 * True when the arguments of one `agent(prompt, options)` call are two plain arguments, the second
 * an object literal of the {@link AGENT_OPTIONS} keys with exactly one `agentType` property whose
 * value is a string literal naming one of our specialists. A spread, computed or escaped key, a
 * getter and any other key could set another agent type or option, so each refuses the call.
 */
const startsOurAgent = (args: ReadonlyArray<Token>): boolean => {
  const [prompt, options, ...rest] = splitTop(args)
  if (rest.length > 0 || prompt === undefined || prompt.length === 0) return false
  if (prompt[0]?.text === "..." || options === undefined) return false
  if (options[0]?.text !== "{" || closeOf(options, 0) !== options.length - 1) return false
  let named = 0
  for (const property of splitTop(options.slice(1, -1))) {
    const [key, colon, ...value] = property
    const name = key?.kind === "string" ? key.text.slice(1, -1) : key?.text
    if (key === undefined || (key.kind !== "ident" && key.kind !== "string")) return false
    if (name === undefined || !AGENT_OPTIONS.has(name)) return false
    if (name === "agentType") {
      if (colon?.text !== ":" || value.length !== 1 || !namesOurSpecialist(value[0])) return false
      named += 1
    } else if (colon === undefined ? key.kind !== "ident" : colon.text !== ":") return false
  }
  return named === 1
}

/**
 * Names that reach reflection, other scopes or other code, refused wherever they appear: as a name,
 * a property, a key or a declaration.
 */
const DENIED_NAMES: ReadonlySet<string> = new Set([
  "arguments",
  "apply",
  "bind",
  "call",
  "callee",
  "caller",
  "constructor",
  "defineProperties",
  "defineProperty",
  "eval",
  "Function",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getPrototypeOf",
  "global",
  "globalThis",
  "import",
  "process",
  "prototype",
  "Proxy",
  "Reflect",
  "require",
  "self",
  "setPrototypeOf",
  "this",
  "window",
  "with",
  "workflow",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
  "__proto__",
])

/**
 * The names a script may use without declaring them: the workflow globals, the JavaScript keywords
 * it needs and the plain built-ins. Any other name must be declared by the script itself.
 */
const ALLOWED_NAMES: ReadonlySet<string> = new Set([
  "agent",
  "args",
  "budget",
  "log",
  "parallel",
  "phase",
  "pipeline",
  "Array",
  "Boolean",
  "Error",
  "Infinity",
  "isFinite",
  "isNaN",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "parseFloat",
  "parseInt",
  "Promise",
  "Set",
  "String",
  "undefined",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "const",
  "continue",
  "default",
  "do",
  "else",
  "export",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "switch",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
])

/**
 * Keywords after which a `[` opens an array literal or a destructuring pattern rather than a
 * computed member access.
 */
const ARRAY_AFTER: ReadonlySet<string> = new Set([
  "await",
  "case",
  "const",
  "else",
  "in",
  "instanceof",
  "let",
  "of",
  "return",
  "throw",
  "typeof",
  "var",
  "void",
  "yield",
])

/**
 * True when a `[` follows a name, a closing bracket, a number, a string or a template, or `?.`:
 * computed member access, which can build a name such as `constructor` from text. Array literals
 * after an operator, an opening bracket or a keyword are not computed access.
 */
const hasComputedAccess = (tokens: ReadonlyArray<Token>): boolean =>
  tokens.some((token, at) => {
    const before = tokens[at - 1]
    if (token.kind !== "punct" || token.text !== "[" || before === undefined) return false
    if (before.kind === "punct") return [")", "]", "}", "?."].includes(before.text)
    return before.kind !== "ident" || !ARRAY_AFTER.has(before.text)
  })

/**
 * The names a parameter list or destructuring pattern binds, from its tokens with their brackets: a
 * name between an opener or comma (or `...` or `:`) and a closer or comma. A pattern with a default
 * value (`=`) binds nothing here, since its names would mix with expressions.
 */
const bindingsIn = (region: ReadonlyArray<Token>): ReadonlyArray<string> =>
  region.some((token) => token.kind === "punct" && token.text === "=")
    ? []
    : region.flatMap((token, at) => {
        const before = region[at - 1]
        const after = region[at + 1]
        return token.kind === "ident" &&
          before?.kind === "punct" &&
          ["(", "[", "{", ",", "...", ":"].includes(before.text) &&
          after?.kind === "punct" &&
          [",", ")", "]", "}"].includes(after.text)
          ? [token.text]
          : []
      })

/**
 * The names the script declares itself, in the forms it is likely to use: `const`, `let` and `var`
 * (a name or a simple pattern), function names and parameters, arrow parameters, and `catch`. Any
 * other form declares nothing here, so a name bound that way is refused when used.
 */
const declaredNames = (tokens: ReadonlyArray<Token>): ReadonlySet<string> => {
  const names = new Set<string>()
  const region = (open: number): ReadonlyArray<Token> => {
    const close = closeOf(tokens, open)
    return close === undefined ? [] : tokens.slice(open, close + 1)
  }
  for (const [at, token] of tokens.entries()) {
    const next = tokens[at + 1]
    if (token.kind === "ident" && ["const", "let", "var"].includes(token.text)) {
      if (next?.kind === "ident") names.add(next.text)
      else if (next?.kind === "punct" && (next.text === "[" || next.text === "{"))
        for (const name of bindingsIn(region(at + 1))) names.add(name)
    } else if (token.kind === "ident" && token.text === "function") {
      const open = next?.kind === "ident" ? at + 2 : at + 1
      if (next?.kind === "ident") names.add(next.text)
      if (tokens[open]?.text === "(") for (const name of bindingsIn(region(open))) names.add(name)
    } else if (token.kind === "ident" && token.text === "catch" && next?.text === "(") {
      for (const name of bindingsIn(region(at + 1))) names.add(name)
    } else if (token.kind === "punct" && token.text === "=" && next?.text === ">") {
      const before = tokens[at - 1]
      if (before?.kind === "ident") names.add(before.text)
      else if (before?.text === ")") {
        const open = openOf(tokens, at - 1)
        if (open !== undefined) for (const name of bindingsIn(region(open))) names.add(name)
      }
    }
  }
  return names
}

/** Words that may stand before `agent(` in a call; after any other name it declares or constructs. */
const CALL_PREFIXES: ReadonlySet<string> = new Set(["await", "return"])

/**
 * True when the script starts agents and every start is a direct `agent(prompt, {…agentType:
 * "holyagent:<specialist>"…})` call, and it uses only names it may: the workflow globals and plain
 * built-ins, and names it declares. A mention of `agent` that is not such a call (an alias, a
 * parameter, `.call`) refuses the script, as do `workflow`, reflection, an undeclared name and any
 * computed member access.
 */
const onlyOurAgents = (script: string): boolean => {
  const tokens = tokenize(script)
  if (tokens === undefined || !balanced(tokens) || hasComputedAccess(tokens)) return false
  const declared = declaredNames(tokens)
  let starts = 0
  for (const [at, token] of tokens.entries()) {
    if (token.kind !== "ident") continue
    if (DENIED_NAMES.has(token.text)) return false
    const before = tokens[at - 1]
    const after = tokens[at + 1]
    const member = before?.kind === "punct" && (before.text === "." || before.text === "?.")
    const called = after?.kind === "punct" && after.text === "("
    // `entry.agent` and `{ agent: 1 }` name a property; they start nothing.
    const key =
      before?.kind === "punct" &&
      (before.text === "{" || before.text === ",") &&
      after?.kind === "punct" &&
      after.text === ":"
    if ((member && !(token.text === "agent" && called)) || key) continue
    if (token.text !== "agent") {
      if (!ALLOWED_NAMES.has(token.text) && !declared.has(token.text)) return false
      continue
    }
    const close = called ? closeOf(tokens, at + 1) : undefined
    // After a name other than `await` or `return`, `agent(` declares a function or constructs one.
    if (before?.kind === "ident" && !CALL_PREFIXES.has(before.text)) return false
    if (member || close === undefined) return false
    if (!startsOurAgent(tokens.slice(at + 2, close))) return false
    starts += 1
  }
  return starts > 0
}

/** The Workflow inputs an inline run may carry; a script path, name or resume would run other code. */
const INLINE_INPUTS: ReadonlySet<string> = new Set(["script", "args"])

// The vcs-redirect hook only sees what the `if` rules of hooks.json let through, and those match
// the command text: `git` followed by `commit` or `push` anywhere in it. A command that hides the
// words escapes it: a variable (`g=git; $g commit`), a git alias (`git ci`), or a script, make
// target or package script that runs git inside. Wrappers, `sh -c`, `xargs`, subshells and
// substitutions that show the words reach the scanner and are denied.

/** The `hook` commands the plugin's hooks call. */
export const HOOK_COMMANDS: ReadonlyArray<Command> = [
  hook(
    "session-start",
    "SessionStart: add the status of the open Intents as context, with the reconcile result and the requirements of the Intent in use after a resume or compaction (and the core root rules when the root agent is not the main thread), always ending with a short block of the root rules most often missed; nothing without a .holyagent folder",
    (payload, call) =>
      Effect.gen(function* () {
        if (!(yield* hasStateFolder(call.directory))) return NOTHING
        const pluginRoot = call.env.CLAUDE_PLUGIN_ROOT
        // The host fills in ${CLAUDE_PLUGIN_ROOT} in agent text only, and this text is context.
        const core = ROOT_CORE.replaceAll(
          "${CLAUDE_PLUGIN_ROOT}",
          pluginRoot ?? "${CLAUDE_PLUGIN_ROOT}",
        )
        const { status, reconcile } = RESUMED.has(payload.source)
          ? yield* resumeOf(call.directory)
          : { status: yield* statusOf(call.directory), reconcile: undefined }
        return output({
          hookEventName: "SessionStart",
          additionalContext: sessionContext(
            status,
            ROOT_AGENTS.has(payload.agent_type) ? undefined : core,
            reconcile,
            RESUMED.has(payload.source) ? yield* requirementsOf(call.directory) : undefined,
          ),
        })
      }),
  ),
  hook(
    "agent-launch",
    "PostToolUse for Agent: when the prompt came from assignment dispatch, record the launched agent (assignment record <id> --agent <agentId>) and say so; on failure ask the root to record it; nothing for any other launch",
    (payload, call) => {
      const prompt = payload.tool_name === "Agent" ? payload.tool_input?.prompt : undefined
      const id = typeof prompt === "string" ? dispatchedAssignment(prompt) : undefined
      if (id === undefined) return Effect.succeed(NOTHING)
      const agentId = launchedAgent(payload.tool_response)
      // Recording is bookkeeping and authorizes nothing, so any failure only hands the step back.
      return Effect.gen(function* () {
        if (agentId === undefined) return yield* new AgentIdMissing()
        const directory = join(yield* stateRoot(call.cwd), STATE_DIRECTORY)
        // The state folder is not made here: a project without one has no Assignment to record.
        if (!(yield* hasStateFolder(directory))) return yield* new StateFolderMissing()
        const type = payload.tool_input?.subagent_type
        yield* recordLaunch(directory, id, agentId, {
          type: typeof type === "string" ? type : undefined,
        })
        return postToolUse(`holyagent: recorded agent ${agentId} for ${id}.`)
      }).pipe(
        Effect.catch((error) => {
          const { tag } = describeFailure(error)
          const next =
            HAND_BACK[tag] ??
            `Run \`holyagent assignment record ${id} --agent ${agentId ?? "<agentId>"}\` yourself.`
          return Effect.succeed(
            postToolUse(`holyagent: could not record the launch of ${id} (${tag}). ${next}`),
          )
        }),
      )
    },
    true,
  ),
  hook(
    "vcs-redirect",
    "PreToolUse for Bash: deny a command that runs git commit or git push and point to holyagent vcs; say nothing otherwise",
    (payload) => {
      const command = payload.tool_name === "Bash" ? payload.tool_input?.command : undefined
      const writes = typeof command === "string" ? gitWrites(command) : []
      return Effect.succeed(
        writes.length === 0
          ? NOTHING
          : decision("deny", writes.map((write) => REDIRECTS[write]).join(" ")),
      )
    },
    true,
  ),
  hook(
    "workflow",
    "PreToolUse for Workflow: allow an inline script whose every agent() call names one of this plugin's specialists by a string-literal agentType, with no script path, name or resume; say nothing otherwise",
    (payload) => {
      const input = payload.tool_input ?? {}
      const inline =
        payload.tool_name === "Workflow" &&
        typeof input.script === "string" &&
        Object.keys(input).every((key) => INLINE_INPUTS.has(key)) &&
        onlyOurAgents(input.script)
      return Effect.succeed(
        inline
          ? decision(
              "allow",
              "Inline workflow script whose every agent() call is a holyagent specialist.",
            )
          : NOTHING,
      )
    },
    true,
  ),
]
