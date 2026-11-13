/** The argv of a `cmd.exe` launch, or why `cmd.exe` cannot be trusted to read it as separate words. */
export type CmdLaunch =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string }

// What no quoting can make safe: `cmd.exe` expands `%` and `^` and `!` inside quotes, Node's quoting
// escapes a `"` as `\"`, which `cmd.exe` does not know, and a control character ends or splits the line.
const UNQUOTABLE = /["%^!]|\p{Cc}/u
// Metacharacters that only a quote makes literal. Node quotes an argument only when it holds a space,
// a tab or a quote, so in any other argument these would be read as syntax.
const BARE_SYNTAX = /[&|<>()]/

/**
 * The arguments that start `command args...` through `cmd.exe`, which only a shell can run for a
 * `.cmd` or `.bat` file. Both the Pi extension (for its `.cmd` shims) and the shell's host-program
 * launch use it. The spawn is made without a shell and without `windowsVerbatimArguments`, so Node
 * quotes each argument itself (in quotes when it holds a space, a tab or a quote, otherwise bare)
 * and joins them with spaces; `cmd.exe` receives that line unchanged. One extra pair of quotes
 * around the whole line cannot be passed through that quoting, which would escape the inner quotes
 * as `\"`. The line instead starts with `call`, so it does not begin with a quote and `cmd.exe`
 * strips none: `cmd.exe /d /s /c call "C:\a b\x.cmd" --flag "C:\c d\x"`. Every word stays a
 * separate argument. A word with a character that no quoting protects (see {@link UNQUOTABLE}), or
 * with a `cmd.exe` operator while the spawn would leave it unquoted, is refused instead of
 * started.
 */
export const cmdExeArguments = (command: string, args: ReadonlyArray<string>): CmdLaunch => {
  for (const word of [command, ...args]) {
    if (UNQUOTABLE.test(word))
      return {
        ok: false,
        reason: `cmd.exe would read part of ${JSON.stringify(word)} as syntax (a quote, %, ^, ! or control character)`,
      }
    if (BARE_SYNTAX.test(word) && !/[ \t]/.test(word))
      return {
        ok: false,
        reason: `cmd.exe would read part of ${JSON.stringify(word)} as an operator (& | < > or a parenthesis), since it holds no space to be quoted for`,
      }
  }
  return { ok: true, args: ["/d", "/s", "/c", "call", command, ...args] }
}

/** Whether a Windows program is a batch file, which only `cmd.exe` can run. */
export const isBatchFile = (path: string): boolean => /\.(?:cmd|bat)$/i.test(path)
