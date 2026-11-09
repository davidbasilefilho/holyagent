import { isAbsolute, relative, resolve, sep } from "node:path"

import { MAX_ACTION_STRING_TOKENS, truncateText } from "./transcript.ts"

/**
 * Why a tool call goes to review. Codex reviews what its sandbox would otherwise stop and ask a
 * human about; Pi has no sandbox, so the classifier stands in for that signal.
 *
 * - `command`: a shell command outside the read-only safe set (Codex's escalation request).
 * - `write-outside-root`: a file write below no folder of the project (Codex's edit outside the
 *   writable roots).
 * - `network`: a command or tool that reaches the network (Codex's network approval).
 * - `tool-approval`: a tool whose annotations ask for approval (Codex's MCP tool approval).
 */
export type TriggerKind = "command" | "write-outside-root" | "network" | "tool-approval"

/** A tool call that goes to review, with the reason shown to the reviewer. */
export interface Trigger {
  readonly kind: TriggerKind
  readonly reason: string
}

/** The tool call as the `tool_call` event carries it. */
export interface ToolCallInput {
  readonly toolName: string
  readonly input: Readonly<Record<string, unknown>>
}

/** What the registry says about a tool: the hints an MCP server gives, and whether it is one's tool. */
export interface ToolTraits {
  readonly annotations?: {
    readonly readOnlyHint?: boolean | undefined
    readonly destructiveHint?: boolean | undefined
    readonly openWorldHint?: boolean | undefined
  }
  /** The tool belongs to an MCP server (it has a namespace), whether or not it has annotations. */
  readonly mcp?: boolean
}

/** The shell tools of Pi. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"])

/** The tools that write one file, by the `path` of their input. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"])

/** The patch tool of the Codex provider. */
const PATCH_TOOL = "apply_patch"

/** The tools that reach the web, by name: `pi-web-kit`'s and Kimi's. */
const NETWORK_TOOLS = /^(web_[a-z_]+|moonshot_(search|fetch))$/

// ---------------------------------------------------------------------------------------------
// Shell commands
// ---------------------------------------------------------------------------------------------

/** The programs Codex treats as known safe: they read and print, and write nothing. */
const SAFE_PROGRAMS: ReadonlySet<string> = new Set([
  "cat",
  "cd",
  "cut",
  "echo",
  "expr",
  "false",
  "grep",
  "head",
  "id",
  "ls",
  "nl",
  "paste",
  "pwd",
  "rev",
  "seq",
  "stat",
  "tail",
  "tr",
  "true",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
])

const UNSAFE_FIND = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
])

const UNSAFE_RG = ["--pre", "--hook", "--search-zip", "-z"]

const SAFE_GIT = new Set([
  "status",
  "log",
  "diff",
  "show",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "blame",
  "describe",
  "shortlog",
  "cat-file",
  "grep",
])

const SAFE_GIT_BRANCH_FLAGS = new Set(["--list", "-l", "--show-current", "-a", "-r", "-v", "-vv"])

const UNSAFE_GIT = ["--output", "--ext-diff", "--textconv", "--exec", "-c", "--config-env"]

const startsWithAny = (word: string, prefixes: ReadonlyArray<string>): boolean =>
  prefixes.some((prefix) => word === prefix || word.startsWith(`${prefix}=`))

const safeGit = (args: ReadonlyArray<string>): boolean => {
  const sub = args[0]
  if (sub === undefined || sub.startsWith("-")) return false
  if (args.some((word) => startsWithAny(word, UNSAFE_GIT))) return false
  if (sub === "branch") return args.slice(1).every((word) => SAFE_GIT_BRANCH_FLAGS.has(word))
  return SAFE_GIT.has(sub)
}

// `sed -n 12p file` and `sed -n 3,9p file`: print a range, with no script file and no `-i`.
const safeSed = (args: ReadonlyArray<string>): boolean =>
  args[0] === "-n" &&
  /^\d+(,\d+)?p$/.test(args[1] ?? "") &&
  args.slice(2).every((word) => !word.startsWith("-"))

