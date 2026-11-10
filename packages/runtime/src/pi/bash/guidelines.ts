/**
 * What the model is told about the shell, as lines of the bash tool's prompt guidelines. Only what
 * differs from the bash it knows: which commands run in the shell and which on the machine, how to
 * reach a program a built-in shadows, and how to run TypeScript.
 */
export const BASH_GUIDELINES: ReadonlyArray<string> = [
  "The shell is just-bash. Commands it implements (rg, grep, sed, awk, jq, find, ls, xargs, tar, diff and the rest) run inside it and win over a program of the same name on the machine; every other command (git, bun, bunx, mise, gh, node, the holyagent CLI) runs the real program on PATH. host-<name> reaches the machine's program that a built-in shadows (host-cat). A program given by path (./target/debug/app, node_modules/.bin/tsc) or found in a folder you added to PATH runs on the machine; a shell script given by path runs in the shell.",
  "js-exec runs TypeScript first and JavaScript when TypeScript cannot read the code: js-exec -c '<code>', code on standard input, or js-exec file.ts. node is the machine's real node.",
  "The working directory and variables stay as the last call left them, exit included.",
]
