/**
 * What the plugin steps in on: `commit`, which `holyagent vcs commit` replaces, `force-push` (also
 * a mirror, a deletion or a prune), which is denied, and `unclear`, a command that cannot be read
 * with certainty (an unknown program, a word the shell computes, a construct the scan does not
 * follow) and could hide one of the two. A plain push is not one of them.
 */
export type GitWrite = "commit" | "force-push" | "unclear"

/** How deep substitutions nest before the command is called unreadable. */
const MAX_NESTING = 64

interface Heredoc {
  readonly delimiter: string
  /** `<<-` ignores leading tabs of the delimiter line. */
  readonly strip: boolean
  /** True when the delimiter was quoted: the body is then plain text, else it expands. */
  readonly quoted: boolean
}

interface Scan {
  readonly text: string
  index: number
  readonly commands: Array<Array<string>>
  readonly heredocs: Array<Heredoc>
  /** How deep the substitutions open now. */
  nesting: number
  /** True once the text nested past {@link MAX_NESTING}; the rest of it was not read. */
  overflow: boolean
  /** True once the scan met a construct it does not read with certainty (see {@link scanLine}). */
  unclear: boolean
}

/**
 * Marks, in a word, an expansion the shell computes before the command runs (`$name`, `${name}`, a
 * substitution, an arithmetic result): the scan cannot know the text it stands for. A private-use
 * character, so no real word holds it.
 */
const EXPANDED = "\uE000"

/** True when part of the word is computed by the shell, so its text is not known. */
const isDynamic = (word: string): boolean => word.includes(EXPANDED)

/**
 * Stands in a word for the plugin folder, `$CLAUDE_PLUGIN_ROOT` or `${CLAUDE_PLUGIN_ROOT}`: the
 * host sets it, the root writes `"${CLAUDE_PLUGIN_ROOT}/scripts/holyagent"` for every `holyagent`
 * command, and a command line cannot change it without an assignment, which {@link RISKY_VARIABLE}
 * refuses.
 */
const PLUGIN_ROOT = "\uE001"

/** The text a `$name` or `${name}` leaves in a word. */
const expansionOf = (name: string): string =>
  name === "CLAUDE_PLUGIN_ROOT" ? PLUGIN_ROOT : "$" + EXPANDED

/**
 * What a `${…}` may hold: a name, the length of one (`#name`) or a special parameter. Nothing
 * computes.
 */
