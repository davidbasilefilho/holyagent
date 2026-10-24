/** A git subcommand the plugin redirects to `holyagent vcs`. */
export type GitWrite = "commit" | "push"

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
      scanCode(scan, ")")
      value += "$()"
    } else if (char === "`") {
      scanCode(scan, "`")
      value += "$()"
    } else value += char
  }
  return value
}

/**
 * Reads commands until the closer of a substitution, or to the end of the text, adding each simple
 * command to the scan. A word is the text between separators with quotes removed; anything a
 * substitution computes stands as `$()`, since it cannot be known without running it.
 */
const scanCode = (scan: Scan, closer?: ")" | "`") => {
  let words: Array<string> = []
  let word: string | undefined
  let depth = 0
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) scan.commands.push(words)
    words = []
  }
  while (scan.index < scan.text.length) {
    const char = scan.text[scan.index] ?? ""
    const next = scan.text[scan.index + 1] ?? ""
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
    } else if (char === '"') {
      scan.index += 1
      word = (word ?? "") + scanDouble(scan)
    } else if (char === "`" || (char === "$" && next === "(")) {
      scan.index += char === "`" ? 1 : 2
      scanCode(scan, char === "`" ? "`" : ")")
      word = (word ?? "") + "$()"
    } else if (char === "#" && word === undefined) {
      const end = scan.text.indexOf("\n", scan.index)
      scan.index = end === -1 ? scan.text.length : end
    } else if (char === "<" && next === "<" && scan.text[scan.index + 2] !== "<") {
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
      scan.index += 1
    } else {
      word = (word ?? "") + char
      scan.index += 1
    }
  }
  endCommand()
}

/**
 * The simple commands of a shell command line, each as its words with quotes removed, in order of
 * appearance. Separators, subshells, command substitutions, comments and heredoc bodies are
 * understood, so text that only mentions a command is not a command.
 */
export const simpleCommands = (line: string): ReadonlyArray<ReadonlyArray<string>> => {
  const scan: Scan = { text: line, index: 0, commands: [], heredocs: [] }
  scanCode(scan)
  return scan.commands
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

const writesOf = (words: ReadonlyArray<string>): ReadonlyArray<GitWrite> => {
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
    return script === undefined ? [] : gitWrites(script)
  }
  if (program !== "git") return []
  let at = start + 1
  while (words[at]?.startsWith("-")) at += VALUE_OPTIONS.has(words[at] ?? "") ? 2 : 1
  const subcommand = words[at]
  return subcommand === "commit" || subcommand === "push" ? [subcommand] : []
}

/**
 * The git writes a command line runs: `git commit` and `git push`, found as commands of their own
 * (also behind `cd a &&`, a pipe, a subshell, an env prefix, global git options or `sh -c`), so
 * `git commitizen` and `echo "git commit"` are not among them. In order of appearance, each once.
 */
export const gitWrites = (line: string): ReadonlyArray<GitWrite> => [
  ...new Set(simpleCommands(line).flatMap(writesOf)),
]
