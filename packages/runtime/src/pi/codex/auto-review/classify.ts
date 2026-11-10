import { lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"

import { READ_TOOLS } from "../../tools.ts"
import { MAX_ACTION_STRING_TOKENS, truncateText } from "./transcript.ts"

/**
 * Why a tool call goes to review. Codex reviews what its sandbox would otherwise stop and ask a
 * human about; Pi has no sandbox, so the classifier stands in for that signal.
 *
 * - `command`: a shell command outside the read-only safe set (Codex's escalation request).
 * - `write-outside-root`: a file write below no folder of the project (Codex's edit outside the
 *   writable roots).
 * - `protected-path`: a file write into `.git`, `.holyagent` or an agent configuration folder of the
 *   project, which Codex's sandbox keeps read-only even inside the writable roots.
 * - `network`: a command or tool that reaches the network (Codex's network approval).
 * - `tool-approval`: a tool that is not known to be read-only (Codex's MCP tool approval, which also
 *   asks for a tool that does not say it is read-only).
 */
export type TriggerKind =
  "command" | "write-outside-root" | "protected-path" | "network" | "tool-approval"

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
  /**
   * The tool belongs to an MCP server (it has a namespace): its name is its server's to choose, so
   * a name shared with a built-in tool earns it nothing.
   */
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

/**
 * The programs that read and print and write nothing, whatever their operands. `uniq` is not among
 * them, though Codex lists it: its second operand is a file it writes, and Pi has no sandbox to
 * stop that.
 */
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

// Flags that make ripgrep start another program: a preprocessor, a decompressor, a hostname command.
const UNSAFE_RG = ["--pre", "--hook", "--hostname-bin", "--search-zip"]

// A cluster of short flags, `-iz`: one word that holds several.
const isShortCluster = (word: string): boolean => /^-[^-]/.test(word)

// `-z` (`--search-zip`) runs a decompressor; it can sit inside a cluster, as in `-iz`.
const unsafeRg = (word: string): boolean =>
  startsWithAny(word, UNSAFE_RG) || (isShortCluster(word) && word.includes("z"))

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

// Long flags that write a file or start a program: `--output` writes, `--ext-diff`, `--textconv` and
// `--filters` run configured drivers, `--exec` and `--open-files-in-pager` (`git grep -O`) run a
// command.
const UNSAFE_GIT_LONG = [
  "--output",
  "--ext-diff",
  "--textconv",
  "--filters",
  "--exec",
  "--open-files-in-pager",
  "--config-env",
]

const startsWithAny = (word: string, prefixes: ReadonlyArray<string>): boolean =>
  prefixes.some((prefix) => word === prefix || word.startsWith(`${prefix}=`))

// Git takes any unambiguous prefix of a long flag (`--out=file`), so a flag that is the start of an
// unsafe one is unsafe too.
const unsafeGitLong = (word: string): boolean => {
  if (!word.startsWith("--")) return false
  const name = word.split("=")[0] ?? word
  return name.length > 2 && UNSAFE_GIT_LONG.some((flag) => flag.startsWith(name))
}

const unsafeGit = (sub: string, word: string): boolean =>
  unsafeGitLong(word) ||
  word === "-c" ||
  word.startsWith("-c=") ||
  // `git grep -O` (open the matches in a pager) takes its program glued on, or sits in a cluster.
  (sub === "grep" && isShortCluster(word) && word.includes("O"))

const safeGit = (args: ReadonlyArray<string>): boolean => {
  const sub = args[0]
  if (sub === undefined || sub.startsWith("-")) return false
  if (args.some((word) => unsafeGit(sub, word))) return false
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
      return args.every((word) => !unsafeRg(word))
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
// variables, backslashes, comments, grouping and background jobs all send the command to review, as
// do an unquoted brace or glob: the shell would expand it into words (`--p{re,re}=x` is `--pre=x`,
// and a file named `--pre=x` joins `*`) that the flag checks never saw. Single quotes are literal;
// double quotes are allowed as long as they hold no `$`, backtick or backslash.
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
    } else if (/[\\$`<>()#!{}*?[]/.test(char)) {
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

/**
 * The folders of a project that Codex's sandbox keeps read-only even inside the writable roots, and
 * that decide what runs later: git hooks and config, the HolyAgent state and config, and the
 * configuration of the agents (Pi, Codex, Claude). Compared in lower case, since a case-folding
 * file system opens `.GIT` as `.git`.
 */
export const PROTECTED_FOLDERS: ReadonlyArray<string> = [
  ".git",
  ".holyagent",
  ".pi",
  ".codex",
  ".claude",
]

const UNICODE_SPACES = /[  -   　]/g

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined

type Probe<A> =
  | { readonly found: true; readonly value: A }
  | { readonly found: false; readonly code: string | undefined }

// Runs a file system call that may throw, and says what it found or the error code it met.
const probe = <A>(run: () => A): Probe<A> =>
  Effect.runSync(
    Effect.try({ try: run, catch: errorCode }).pipe(
      Effect.map((value): Probe<A> => ({ found: true, value })),
      Effect.catch((code) => Effect.succeed<Probe<A>>({ found: false, code })),
    ),
  )

// The path as Pi's write and edit tools read it (`resolveToCwd`): Unicode spaces become spaces, a
// leading `@` goes, `~` and `~/` are the home folder, a `file://` URL is its path, and a relative
// path is taken against the project root. `undefined` for a URL that is not a path.
const piPath = (input: string, root: string): string | undefined => {
  let text = input.replace(UNICODE_SPACES, " ")
  if (text.startsWith("@")) text = text.slice(1)
  if (text === "~") text = homedir()
  else if (text.startsWith("~/")) text = join(homedir(), text.slice(2))
  if (text.startsWith("file://")) {
    const url = probe(() => fileURLToPath(text))
    if (!url.found) return undefined
    text = url.value
  }
  return resolve(root, text)
}

// The path with every link that exists resolved: the deepest ancestor that exists is resolved by
// the file system, and the part below it, which does not exist yet, follows as written. A link that
// leads nowhere, or one the file system will not resolve, gives `undefined`: where a write through
// it would land is not known.
const throughLinks = (path: string): string | undefined => {
  const tail: Array<string> = []
  let current = path
  for (;;) {
    const real = probe(() => realpathSync(current))
    if (real.found) return join(real.value, ...tail)
    if (real.code !== "ENOENT") return undefined
    // The path itself exists but its target does not: a dangling link.
    if (probe(() => lstatSync(current)).found) return undefined
    const parent = dirname(current)
    if (parent === current) return path
    tail.unshift(basename(current))
    current = parent
  }
}

/**
 * Whether a write to `path` goes to review, and why: the path is read as Pi's tools read it (a
 * leading `@`, `~`, a `file://` URL), resolved through the links that exist, and compared with the
 * project root (itself resolved). A target outside the root, or one that cannot be resolved, is
 * `write-outside-root`; one inside it that has a protected folder (see {@link PROTECTED_FOLDERS})
 * among its parts is `protected-path`.
 */
export const writeTrigger = (path: string, root: string): Trigger | undefined => {
  const target = piPath(path, root)
  const real = target === undefined ? undefined : throughLinks(target)
  const base = resolve(root)
  const away = real === undefined ? undefined : relative(throughLinks(base) ?? base, real)
  if (away === undefined || away === ".." || away.startsWith(`..${sep}`) || isAbsolute(away))
    return { kind: "write-outside-root", reason: `${path} is outside the project root` }
  return away.split(sep).some((part) => PROTECTED_FOLDERS.includes(part.toLowerCase()))
    ? {
        kind: "protected-path",
        reason: `${path} is in a folder that holds git or agent configuration, which Codex's sandbox keeps read-only`,
      }
    : undefined
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

// The first trigger among the paths of a write, an outside path ahead of a protected one.
const firstTrigger = (paths: ReadonlyArray<string>, root: string): Trigger | undefined => {
  const triggers = paths.flatMap((path) => writeTrigger(path, root) ?? [])
  return triggers.find((trigger) => trigger.kind === "write-outside-root") ?? triggers[0]
}

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

/** The tools known to read and change nothing: Pi's own `read`, `grep`, `find` and `ls`. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(READ_TOOLS)

/**
 * Decides whether a tool call goes to review, and why. `undefined` runs the call. Review is the
 * default: a call runs only when it is a shell command in the safe set, a write inside the project
 * that touches no protected folder, a read tool of Pi, or a tool annotated read-only. A tool that
 * is neither known to be read-only nor says so (a process runner, a tool with no annotations, one
 * that says it is destructive or open-world) is reviewed, since Pi has no sandbox to stop what it
 * does. `traits` is what the tool registry knows of the tool.
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
    return writeTrigger(path, root)
  }
  if (call.toolName === PATCH_TOOL)
    return firstTrigger(patchPaths(stringInput(call.input, "input") ?? ""), root)
  if (NETWORK_TOOLS.test(call.toolName))
    return { kind: "network", reason: `${call.toolName} reaches the network` }
  if (traits.annotations?.readOnlyHint === true) return undefined
  if (traits.mcp !== true && READ_ONLY_TOOLS.has(call.toolName)) return undefined
  return { kind: "tool-approval", reason: `${call.toolName} is not known to be read-only` }
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
