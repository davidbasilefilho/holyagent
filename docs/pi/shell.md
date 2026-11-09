# The bash tool on just-bash

**Status: ships in 0.3.1 as the `just-bash` capability (`pi.features.justBash`, on by default).** Pi's `bash` tool, for the root and every specialist, runs on [just-bash](https://github.com/vercel-labs/just-bash), a simulated shell written in TypeScript, instead of a real `bash`. Commands it implements run inside it; every other command runs the real program on the machine. The same shell works on Linux, macOS and Windows, so a machine without Git Bash needs nothing extra.

## The decisions

- **Backend (maintainer, 2026-11-09).** The bash tool runs on just-bash, through Pi's `BashOperations`. just-bash 3.6.0 cannot run host executables itself, so commands it lacks resolve to the real programs on `PATH` and the other places a developer's tools live, and `git`, `bun`, `bunx`, `mise`, `gh`, `node` and the `holyagent` CLI keep working.
- **Built-ins win (maintainer, 2026-11-09: "prefer them instead of the ones in PATH").** Where just-bash implements a command (`rg`, `grep`, `sed`, `awk`, `jq`, `find`, `ls`, `xargs`, `tar`, `diff`, and the rest), its own runs, and the machine's program of that name is not registered. `host-<name>` reaches the machine's program (`host-cat`). Two just-bash commands give way to the machine's program, since they cannot do their job here: `node`, which only prints "use js-exec" (without a machine `node` the refusal stays, since it names the way forward), and `sqlite3`, which needs a worker file that the one-file bundle does not have.
- **TypeScript first, JavaScript as the fallback (maintainer, 2026-11-09).** `js-exec` is just-bash's QuickJS runtime. Inline code (`js-exec -c '...'`) and code on standard input are read as TypeScript and run with the types removed (Bun's transpiler, which also compiles enums); code that TypeScript's grammar refuses, such as repeated parameter names, runs as written. A file is left to `js-exec`, which reads `.ts` and `.mts` as TypeScript by its extension.
- **Billion Context's bash guardrails are off (maintainer, 2026-11-09).** See [the guardrails](#billion-contexts-guardrails).
- **A module of its own (maintainer, 2026-11-09).** The shell is its own capability behind a narrow seam, can be turned off alone, and its one third-party package sits at an exact pin that only `mise run deps:update` moves.

## How a call runs