const safeProgram = (words: ReadonlyArray<string>): boolean => {
  const [program, ...args] = words
  if (program === undefined) return false
  if (SAFE_PROGRAMS.has(program)) return true
  switch (program) {
    case "find":
      return args.every((word) => !UNSAFE_FIND.has(word))
    case "rg":
      return args.every((word) => !startsWithAny(word, UNSAFE_RG))
    case "git":
      return safeGit(args)
    case "sed":
      return safeSed(args)
    default:
      return false
  }
}

// Splits a command into the words of its simple commands, or `undefined` when it uses anything but
// plain words and the separators `;`, `&&`, `||`, `|` and newline: redirections, substitutions,
// variables, backslashes, comments, grouping and background jobs all send the command to review.
// Single quotes are literal; double quotes are allowed as long as they hold no `$`, backtick or
// backslash.
const splitCommand = (command: string): ReadonlyArray<ReadonlyArray<string>> | undefined => {
  const segments: Array<Array<string>> = []
  let words: Array<string> = []
  let word: string | undefined
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endSegment = () => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let index = 0; index < command.length; index++) {
    const char = command.charAt(index)
    if (char === "'" || char === '"') {
      const close = command.indexOf(char, index + 1)
      if (close === -1) return undefined
      const inner = command.slice(index + 1, close)
      if (char === '"' && /[$`\\]/.test(inner)) return undefined
      word = (word ?? "") + inner
      index = close
    } else if (/[\\$`<>()#!]/.test(char)) {
      return undefined
    } else if (char === "&") {
      if (command.charAt(index + 1) !== "&") return undefined
      endSegment()
      index++
    } else if (char === "|") {
      endSegment()
      if (command.charAt(index + 1) === "|") index++
    } else if (char === ";" || char === "\n") {
      endSegment()
    } else if (/\s/.test(char)) {
      endWord()
    } else {
      word = (word ?? "") + char
    }
  }
  endSegment()
  return segments.length === 0 ? undefined : segments
}

/**
 * Whether a shell command is in the read-only safe set, which runs without review: one or more
 * simple commands joined by `;`, `&&`, `||` or a pipe, each a program Codex knows to be safe (see
 * `is_known_safe_command`: `cat`, `ls`, `grep`, `head` and the like, `find` without `-exec` or
 * `-delete`, `rg` without `--pre`, a read-only `git` subcommand, `sed -n Np`), with no redirection,
 * substitution, variable or other shell syntax that could do more than it says.
 */
export const isSafeCommand = (command: string): boolean => {
  const segments = splitCommand(command)
  return segments !== undefined && segments.every(safeProgram)
}

const NETWORK_COMMAND =
  /(^|[\s;&|])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|netcat|telnet|ftp|gh|aws|gcloud|az|kubectl)(\s|$)|\bgit\s+(clone|fetch|pull|push|ls-remote|remote\s+update)\b|\b(npm|pnpm|yarn|bun|pip3?|cargo|go|gem|brew|apt|apt-get|uv)\s+(install|add|i|ci|update|upgrade|publish|get|fetch)\b|\bdocker\s+(pull|push|login)\b|https?:\/\//

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** Whether a path, taken against the project root, is outside it (or cannot be told to be inside). */
export const isOutsideRoot = (path: string, root: string): boolean => {
  if (path.startsWith("~")) return true
  const away = relative(resolve(root), resolve(root, path))
  return away === ".." || away.startsWith(`..${sep}`) || isAbsolute(away)
}

const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+?)\s*$/gm

/** The paths a Codex patch names: the files it adds, updates, deletes and moves to. */
export const patchPaths = (patch: string): ReadonlyArray<string> =>
  Array.from(patch.matchAll(PATCH_PATH), (match) => match[1] ?? "")

const stringInput = (input: Readonly<Record<string, unknown>>, key: string) => {
  const value = input[key]
  return typeof value === "string" ? value : undefined
}

