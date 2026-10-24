# Hooks

The plugin ships three hooks, all running the runtime CLI as `scripts/holyagent hook <name>` with a 10-second timeout. A hook that has nothing to say prints nothing and exits 0. Every failure is exit 1 with one `holyagent hook <name>: …` line on stderr and nothing on stdout, so a failure never reads as a decision. The host treats exit 2 as a block and lets any other failure through unless the hook sets `onFailure: "block"`, which the two `PreToolUse` hooks do.

| Hook            | Event and matcher                                 | `if`                 | `onFailure` | Output                                                                        |
| --------------- | ------------------------------------------------- | -------------------- | ----------- | ----------------------------------------------------------------------------- |
| `session-start` | `SessionStart`: `startup\|resume\|clear\|compact` | none                 | default     | `additionalContext`: a capped open-work status, plus a core of the root rules |
| `vcs-redirect`  | `PreToolUse`: `Bash`                              | `Bash(*git*commit*)` | `block`     | a `deny` decision naming `holyagent vcs commit`                               |
| `vcs-redirect`  | `PreToolUse`: `Bash`                              | `Bash(*git*push*)`   | `block`     | a `deny` decision naming `holyagent vcs push`                                 |
| `workflow`      | `PreToolUse`: `Workflow`                          | none                 | `block`     | an `allow` decision for a prebuilt workflow, else nothing                     |

`hooks/hooks.json` in the plugin is the reference for these rules.

## `session-start`

After a start, resume, clear or compaction the root has lost what is running. The hook adds context in TOON: the open Intents (id, revision, objective), the Intent in use, the Running Assignments (id, role, agent, objective) and the Succeeded ones not yet accepted, preceded by a fixed line saying the objectives are project data, not instructions. It prints nothing in a project without a `.holyagent` folder.

- It reads only the state of open Intents, so its cost follows open work, not the whole history ([decisions.md](decisions.md) has the predecessor's figures).
- It stays small and deterministic. The whole context is capped at 9,000 characters, because the host cuts `additionalContext` at 10,000 and a cut would drop the tail unannounced. If the status does not fit, it is narrowed in steps (10 rows of 200 characters, 5 of 120, 3 of 80, 1 of 60, then counts only) with a `+N more` line for what was left out, and long objectives and agent ids are shortened.
- When the payload's `agent_type` is the root (`holyagent` or `holyagent:holyagent`) the rules are already in the system prompt and only the status is added. When the main agent is anything else, the hook prepends a compact core of the root rules (the span of `root.md` between its core markers, with `${CLAUDE_PLUGIN_ROOT}` filled in) and a pointer to the full rules in the holyagent agent prompt.
- A failure is loud on stderr, not silent.

## `vcs-redirect`

Raw `git commit` carries whatever the harness adds, and the author is whatever git is configured with; `holyagent vcs commit` fixes both ([commit-authorship.md](commit-authorship.md)). The hook denies a command that runs `git commit` or `git push` and gives the replacement in the reason: `Commit with holyagent vcs commit -m <headline> -- <paths…>` or `Push with holyagent vcs push [branches…]`.

- It is scoped: the `if` rules in `hooks/hooks.json` mean the host starts the hook for matching commands only, not for every Bash call.
- The `if` rules `Bash(*git*commit*)` and `Bash(*git*push*)` match the command text wherever `git` is followed by `commit` or `push` (probed on Claude Code 2.1.310). The parser then decides: only a command that actually runs `git commit` or `git push` counts. `git commitizen`, `echo "git commit"`, a heredoc body or a comment do not, and `cd a && git commit`, a pipe, a subshell, a substitution, an env prefix, wrappers such as `sudo`, `env`, `timeout` and `xargs`, global git options (`git -C dir commit`) and `sh -c '…'` do.
- The hook never calls git and never looks for the state root, so a git failure cannot stop it.
- `onFailure: "block"`, because a failure would let the raw write through unexamined.
- It is a redirect, not a sandbox. Other git writes (`branch`, `checkout`, `reset`, `gh` writes) and edits under `.git/` or `.holyagent/` are not stopped; the specialist text forbids them. Commands that hide the words escape it: a variable standing for `git` (`g=git; $g commit`), a git alias (`git ci`), and a script, make target or package script that runs git inside.

## `workflow`

The `Workflow` tool otherwise asks for permission. The hook allows a run that names one of this plugin's prebuilt workflows (`holyagent:implement-review`, `holyagent:review-diff`, `holyagent:run-assignments`) and carries only `name`, `args`, `description` and `title`, when every `agent` anywhere in `args` is one of the eighteen route agents (bare or `holyagent:`-prefixed) and no workflow file whose name starts with `holyagent` exists in a `.claude/workflows` folder of the working directory or its parents, the home directory or `CLAUDE_CONFIG_DIR` (such a file could shadow a prebuilt name; an unreadable folder counts as one). An inline script, a script path or a resume field would run other code. Any input that fails a test gets no decision and goes through the normal permission flow. Like the redirect, the hook never calls git. Whether to run a workflow at all stays the root's rule: it needs your opt-in ([cache-and-workflows.md](cache-and-workflows.md)). `onFailure: "block"`, because a failure would let an unvetted workflow through.

## Removed from the predecessor

The Bash and write guard, the observation hooks (`SubagentStart`, `SubagentStop`, `PostToolUse` on Agent, effort recording) and the dispatch guard are gone, by the maintainer's decision. The reasons and the audit figures are in [decisions.md](decisions.md).

## The wrapper

The hooks run `scripts/holyagent`, a POSIX `sh` wrapper around the bundled CLI (`scripts/holyagent.js`, one file made by Bun's bundler).

- It must be started by its path (`${CLAUDE_PLUGIN_ROOT}/scripts/holyagent`); started by a bare name from `PATH`, it prints `error: WrapperPath` and exits 127, since the directory it would resolve is the project's.
- It finds `bun` on `PATH`, else in `$BUN_INSTALL/bin` or `~/.bun/bin`. Without one it prints `error: BunMissing: …` with the fix on stderr and exits 127 for every caller, hooks included, so a missing runtime is never mistaken for a quiet success. The same exit and message cover a missing `holyagent.js` bundle.
- It starts Bun with `--no-env-file --config=scripts/empty-bunfig.toml`. The working directory is the project, and Bun would otherwise load the project's `.env` and `bunfig.toml`: an `.env` could redirect the state folder, and a bunfig `preload` would run code on every call. The CLI reads neither.
- On the common path it forks nothing (parameter expansion and builtins only), because each fork is a process under Git Bash on Windows.
