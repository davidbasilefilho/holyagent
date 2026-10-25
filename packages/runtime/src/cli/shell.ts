/**
 * A git write the plugin steps in on: `commit`, which `holyagent vcs commit` replaces, `force-push`
 * (also a mirror, a deletion or a prune), which is denied, and `unclear`, a command or push
 * argument that cannot be read with certainty and could hide one. A plain push is not one of them.
 */
export type GitWrite = "commit" | "force-push" | "unclear"

/** How deep substitutions and `sh -c` scripts nest before the command is called unreadable. */
const MAX_NESTING = 64

interface Heredoc {
  readonly delimiter: string
  /** `<<-` ignores leading tabs of the delimiter line. */
  readonly strip: boolean
}

interface Scan {
  readonly text: string
  index: number
  readonly commands: Array<Array<string>>
  readonly heredocs: Array<Heredoc>
  /** How many arithmetic expansions `$((…))` the scan is inside; `<<` there shifts bits. */
  arithmetic: number
  /** How deep the substitutions open now. */
  nesting: number
  /** True once the text nested past {@link MAX_NESTING}; the rest of it was not read. */
  overflow: boolean
}

const SPACE = /[ \t\r]/
const STOPS = /[\s;&|()<>]/

/** Skips the bodies of the heredocs the line just ended opened. */
const skipHeredocs = (scan: Scan) => {
  for (const { delimiter, strip } of scan.heredocs.splice(0)) {
    while (scan.index < scan.text.length) {
      const end = scan.text.indexOf("\n", scan.index)
      const line = scan.text.slice(scan.index, end === -1 ? scan.text.length : end)
      scan.index = end === -1 ? scan.text.length : end + 1
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) break
    }
  }
}

/** Reads the delimiter after `<<`, quoted or not, and notes the heredoc. */
const readHeredoc = (scan: Scan) => {
  scan.index += 2
  const strip = scan.text[scan.index] === "-"
  if (strip) scan.index += 1
  while (SPACE.test(scan.text[scan.index] ?? "")) scan.index += 1
  let delimiter = ""
  while (scan.index < scan.text.length) {
    const char = scan.text[scan.index] ?? ""
    if (char === "'" || char === '"') {
      const end = scan.text.indexOf(char, scan.index + 1)
      const stop = end === -1 ? scan.text.length : end
      delimiter += scan.text.slice(scan.index + 1, stop)
      scan.index = stop + 1
    } else if (char === "\\") {
      // `<<\EOF` and `<<E\OF` name the delimiter EOF: the backslash only quotes.
      delimiter += scan.text[scan.index + 1] ?? ""
      scan.index += 2
    } else if (STOPS.test(char)) break
    else {
      delimiter += char
      scan.index += 1
    }
  }
  scan.heredocs.push({ delimiter, strip })
}

