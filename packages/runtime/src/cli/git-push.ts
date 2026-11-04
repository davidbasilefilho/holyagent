/**
 * Characters that end a simple command outside quotes: `;`, `&`, `|`, a newline, parentheses and
 * backticks.
 */
const SEPARATORS: ReadonlySet<string> = new Set([";", "&", "|", "\n", "(", ")", "`"])

/**
 * The words of each simple command of a shell line, with quotes removed and a quoted string kept as
 * one word. Escapes, expansions and here-documents are not followed: this reads what a command
 * spells out, and a line that hides its words behind them yields different words.
 */
const simpleCommands = (line: string): ReadonlyArray<ReadonlyArray<string>> => {
  const commands: Array<Array<string>> = []
  let words: Array<string> = []
  let word = ""
  let started = false
  let quote: string | undefined
  const endWord = () => {
    if (started) words.push(word)
    word = ""
    started = false
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) commands.push(words)
    words = []
  }
  for (const char of line) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (SEPARATORS.has(char)) endCommand()
    else if (/\s/.test(char)) endWord()
    else {
      word += char
      started = true
    }
  }
  endCommand()
  return commands
}

/** The last path segment of a word, so `/usr/bin/git` and `git.exe` read as `git`. */
const programOf = (word: string): string =>
  (word.split(/[\\/]/).at(-1) ?? word).replace(/\.exe$/i, "")

/** The shells whose `-c` argument is a command line of its own. */
const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"])

/**
 * What may stand before `git` in a command that runs it: environment assignments, the common
 * wrappers (`sudo`, `env`, `timeout 5`, `xargs` and the like) and their flags and durations. A
 * command that starts with anything else (`echo git push …`) only mentions git.
 */
const WRAPPER_WORD =
  /^(?:\w+=.*|sudo|env|command|exec|time|nice|nohup|xargs|timeout|stdbuf|-.*|\d+[smhd]?)$/

/** Global options of git that take their value as the next word. */
const GIT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
])

/** Options of `git push` that take their value as the next word. */
const PUSH_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--repo",
  "-o",
  "--push-option",
  "--receive-pack",
  "--exec",
])

/** The target ref of a refspec: the part after the last `:`, without `+` or `refs/heads/`. */
const targetOf = (refspec: string): string => {
  const spec = refspec.replace(/^\+/, "")
  const target = spec.includes(":") ? (spec.split(":").at(-1) ?? "") : spec
  return target.replace(/^refs\/heads\//, "")
}

/** The refs a `git push` names as targets, from the words that follow `push`. */
const targetsOfPush = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const positionals: Array<string> = []
  let remoteByOption = false
  let optionsEnded = false
  for (let at = 0; at < args.length; at += 1) {
    const arg = args[at] ?? ""
    if (optionsEnded || !arg.startsWith("-")) positionals.push(arg)
    else if (arg === "--") optionsEnded = true
    else if (PUSH_OPTIONS_WITH_VALUE.has(arg)) {
      remoteByOption ||= arg === "--repo"
      at += 1
    } else remoteByOption ||= arg.startsWith("--repo=")
  }
  return (remoteByOption ? positionals : positionals.slice(1)).map(targetOf)
}

/** The refs a single simple command pushes to, when it runs `git push`. */
const pushTargetsOf = (words: ReadonlyArray<string>): ReadonlyArray<string> => {
  const at = words.findIndex((word) => programOf(word) === "git")
  if (at < 0 || !words.slice(0, at).every((word) => WRAPPER_WORD.test(word))) return []
  let next = at + 1
  while ((words[next] ?? "").startsWith("-"))
    next += GIT_OPTIONS_WITH_VALUE.has(words[next] ?? "") ? 2 : 1
  return words[next] === "push" ? targetsOfPush(words.slice(next + 1)) : []
}

/**
 * The refs that the `git push` commands of a shell line name as targets (`origin claude/x`,
 * `HEAD:claude/x`, `+HEAD:refs/heads/claude/x` give `claude/x`). Only a command that runs `git`
 * with `push` as its subcommand counts, so the word `push` in a commit message, a path or another
 * command gives nothing; a `-c` string of a shell is read as a line of its own. A `git -C` or a
 * `cd` is not followed, and neither is anything a shell expands.
 */
export const pushTargets = (line: string): ReadonlyArray<string> =>
  simpleCommands(line).flatMap((words) => {
    const flag = SHELLS.has(programOf(words[0] ?? ""))
      ? words.findIndex((word) => /^-\w*c$/.test(word))
      : -1
    const script = flag < 0 ? undefined : words[flag + 1]
    return script === undefined ? pushTargetsOf(words) : pushTargets(script)
  })