/** The path a file tool writes: its `path`, or the `file_path` some tools use. */
const writtenPath = (input: Readonly<Record<string, unknown>>): string | undefined =>
  stringInput(input, "path") ?? stringInput(input, "file_path")

const outsideRoot = (paths: ReadonlyArray<string>, root: string): string | undefined =>
  paths.find((path) => isOutsideRoot(path, root))

// ---------------------------------------------------------------------------------------------
// Tool annotations
// ---------------------------------------------------------------------------------------------

// Codex asks for approval of an MCP tool unless it says it is read-only; a tool that does not say
// it is not destructive, or not open-world, is taken as both (the MCP defaults).
const needsApproval = (traits: ToolTraits): string | undefined => {
  const hints = traits.annotations
  if (hints?.readOnlyHint === true) return undefined
  const destructive = hints?.destructiveHint ?? true
  const openWorld = hints?.openWorldHint ?? true
  if (destructive) return "its annotations say it may delete or overwrite data"
  if (openWorld) return "its annotations say it reaches an open world of external entities"
  return undefined
}

/**
 * Decides whether a tool call goes to review, and why. `undefined` runs the call. A shell command
 * outside the safe set, a write below no project folder, a network use and a tool whose annotations
 * need approval are reviewed; everything else runs, since nothing else would have stopped for
 * approval under Codex's sandbox. `traits` is what the tool registry knows of the tool.
 */
export const classify = (
  call: ToolCallInput,
  root: string,
  traits: ToolTraits = {},
): Trigger | undefined => {
  if (SHELL_TOOLS.has(call.toolName)) {
    const command = stringInput(call.input, "command")
    if (command === undefined)
      return { kind: "command", reason: "the shell command could not be read" }
    if (isSafeCommand(command)) return undefined
    return NETWORK_COMMAND.test(command)
      ? { kind: "network", reason: "the command may use the network" }
      : { kind: "command", reason: "the command is outside the read-only safe set" }
  }
  if (FILE_TOOLS.has(call.toolName)) {
    const path = writtenPath(call.input)
    if (path === undefined) return { kind: "write-outside-root", reason: "no path to write" }
    return isOutsideRoot(path, root)
      ? { kind: "write-outside-root", reason: `${path} is outside the project root` }
      : undefined
  }
  if (call.toolName === PATCH_TOOL) {
    const paths = patchPaths(stringInput(call.input, "input") ?? "")
    const outside = outsideRoot(paths, root)
    return outside === undefined
      ? undefined
      : { kind: "write-outside-root", reason: `${outside} is outside the project root` }
  }
  if (NETWORK_TOOLS.test(call.toolName))
    return { kind: "network", reason: `${call.toolName} reaches the network` }
  if (traits.annotations !== undefined || traits.mcp === true) {
    const why = needsApproval(traits)
    return why === undefined ? undefined : { kind: "tool-approval", reason: why }
  }
  return undefined
}

// ---------------------------------------------------------------------------------------------
// The action as the reviewer reads it
// ---------------------------------------------------------------------------------------------

// Every string of the input, cut to Codex's cap for one string of the action.
const truncated = (value: unknown): unknown => {
  if (typeof value === "string") return truncateText(value, MAX_ACTION_STRING_TOKENS)
  if (Array.isArray(value)) return value.map(truncated)
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, truncated(item)]))
  return value
}

/**
 * The action as the JSON the reviewer judges (Codex's `GuardianApprovalRequest` as JSON): the tool,
 * the working directory, why it was sent to review and its exact input, every string cut to Codex's
 * cap with a truncation marker. It is pretty-printed, and its text is also the identity of the
 * action for `/approve`.
 */
export const actionJson = (call: ToolCallInput, root: string, trigger: Trigger): string =>
  JSON.stringify(
    {
      tool: SHELL_TOOLS.has(call.toolName) ? "shell" : call.toolName,
      cwd: root,
      trigger: trigger.kind,
      trigger_reason: trigger.reason,
      input: truncated(call.input),
    },
    null,
    2,
  )