/** Reads a double-quoted string after its opening quote; substitutions inside run as commands. */
const scanDouble = (scan: Scan): string => {
  let value = ""
  while (scan.index < scan.text.length) {
    const char = scan.text[scan.index] ?? ""
    const next = scan.text[scan.index + 1] ?? ""
    scan.index += 1
    if (char === '"') break
    if (char === "\\") {
      value += '$`"\\'.includes(next) ? next : `\\${next}`
      scan.index += 1
    } else if (char === "$" && next === "(") {
      scan.index += 1
      scanSubstitution(scan)
      value += "$()"
    } else if (char === "`") {
      scanCode(scan, "`")
      value += "$()"
    } else value += char
  }
  return value
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

/**
 * Decodes the escape that starts at `at` (a backslash) in an ANSI-C string: the simple ones, `\x`
 * and octal bytes and `\u`/`\U` code points. One it cannot decode stands as `$`, which no command
 * word the plugin recognizes contains.
 */
const decodeEscape = (
  text: string,
  at: number,
): { readonly value: string; readonly next: number } => {
  const kind = text[at + 1] ?? ""
  const simple = SIMPLE_ESCAPES[kind]
  if (simple !== undefined) return { value: simple, next: at + 2 }
  const digits = (pattern: RegExp, max: number, from: number) => {
    let end = from
    while (end < text.length && end - from < max && pattern.test(text[end] ?? "")) end += 1
    return text.slice(from, end)
  }
  const code = (hex: string, base: number, next: number) => {
    const point = Number.parseInt(hex, base)
    return hex === "" || point > 0x10ffff
      ? { value: "$", next }
      : { value: String.fromCodePoint(point), next }
  }
  if (kind === "x") {
    const hex = digits(/[0-9a-fA-F]/, 2, at + 2)
    return code(hex, 16, at + 2 + hex.length)
  }
  if (kind === "u" || kind === "U") {
    const hex = digits(/[0-9a-fA-F]/, kind === "u" ? 4 : 8, at + 2)
    return code(hex, 16, at + 2 + hex.length)
  }
  if (/[0-7]/.test(kind)) {
    const octal = digits(/[0-7]/, 3, at + 1)
    return code(octal, 8, at + 1 + octal.length)
  }
  return { value: "$", next: at + 2 }
}

/** Reads an ANSI-C string (`$'…'`) after its opening quote, decoding its escapes. */
const scanAnsiC = (scan: Scan): string => {
  let value = ""
  while (scan.index < scan.text.length) {
    const char = scan.text[scan.index] ?? ""
    if (char === "'") {
      scan.index += 1
      break
    }
    if (char === "\\") {
      const decoded = decodeEscape(scan.text, scan.index)
      value += decoded.value
      scan.index = decoded.next
    } else {
      value += char
      scan.index += 1
    }
  }
  return value
}

/** Reads the substitution after `$(`: the arithmetic `$((…))` reads `<<` as a shift. */
const scanSubstitution = (scan: Scan) => {
  const arithmetic = scan.text[scan.index] === "("
  if (arithmetic) scan.arithmetic += 1
  scanCode(scan, ")")
  if (arithmetic) scan.arithmetic -= 1
}

/**
 * Reads commands until the closer of a substitution, or to the end of the text, adding each simple
 * command to the scan. A word is the text between separators with quotes removed; anything a
 * substitution computes stands as `$()`, since it cannot be known without running it.
 */
const scanCode = (scan: Scan, closer?: ")" | "`") => {
  if (scan.nesting >= MAX_NESTING) {
    scan.overflow = true
    scan.index = scan.text.length
    return
  }
  scan.nesting += 1
  let words: Array<string> = []
  let word: string | undefined
  let depth = 0
  // The word after a redirection operator is its target, not part of the command.
  let target = false
  const endWord = () => {
    if (word !== undefined) {
      if (!target) words.push(word)
      target = false
    }
    word = undefined
  }
  const endCommand = () => {
    endWord()
    target = false
    if (words.length > 0) scan.commands.push(words)
    words = []
  }
  while (scan.index < scan.text.length) {
    const char = scan.text[scan.index] ?? ""
    const next = scan.text[scan.index + 1] ?? ""
    if (char === "(" && next === "(" && word === undefined && words.length === 0 && !target) {
      // `((…))` at the start of a command is arithmetic, not two subshells: skip it whole.
      let open = 0
      while (scan.index < scan.text.length) {
        const here = scan.text[scan.index] ?? ""
        scan.index += 1
        if (here === "(") open += 1
        if (here === ")" && (open -= 1) === 0) break
      }
      continue
    }
    if (char === closer && depth === 0) {
      scan.index += 1
      break
    }
    if (char === "\\") {
      scan.index += 2
      if (next !== "\n") word = (word ?? "") + next
    } else if (char === "'") {
      const end = scan.text.indexOf("'", scan.index + 1)
      const stop = end === -1 ? scan.text.length : end
      word = (word ?? "") + scan.text.slice(scan.index + 1, stop)
      scan.index = stop + 1
    } else if (char === "$" && next === "'") {
      scan.index += 2
      word = (word ?? "") + scanAnsiC(scan)
    } else if (char === '"') {
      scan.index += 1
      word = (word ?? "") + scanDouble(scan)
    } else if (char === "`" || (char === "$" && next === "(")) {
      scan.index += char === "`" ? 1 : 2
      if (char === "`") scanCode(scan, "`")
      else scanSubstitution(scan)
      word = (word ?? "") + "$()"
    } else if (char === "#" && word === undefined) {
      const end = scan.text.indexOf("\n", scan.index)
      scan.index = end === -1 ? scan.text.length : end
    } else if (scan.text.startsWith("<<<", scan.index)) {
      // A here-string is a redirection whose target is the next word, not a heredoc.
      endWord()
      target = true
      scan.index += 3
    } else if (char === "<" && next === "<" && scan.arithmetic === 0) {
      endWord()
      readHeredoc(scan)
    } else if (char === "\n") {
      endCommand()
      scan.index += 1
      skipHeredocs(scan)
    } else if (
      char === "&" &&
      (next === ">" || scan.text[scan.index - 1] === ">" || scan.text[scan.index - 1] === "<")
    ) {
      // `2>&1`, `>&2` and `&>` redirect; they do not end the command.
      scan.index += 1
    } else if (";&|()".includes(char)) {
      endCommand()
      if (char === "(") depth += 1
      if (char === ")") depth -= 1
      scan.index += 1
    } else if (SPACE.test(char) || char === "<" || char === ">") {
      // A number right before a redirection is its file descriptor, not a word.
      if ((char === "<" || char === ">") && /^\d+$/.test(word ?? "")) word = undefined
      endWord()
      if (char === "<" || char === ">") target = true
      scan.index += 1
    } else {
      word = (word ?? "") + char
      scan.index += 1
    }
  }
  endCommand()
  scan.nesting -= 1
}

/**
 * The simple commands of a shell command line, each as its words with quotes removed, in order of
 * appearance. Separators, subshells, command substitutions, comments and heredoc bodies are
 * understood, so text that only mentions a command is not a command.
 */
export const simpleCommands = (line: string): ReadonlyArray<ReadonlyArray<string>> =>
  scanLine(line).commands

const scanLine = (line: string): Scan => {
  const scan: Scan = {
    text: line,
    index: 0,
    commands: [],
    heredocs: [],
    arithmetic: 0,
    nesting: 0,
    overflow: false,
  }
  scanCode(scan)
  return scan
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const KEYWORDS = new Set(["!", "{", "if", "then", "else", "elif", "do", "while", "until", "time"])
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])
/**
 * Commands that run the command that follows them, with the options of their own that take the next
 * word as a value. Any other option starting with a dash counts as a flag without a value.
 */
