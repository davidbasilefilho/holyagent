/**
 * What the model is told about the shell, as lines of the bash tool's prompt guidelines. Only what
 * differs from the bash it knows: which commands run in the shell and which on the machine, how to
 * reach a program a built-in shadows, and how to run TypeScript.
 */
export const BASH_GUIDELINES: ReadonlyArray<string> = [
  "The shell is just-bash. Commands it implements (rg, grep, sed, awk, jq, find, ls, xargs, tar, diff and the rest) run inside it and win over a program of the same name on the machine; every other command (git, bun, bunx, mise, gh, node, the holyagent CLI) runs the real program on PATH. host-<name> reaches the machine's program that a built-in shadows (host-cat). A program given by path (./node_modules/.bin/tsc) is read as a shell script, so run it by name or through bunx.",
  "js-exec runs TypeScript first and JavaScript when TypeScript cannot read the code: js-exec -c '<code>', code on standard input, or js-exec file.ts. node is the machine's real node.",
  "The working directory and variables stay as the last call left them, except after a call that runs exit.",
]