const SIMPLE_EXPANSION = /^(?:#?[A-Za-z_]\w*|\d+|[@*#?$!-])$/

/**
 * What `((…))` and `$((…))` may hold for the scan to skip them: numbers and operators. The shell
 * evaluates a name in an expression too, so `x='a[$(cmd)]'` followed by `$((x))` would run `cmd`;
 * letters, quotes, substitutions and `;` are therefore not skipped. It also keeps the text from
 * being two subshells (`((cmd) && (cmd))`), which bash reads when `))` does not close an arithmetic
 * command.
 */
const ARITHMETIC = /^[ \t\d()+\-*/%<>=!&|^?:,]*$/

/** The length of `$CLAUDE_PLUGIN_ROOT` when it starts at `at` (the `$`, a whole name), else 0. */
const pluginRootAt = (text: string, at: number): number =>
  /^\$CLAUDE_PLUGIN_ROOT(?!\w)/.test(text.slice(at, at + 20)) ? 19 : 0

/** True when a `$` at `at` starts a parameter expansion (`$name`, `${`, `$1`, `$@`, `$$`, …). */
const expands = (text: string, at: number): boolean => /[\w{@*#?!$-]/.test(text[at + 1] ?? "")

const SPACE = /[ \t\r]/
const STOPS = /[\s;&|()<>]/

/**
 * Skips the bodies of the heredocs the line just ended opened. The body of an unquoted heredoc
 * expands like a double-quoted string, so one that holds a substitution runs commands the scan does
 * not read; a body whose terminator never comes is unreadable too.
 */
const skipHeredocs = (scan: Scan) => {
  for (const { delimiter, strip, quoted } of scan.heredocs.splice(0)) {
    const body: Array<string> = []
    let closed = false
    while (scan.index < scan.text.length) {
      const end = scan.text.indexOf("\n", scan.index)
      const line = scan.text.slice(scan.index, end === -1 ? scan.text.length : end)
      scan.index = end === -1 ? scan.text.length : end + 1
      if ((strip ? line.replace(/^\t+/, "") : line) === delimiter) {
        closed = true
        break
      }
      body.push(line)
    }
    if (!closed || (!quoted && /\$\(|`/.test(body.join("\n")))) scan.unclear = true
  }
}

/** Reads the delimiter after `<<`, quoted or not, and notes the heredoc. */
const readHeredoc = (scan: Scan) => {
  scan.index += 2
  const strip = scan.text[scan.index] === "-"
  if (strip) scan.index += 1
  while (SPACE.test(scan.text[scan.index] ?? "")) scan.index += 1
  let delimiter = ""
  let quoted = false
  while (scan.index < scan.text.length) {
    const char = scan.text[scan.index] ?? ""
    if (char === "'" || char === '"') {
      quoted = true
      const end = scan.text.indexOf(char, scan.index + 1)
      const stop = end === -1 ? scan.text.length : end
      delimiter += scan.text.slice(scan.index + 1, stop)
      scan.index = stop + 1
    } else if (char === "\\") {
      // `<<\EOF` and `<<E\OF` name the delimiter EOF: the backslash only quotes.
      quoted = true
      delimiter += scan.text[scan.index + 1] ?? ""
      scan.index += 2
    } else if (STOPS.test(char)) break
    else {
      delimiter += char
      scan.index += 1
    }
  }
  // A `<<` with no delimiter-shaped word after it is a shift or something else, not a heredoc.
  if (!/^[\w.-]+$/.test(delimiter)) scan.unclear = true
  scan.heredocs.push({ delimiter, strip, quoted })
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
      // A backslash before a newline is a continuation: bash deletes both.
      if (next !== "\n") value += '$`"\\'.includes(next) ? next : `\\${next}`
      scan.index += 1
    } else if (char === "$" && next === "[") {
      scan.unclear = true
      value += char
    } else if (char === "$" && next === "{") {
      scan.index += 1
      value += scanBraced(scan)
    } else if (char === "$" && next !== "(" && expands(scan.text, scan.index - 1)) {
      const plugin = pluginRootAt(scan.text, scan.index - 1)
      scan.index += Math.max(plugin - 1, 0)
      value += plugin > 0 ? PLUGIN_ROOT : char + EXPANDED
    } else if (char === "$" && next === "(") {
      scan.index += 1
      scanSubstitution(scan)
      value += EXPANDED
    } else if (char === "`") {
      scanCode(scan, "`")
      value += EXPANDED
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
      // Bash cuts an ANSI-C string at a NUL; the scan would keep the rest, so it gives up instead.
      if (decoded.value.includes("\0")) scan.unclear = true
      value += decoded.value
      scan.index = decoded.next
    } else {
      value += char
      scan.index += 1
    }
  }
  return value
}

/**
 * Skips an arithmetic command or expansion, from its `((` to the `)` that balances it. Its text is
 * not read as commands, so it must be plain arithmetic ({@link ARITHMETIC}) and close with `))`;
 * any other text is not read with certainty.
 */
const skipArithmetic = (scan: Scan) => {
  const from = scan.index
  let open = 0
  let closed = false
  while (scan.index < scan.text.length && !closed) {
    const here = scan.text[scan.index] ?? ""
    scan.index += 1
    if (here === "(") open += 1
    if (here === ")") closed = (open -= 1) === 0
  }
  const skipped = scan.text.slice(from, scan.index)
  if (!closed || !skipped.endsWith("))") || !ARITHMETIC.test(skipped)) scan.unclear = true
}

/** Reads the substitution after `$(`; `$((` is arithmetic, which is skipped. */
const scanSubstitution = (scan: Scan) => {
  if (scan.text[scan.index] === "(") {
    scan.index -= 1
    skipArithmetic(scan)
  } else scanCode(scan, ")")
}

/**
 * Skips a `${…}` after its `{`, giving the text it leaves in the word. Only a name, its length or a
 * special parameter is read: anything else (a default, an offset, a substring) computes, and an
 * offset is arithmetic where `<<` shifts bits, so it is not read with certainty.
 */
const scanBraced = (scan: Scan): string => {
  const from = scan.index
  let open = 1
  while (scan.index < scan.text.length) {
    const char = scan.text[scan.index] ?? ""
    scan.index += 1
    if (char === "{") open += 1
    if (char === "}" && (open -= 1) === 0) {
      const name = scan.text.slice(from, scan.index - 1)
      if (!SIMPLE_EXPANSION.test(name)) scan.unclear = true
      return expansionOf(name)
    }
  }
  scan.unclear = true
  return expansionOf("")
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
    if (char === "(" && next === "(") {
      // `((…))` is arithmetic wherever it stands (a command, after `if`, in `for ((…))`), not two
      // subshells; see skipArithmetic for what is read.
      skipArithmetic(scan)
      continue
    }
    if (char === closer && depth === 0) {
      scan.index += 1
      break
    }
    if (char === "\\") {
      // Inside backticks, `\`` is a nested substitution the scan does not follow.
      if (closer === "`" && next === "`") scan.unclear = true
      scan.index += 2
      if (next !== "\n") word = (word ?? "") + next
    } else if (char === "$" && next === "[") {
      // The obsolete arithmetic `$[…]`, where `<<` shifts bits.
      scan.unclear = true
      word = (word ?? "") + char
      scan.index += 1
    } else if (char === "$" && next === "{") {
      scan.index += 2
      word = (word ?? "") + scanBraced(scan)
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
      word = (word ?? "") + EXPANDED
    } else if (char === "#" && word === undefined) {
      const end = scan.text.indexOf("\n", scan.index)
      scan.index = end === -1 ? scan.text.length : end
    } else if (scan.text.startsWith("<<<", scan.index)) {
      // A here-string is a redirection whose target is the next word, not a heredoc.
      endWord()
      target = true
      scan.index += 3
    } else if (char === "<" && next === "<") {
      // In `a[1<<2 ]=1` the `<<` shifts bits inside an array subscript, not a heredoc.
      if (word?.includes("[") && !word.includes("]")) scan.unclear = true
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
    } else if (char === "$" && pluginRootAt(scan.text, scan.index) > 0) {
      scan.index += pluginRootAt(scan.text, scan.index)
      word = (word ?? "") + PLUGIN_ROOT
    } else {
      word = (word ?? "") + char + (char === "$" && expands(scan.text, scan.index) ? EXPANDED : "")
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
    nesting: 0,
    overflow: false,
    unclear: false,
  }
  scanCode(scan)
  return scan
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Variables that change how a program is found, configured or run: git settings (`GIT_CONFIG*`,
 * `GIT_SSH_COMMAND`, `GIT_EDITOR`, …), the search path, the home folder that holds the user's git
 * configuration, preloads, the shell startup file and the pager or editor git starts.
 */
const RISKY_VARIABLE =
  /^(?:GIT_|CLAUDE_|PATH=|HOME=|XDG_|LD_|DYLD_|BASH_|ENV=|IFS=|SHELL=|PAGER=|EDITOR=|VISUAL=|CDPATH=|TMPDIR=)/

/** Words that only shape a command (a keyword before the command it governs); nothing runs for them. */
const GRAMMAR = new Set(["!", "{", "if", "then", "else", "elif", "do", "while", "until", "time"])

/** Words that close a construct and stand alone as a command of the scan. */
const CLOSERS = new Set(["}", "fi", "done"])

/**
 * The programs a command may run: the everyday ones of the root. Any other is not read with
 * certainty.
 */
const PROGRAMS = new Set([
  "git",
  "gh",
  "holyagent",
  "echo",
  "printf",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "ls",
  "cd",
  "pwd",
  "mise",
  "bun",
  "bunx",
  "jq",
  "sort",
  "uniq",
  "cut",
  "tr",
  "test",
  "[",
  "true",
  "false",
  "sleep",
  "mkdir",
  "cp",
  "mv",
  "rm",
  "touch",
  "diff",
  "sed",
  "awk",
  "find",
])

/** Programs that only print or search text: a `git` word in their arguments is data. */
const READERS = new Set(["echo", "printf", "grep", "rg"])

/** A program word the scan knows exactly: letters, digits and the characters of a path, or `[`. */
const PLAIN_PROGRAM = /^(?:[\w./+\uE001-]+|\[)$/

const isGit = (word: string): boolean => /(?:^|\/)git$/i.test(word)
/**
 * Tells whether a literal absolute path is the wrapper the hook itself runs from. The scan reads
 * text only, so the caller supplies the file system check.
 */
export type OwnWrapper = (path: string) => boolean

/**
 * The `holyagent` wrapper: by name, as the root writes it from the plugin folder, or by the
 * absolute path of the hook's own wrapper. Any other path is a program the scan does not know.
 */
const isHolyagent = (word: string, ownWrapper: OwnWrapper): boolean =>
  word === "holyagent" ||
  word === `${PLUGIN_ROOT}/scripts/holyagent` ||
  (word.startsWith("/") && ownWrapper(word))

/** `gh` commands that run shell text or other programs: aliases (`!cmd`), extensions, codespaces. */
const GH_RUNNERS: ReadonlySet<string> = new Set(["alias", "extension", "ext", "codespace", "cs"])

/**
 * What makes an allowed program run a command it was not named for, as a check on its arguments
 * (`true` when it could). A dynamic argument counts for programs where one option is enough to run
 * a command (`find -exec`, `sed s///e`, `awk system()`, `rg --pre`).
 */
const GUARDS: Readonly<Record<string, (args: ReadonlyArray<string>) => boolean>> = {
  find: (args) =>
    args.some((arg) => isDynamic(arg) || /^-(?:exec|execdir|ok|okdir|delete)$/.test(arg)),
  // sed runs the pattern space or a command with `e`: `sed e`, `1e cmd`, `s/x/y/e`.
  sed: (args) =>
    args.some(
      (arg) =>
        isDynamic(arg) ||
        /^-(?:[A-Za-z]*f|-file)/.test(arg) ||
        /(?:^|[;{}\s=])(?:\d+|\$)?e(?:\s|;|$|\})/.test(arg) ||
        /[^\w\s\\][a-z0-9]*e[a-z0-9]*(?=$|[;\s}])/i.test(arg),
    ),
  // awk runs a command with `system()`, a `|` pipe or `getline`, and reads programs from files.
  awk: (args) =>
    args.some(
      (arg) =>
        isDynamic(arg) || /system|getline|\||@|^(?:-f|-i|-l|--file|--include|--load)/.test(arg),
    ),
  sort: (args) =>
    args.some((arg) => {
      const name = arg.split("=")[0] ?? arg
      return isDynamic(arg) || (name.length >= 4 && "--compress-program".startsWith(name))
    }),
  rg: (args) => args.some((arg) => isDynamic(arg) || /^--(?:pre|hostname-bin)/.test(arg)),
  // `test -v 'a[$(cmd)]'` and `printf -v` evaluate an array subscript, which runs substitutions.
  test: (args) => args.some((arg) => isDynamic(arg) || /^-[vR]$/.test(arg)),
  "[": (args) => args.some((arg) => isDynamic(arg) || /^-[vR]$/.test(arg)),
  printf: (args) => args.includes("-v"),
  mise: (args) =>
    args.some((arg) => isDynamic(arg) || ["exec", "x", "shell", "watch", "w"].includes(arg)),
  bun: (args) =>
    args.some(
      (arg) =>
        isDynamic(arg) ||
        /^(?:-e|--eval|-p|--print|-|x|exec|repl|create|c)$/.test(arg) ||
        arg.startsWith("/dev/"),
    ),
  bunx: (args) => args.some(isDynamic),
  // `gh alias set x '!cmd'` and extensions run shell text.
  gh: (args) => args.slice(0, 2).some(isDynamic) || args.some((arg) => GH_RUNNERS.has(arg)),
}

/**
 * The git subcommands a command may run; an alias cannot hide one, since git ignores aliases of
 * these.
 */
const SUBCOMMANDS = new Set([
  "add",
  "am",
  "apply",
  "archive",
  "blame",
  "branch",
  "cat-file",
  "check-ignore",
  "checkout",
  "cherry",
  "cherry-pick",
  "clean",
  "config",
  "count-objects",
  "describe",
  "diff",
  "diff-tree",
  "fetch",
  "for-each-ref",
  "format-patch",
  "fsck",
  "gc",
  "grep",
  "init",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge",
  "merge-base",
  "mv",
  "name-rev",
  "notes",
  "pull",
  "push",
  "range-diff",
  "rebase",
  "reflog",
  "remote",
  "reset",
  "restore",
  "rev-list",
  "rev-parse",
  "revert",
  "rm",
  "shortlog",
  "show",
  "show-branch",
  "show-ref",
  "stash",
  "status",
  "switch",
  "symbolic-ref",
  "tag",
  "update-ref",
  "worktree",
])

/** Global git options that take no value. */
const GIT_FLAGS = new Set([
  "--no-pager",
  "-P",
  "--paginate",
  "-p",
  "--no-optional-locks",
  "--bare",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-replace-objects",
])

/** Global git options that take a value, as the next word or after `=`. */
const GIT_VALUED = new Set(["-C", "--git-dir", "--work-tree", "--namespace"])

/** The `-c` settings a command may pass: identity and display, which run and redirect nothing. */
const SAFE_SETTING =
  /^(?:user\.(?:name|email|signingkey)|color\.[\w.-]+|advice\.[\w.-]+|core\.(?:quotepath|abbrev|autocrlf|filemode|whitespace)|commit\.(?:gpgsign|verbose)|log\.[\w.-]+|status\.[\w.-]+|init\.defaultbranch|pull\.(?:rebase|ff)|merge\.(?:ff|conflictstyle))=/i

/** `git config` keys that define an alias, a push target or a program git starts. */
const RISKY_CONFIG =
  /^(?:alias\.|include|remote\..*\.(?:push|mirror|pushurl)|push\.|core\.(?:sshcommand|editor|hookspath|pager|fsmonitor)|credential|url\.)/i

/**
 * Long options that make git start a program: `--exec` (also push's), `--receive-pack`,
 * `--upload-pack`, `grep -O`.
 */
const PROGRAM_OPTIONS = ["--exec", "--receive-pack", "--upload-pack", "--open-files-in-pager"]

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
const UNREADABLE = /[$`{}*?[\]\\]/

/**
 * True when an option of `args` (before `--`) names a program git starts, or any prefix git
 * accepts.
 */
const startsProgram = (args: ReadonlyArray<string>): boolean => {
  const dashes = args.indexOf("--")
  return (dashes === -1 ? args : args.slice(0, dashes)).some((arg) => {
    const name = arg.split("=")[0] ?? arg
    return (
      name.startsWith("--") &&
      name.length >= 4 &&
      PROGRAM_OPTIONS.some((option) => option.startsWith(name))
    )
  })
}

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

/**
 * What a command of `git` does, from its words (the program at `start`). Every word up to the
 * subcommand must be known exactly: a global option from a short list, `-c` with a harmless
 * setting, and a literal subcommand from {@link SUBCOMMANDS}. `commit` is a commit and `push` is
 * checked by {@link pushVerdict}; a missing subcommand, an unknown one (an alias or `git-foo`), a
 * `-c`/`--config-env` that could define an alias or change a push, a `git config` that does, and an
 * option that starts a program are unclear.
 */
const gitVerdict = (words: ReadonlyArray<string>, start: number): ReadonlyArray<GitWrite> => {
  let at = start + 1
  let risky = false
  while (words[at]?.startsWith("-")) {
    const option = words[at] ?? ""
    const name = option.split("=")[0] ?? option
    if (isDynamic(option)) return ["unclear"]
    if (option === "-c") {
      const setting = words[at + 1]
      if (setting === undefined || isDynamic(setting)) return ["unclear"]
      risky ||= !SAFE_SETTING.test(setting)
      at += 2
    } else if (GIT_VALUED.has(name)) {
      const hasValue = option.includes("=")
      if (isDynamic(words[at + (hasValue ? 0 : 1)] ?? EXPANDED)) return ["unclear"]
      at += hasValue ? 1 : 2
    } else if (GIT_FLAGS.has(option)) at += 1
    else return ["unclear"]
  }
  const subcommand = words[at]
  if (subcommand === undefined || isDynamic(subcommand)) return ["unclear"]
  if (subcommand === "commit") return ["commit"]
  if (risky || !SUBCOMMANDS.has(subcommand)) return ["unclear"]
  const args = words.slice(at + 1)
  if (startsProgram(args)) return ["unclear"]
  if (subcommand === "rebase" && args.some((arg) => /^-[A-Za-z]*x/.test(arg))) return ["unclear"]
  if (subcommand === "grep" && args.some((arg) => /^-[A-Za-z]*O/.test(arg))) return ["unclear"]
  if (subcommand === "config" && args.some((arg) => RISKY_CONFIG.test(arg))) return ["unclear"]
  return subcommand === "push" ? pushVerdict(args) : []
}

/**
 * What one simple command runs. Only a command made of a plain, known program with words the scan
 * reads exactly passes: assignments and grammar words before it are skipped (an assignment to a
 * variable that changes how programs run is not), `env` only with assignments, and the program must
 * be in {@link PROGRAMS} (a path only for `git` and the hook's own `holyagent` wrapper). A `git`
 * word among the arguments of a program that does not merely print or search text is the program
 * run by another, so it is not read. Git is judged by {@link gitVerdict}.
 */
const writesOf = (
  words: ReadonlyArray<string>,
  ownWrapper: OwnWrapper,
): ReadonlyArray<GitWrite> => {
  let start = 0
  while (start < words.length) {
    const word = words[start] ?? ""
    if (ASSIGNMENT.test(word)) {
      if (RISKY_VARIABLE.test(word)) return ["unclear"]
      start += 1
    } else if (GRAMMAR.has(word)) start += 1
    else if (word === "env") {
      start += 1
      if (words[start]?.startsWith("-")) return ["unclear"]
    } else break
  }
  const first = words[start]
  if (first === undefined) return []
  if (CLOSERS.has(first) && start === words.length - 1) return []
  // `for name in words` and `for name` only list; a `git` among the words is data.
  if (
    first === "for" &&
    /^[A-Za-z_]\w*$/.test(words[start + 1] ?? "") &&
    (words.length === start + 2 || words[start + 2] === "in")
  )
    return []
  if (isDynamic(first) || !PLAIN_PROGRAM.test(first)) return ["unclear"]
  // The plugin folder stands for the wrapper only: `"${CLAUDE_PLUGIN_ROOT}/scripts/holyagent"`.
  if (first.includes(PLUGIN_ROOT) && first !== `${PLUGIN_ROOT}/scripts/holyagent`)
    return ["unclear"]
  const program = isGit(first) ? "git" : isHolyagent(first, ownWrapper) ? "holyagent" : first
  if (!PROGRAMS.has(program) || (first !== program && !first.endsWith(`/${program}`)))
    return ["unclear"]
  const args = words.slice(start + 1)
  if (!READERS.has(program) && args.some(isGit)) return ["unclear"]
  if (GUARDS[program]?.(args) === true) return ["unclear"]
  return program === "git" ? gitVerdict(words, start) : []
}

const writesIn = (line: string, ownWrapper: OwnWrapper): ReadonlyArray<GitWrite> => {
  const scan = scanLine(line)
  return [
    ...scan.commands.flatMap((words) => writesOf(words, ownWrapper)),
    ...(scan.overflow || scan.unclear ? (["unclear"] as const) : []),
  ]
}

/**
 * What a command line that mentions Git with `commit` or `push` is allowed to do. Every simple
 * command of the line (found behind `cd a &&`, a pipe, a subshell, a substitution, a loop or an
 * assignment) must be read with certainty and run a known program, or the result holds `unclear`:
 * `commit` for `git commit`, `force-push` for a `git push` that force-updates or deletes remote
 * refs. A line with no such command is empty. In order of appearance, each once. `ownWrapper`
 * accepts the absolute path of the hook's own `holyagent` wrapper as a program word; with the
 * default, no path does.
 */
export const gitWrites = (
  line: string,
  ownWrapper: OwnWrapper = () => false,
): ReadonlyArray<GitWrite> => [...new Set(writesIn(line, ownWrapper))]