const WRAPPERS: Readonly<Record<string, ReadonlySet<string>>> = {
  sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "--user", "--group"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir"]),
  nice: new Set(["-n", "--adjustment"]),
  timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
  xargs: new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-E", "-a", "--max-args", "--max-procs"]),
  command: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  builtin: new Set(),
}
/** Global git options that take their value as the next word. */
const VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
])

const programName = (word: string | undefined): string => word?.split("/").at(-1) ?? ""

/** The index of the first word after a wrapper's own options (and the duration `timeout` takes). */
const afterWrapper = (words: ReadonlyArray<string>, at: number, program: string): number => {
  const valued = WRAPPERS[program] ?? new Set<string>()
  let index = at + 1
  while (words[index]?.startsWith("-")) index += valued.has(words[index] ?? "") ? 2 : 1
  return program === "timeout" && /^\d/.test(words[index] ?? "") ? index + 1 : index
}

/** The long push options that overwrite or delete remote refs; git accepts any unambiguous prefix. */
const DANGEROUS_OPTIONS = [
  "--force",
  "--force-with-lease",
  "--force-if-includes",
  "--mirror",
  "--delete",
  "--prune",
]

/** Characters that make a word depend on something the shell computes or expands. */
const UNREADABLE = /[$`{}*?[\]\\]/

/**
 * What the words after `git push` do to remote history. `force-push` when they ask to overwrite or
 * delete it: `--force`, `--force-with-lease` (with or without a value), `--force-if-includes`,
 * `--mirror`, `--delete`, `--prune`, any prefix of those long options that git would accept, a
 * short option cluster with `f` or `d`, a refspec that starts with `+`, or one that starts with `:`
 * (a deletion). `unclear` when a word holds a variable, a substitution, a brace, a glob or an
 * escape that was not decoded, since it could be any of those. Nothing for a plain push.
 */
const pushVerdict = (args: ReadonlyArray<string>): ReadonlyArray<GitWrite> => {
  const dangerous = (arg: string, options: boolean) => {
    if (options && arg.startsWith("--")) {
      const name = arg.split("=")[0] ?? arg
      return name.length > 2 && DANGEROUS_OPTIONS.some((option) => option.startsWith(name))
    }
    if (options && /^-[A-Za-z]+$/.test(arg)) return /[fd]/.test(arg)
    return (arg.startsWith("+") || arg.startsWith(":")) && arg.length > 1
  }
  const dashes = args.indexOf("--")
  const words = dashes === -1 ? args : args.slice(0, dashes)
  const refspecs = dashes === -1 ? [] : args.slice(dashes + 1)
  if (words.some((arg) => dangerous(arg, true)) || refspecs.some((arg) => dangerous(arg, false)))
    return ["force-push"]
  return args.some((arg) => UNREADABLE.test(arg)) ? ["unclear"] : []
}

const writesOf = (words: ReadonlyArray<string>, nesting: number): ReadonlyArray<GitWrite> => {
  let start = 0
  while (start < words.length) {
    const word = words[start] ?? ""
    const program = programName(word)
    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) start += 1
    else if (Object.hasOwn(WRAPPERS, program)) start = afterWrapper(words, start, program)
    else break
  }
  const program = programName(words[start])
  if (SHELLS.has(program)) {
    const flag = words.findIndex((word, index) => index > start && /^-[a-z]*c[a-z]*$/.test(word))
    const script = flag === -1 ? undefined : words[flag + 1]
    return script === undefined ? [] : writesIn(script, nesting + 1)
  }
  if (program !== "git") return []
  let at = start + 1
  while (words[at]?.startsWith("-")) at += VALUE_OPTIONS.has(words[at] ?? "") ? 2 : 1
  const subcommand = words[at]
  if (subcommand === "commit") return ["commit"]
  return subcommand === "push" ? pushVerdict(words.slice(at + 1)) : []
}

const writesIn = (line: string, nesting: number): ReadonlyArray<GitWrite> => {
  if (nesting > MAX_NESTING) return ["unclear"]
  const scan = scanLine(line)
  return [
    ...scan.commands.flatMap((words) => writesOf(words, nesting)),
    ...(scan.overflow ? (["unclear"] as const) : []),
  ]
}

/**
 * The git writes a command line runs: `git commit`, a `git push` that force-updates or deletes
 * remote refs, and a push or a command nested too deep to read with certainty, found as commands of
 * their own (also behind `cd a &&`, a pipe, a subshell, an env prefix, global git options or `sh
 * -c`), so `git commitizen`, a plain `git push` and `echo "git commit"` are not among them. In
 * order of appearance, each once.
 */
export const gitWrites = (line: string): ReadonlyArray<GitWrite> => [...new Set(writesIn(line, 0))]