Pi runs on Node, so the shell cannot live in the extension: just-bash and the host-program passthrough use Bun's APIs. For each call the extension starts Bun on the package's `scripts/just-bash.js` (found the way the CLI's Bun is found, and started with no env file and the empty Bun config), writes one JSON line to its standard input (the command, the folder, the whole environment) and reads one JSON line per frame from its standard output: output chunks as they arrive (base64, so binary output passes unchanged), then the exit code and the state the command left. A process per call is about 100 ms of startup, and it makes cancel simple: an abort or Pi's `timeout` kills the process and everything it started (the process group on POSIX, `taskkill /T` on Windows), which stops even a shell loop that never gives the event loop a turn. Pi's contract holds: an abort rejects with `aborted`, a timeout with `timeout:<seconds>`, a missing folder with Pi's own message.

- **State.** The working folder and the variables a call leaves are kept for the next call, as in a terminal, for as long as Pi passes the same folder (variables a call sets stay set, exported or not, since just-bash reports the shell's variables). A call that runs `exit` keeps neither: just-bash drops the state on `exit`, and it has no `trap ... EXIT` or `exit` override to read it first.
- **Files.** The shell sees the real disk at real paths (just-bash's `ReadWriteFs`). Its own `/usr/bin` and `/bin` are in-memory folders with one stub per command, because just-bash resolves a command only from a file at exactly `/usr/bin/<name>` or `/bin/<name>`; the shell's `PATH` is those two folders. A program given by path (`./node_modules/.bin/tsc`) is therefore read as a shell script, not run; run it by name or through `bunx`.
- **Host programs.** Looked up in the call's `PATH`, then in Bun's install folder (`BUN_INSTALL`, `~/.bun/bin`), `~/.local/bin`, mise's shims, cargo's `bin`, Homebrew and the system folders, so a Pi started from a desktop app with a short `PATH` still finds them. A program starts with that `PATH`, never the shell's. On Windows a program is a file with a `PATHEXT` extension, named without it, and each existing drive is a folder of the shell (`C:\proj` is `/c/proj`); the folder and the arguments that name a file below a drive are mapped back for the program. A host program that is the whole command streams its output as it arrives; in a pipe or a list the output is sent when the command ends.
- **Limits.** just-bash's command, loop, work-unit and JavaScript time limits are raised so that only Pi's `timeout` and abort end a call.

## Billion Context's guardrails

Billion Context adds three guardrails to the `bash` tool: a default 60 s timeout for a call that names none, a 50 KB cap on a result, and a repeated-call breaker (which watches every tool, not only bash). While the capability is on, HolyAgent turns all three off through Billion Context's own settings:

- the environment, `BILI_GUARDRAIL_BASH_TIMEOUT=0`, `BILI_GUARDRAIL_MAX_OUTPUT_BYTES=0` and `BILI_GUARDRAIL_REPETITION=0`, which the extension sets for the Pi process (a value you set stays) and `toolArgs` lists in `env`;
- its file, `guardrails.bashTimeout`, `guardrails.maxOutputBytes` and `guardrails.repetition`, which `holyagent setup` writes (a value you set stays) while Billion Context itself is on.

Billion Context reads its environment when its extension loads, which can be before the HolyAgent extension has read the config and set the variables; the file is read at that same moment and needs no load order, so both are set. The environment wins when both are present. With the capability off, neither is touched.

## The capability

| Entry    | Value                                                                                                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name     | `just-bash`, switched by `pi.features.justBash` (`holyagent setup --just-bash on\|off`), on by default                                                                            |
| Needs    | Bun on `PATH`; `holyagent doctor` fails the line and says where to get it. No display, so the headless and the normal form are the same                                           |
| Installs | Nothing: no Pi package, no MCP server                                                                                                                                             |
| Applies  | The root and the specialists, under every provider                                                                                                                                |
| Off      | The extension never registers its `bash` tool, so Pi's own tool, with its shell settings (`shellPath`, `shellCommandPrefix`), is untouched, and Billion Context's guardrails stay |

The extension registers the tool when a session's config says the capability is on, not at load: Pi's own `bash` tool definition (schema, truncation, rendering) with the shell's operations and a few guideline lines for the model. While it is on, `shellPath` and `shellCommandPrefix` do not apply. Pi's `!` command, which runs through `user_bash`, is not changed.

## The pin and the bundle

just-bash is an exact `3.6.0` in `packages/runtime/package.json`, not a range: it decides how a shipped feature behaves, so its upgrade is one deliberate step. `mise run deps:update` moves it (and `--check` fails when it is behind) through `EXACT_PACKAGES` in `scripts/dependency-pins.ts`; `scripts/dependency-ranges.test.ts` refuses a range for it. The shell is bundled for Bun into `scripts/just-bash.js` (`packages/runtime/src/pi/bash/entry.ts`), a file of its own, so a move of the pin changes that file and no other. The bundle leaves out `sql.js` (replaced by a stub, since `sqlite3` is not offered) and the optional native add-ons `node-liblzma` and `@mongodb-js/zstd` (`xz` and `zstd` archives report them missing), so that it is the same on every machine and needs nothing beside it.

## Not verified

The Windows paths (drive mounts, `PATHEXT`, `.cmd` shims, `taskkill`) are covered by unit tests on their pure parts and by the tests that start real programs; no Windows machine ran the whole path. The registration of the tool after session start rests on Pi's documented behavior (`registerTool` works after startup and a tool under a built-in's name replaces it); no Pi session was started.
