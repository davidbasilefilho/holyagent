# Agent CLI

`holyagent-cli` is the automation interface for Intents, Assignments, state and agent operations. For T3 Code installation and maintenance, use [`holyagent`](usage.md#install).

## Input

Run `holyagent-cli -h` or `holyagent-cli --help` for the command list. For a command's typed flags, run its help, for example `holyagent-cli assignment dispatch --help`. Repeat list flags once for each value. Pass specialist reports through `--report-file` to preserve their text. The agent CLI does not read stdin or open a terminal prompt. Use the host's question tool for a decision that belongs to the user.

```sh
holyagent-cli intent create --objective 'Fix the release installer' --requirement 'Preserve existing state'
holyagent-cli assignment dispatch --role-task Explorer.lookup --objective 'Find the failed check' --criterion 'blocking:tests:Identify the failing command'
holyagent-cli assignment close <id> --outcome success --report-file <path>
```

Each `--criterion` uses `<blocking|advisory>:<dimension>:<text>`. The dimensions are `behavior`, `regressions`, `tests`, `scope`, `style` and `repo-standards`. Supply only `--id` to dispatch an existing Ready Assignment. The CLI checks flags and validates JSON state on read and write. Keep existing state files in place when switching to the new command.

## Output

Every invocation writes one TOON document to stdout. This includes help, errors and `-v` or `--version`, which return a `version` field. Read the dispatch response's decoded `prompt` field to obtain the original prompt. Failures carry an `error` record with a tag, a message, a hint and an exit code. Exit code 2 means invalid arguments, 3 means a refused operation and 4 means a state or I/O failure.

`rg` and `fd` return `stdout`, `stderr` and `exitCode` in the TOON document and preserve the child process's exit status. Control characters are escaped in the document. Read the original file when you need exact bytes. The bundled host entry handles hook JSON and browser server MCP messages for the integrations.

HolyCodex v0.16.12 is the precedent for shipping separate executables and validating options before running an agent operation. HolyAgent applies that separation with typed flags, TOON results and its existing JSON state schemas. [HolyCodex bin manifest](https://github.com/davidbasilefilho/holycodex/blob/a56aa726c39347e610d1e2430ac49ab4ef62aad6/packages/cli/package.json#L9-L12), [HolyCodex option validation](https://github.com/davidbasilefilho/holycodex/blob/a56aa726c39347e610d1e2430ac49ab4ef62aad6/packages/agent/src/index.ts#L364)
