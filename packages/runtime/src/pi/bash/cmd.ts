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
 * `.cmd` or `.bat` file. The rules are those of `cmdExeArguments` in the Pi extension (the same
 * quoting, the same refusals), which the shell's bundle cannot import. The spawn quotes each
 * argument itself (in quotes when it holds a space, a tab or a quote, otherwise bare) and joins
 * them with spaces, so the line starts with `call`, which keeps `cmd.exe` from stripping a leading
 * quote: `cmd.exe /d /s /c call "C:\a b\x.cmd" --flag "C:\c d\x"`. Every word stays a separate
 * argument. A word with a character that no quoting protects (see {@link UNQUOTABLE}), or with a
 * `cmd.exe` operator while the spawn would leave it unquoted, is refused instead of started.
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
