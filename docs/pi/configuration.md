# Pi configuration: files, locations, precedence, keys

**Status: planned for 0.3.0. The first section is the plan for HolyAgent's own configuration; the sections after it are research on Pi's configuration and are not shipped behaviour.**

Pi 1.4.0, commit `4a080252f06caf63a525d7873c5d94d3c23887e0` (the plan pins 1.5.0; see [README.md](README.md#version-risk)). "Inference:" marks a conclusion drawn here, not a stated fact.

## HolyAgent config.json

HolyAgent already reads `.holyagent/config.json`; today the file holds the `vcs` section ([commit-authorship.md](../commit-authorship.md)). The maintainer decided that the Pi integration uses this same file ("alter/extend .holyagent/config.json, pi section and claude section, common stuff should be outside those sections"). In 0.3.0 it will have three kinds of content:

- a `pi` section, read only by the Pi integration;
- a `claude` section, read only by the Claude plugin;
- settings common to both hosts, outside both sections (the existing `vcs` section is one).

The file is the one place that sets the Pi integration's options, which functionality is on, and the model provider. Turning a function or the provider on or off turns on or off the existing Pi extensions and packages that supply it, and a disabled one is neither loaded nor required.

What the `pi` section will set, with the default each decision gives:

| Setting                   | Default                                                                                                                                 | Detail                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Provider                  | Kimi for Coding (global); selecting it enables `pi-provider-kimi-code`, and deselecting it disables that extension                      | [providers.md](providers.md#kimi-for-coding-global)                                           |
| Route table               | The Kimi table: model and effort for every specialist role, so a change needs no code. The root's effort is `high`; `max` is selectable | [providers.md](providers.md#routing)                                                          |
| Web search and fetch      | Kimi's `moonshot_search` and `moonshot_fetch`; `pi-web-kit` is the fallback, disabled while the provider extension offers web tools     | [extensions.md](extensions.md#tool-surface-for-030)                                           |
| Long-command watching     | `@aliou/pi-processes` on                                                                                                                | [extensions.md](extensions.md#tool-surface-for-030)                                           |
| Task list and questions   | `@juicesharp/rpiv-todo` and `@juicesharp/rpiv-ask-user-question` on                                                                     | [extensions.md](extensions.md#tool-surface-for-030)                                           |
| Computer use              | `@amaster.ai/pi-computer-use`, for the two visual specialists only; on or off like any reused extension                                 | [t3-code.md](t3-code.md#computer-use-through-cua-driver)                                      |
| Context compression       | Billion Context on, for the root and the specialists                                                                                    | [caching-and-subagents.md](caching-and-subagents.md#context-compression-with-billion-context) |
| Workflows and specialists | `@tintinweb/pi-subagents`                                                                                                               | [orchestration.md](orchestration.md#decision-for-030)                                         |

Rules for the file:

- It is decoded with Effect Schema and `onExcessProperty: "error"` when it loads, and every option has a documented default.
- An invalid file stops the run with a message that names the field. It never falls back silently.
- Installing the package installs only the dependencies that the default `config.json` enables.
- The key names are to be settled when the schema is written. That change also documents every option with its default on this page.

### The user-level config

The maintainer's words: "Add ~/.holyagent config". In 0.3.0 a user-level `~/.holyagent/config.json` holds per-user defaults:

- It has the same Effect Schema as the project's `.holyagent/config.json`: the common settings, the `pi` section and the `claude` section.
- The project's `.holyagent/config.json` overrides it key by key.
- Both files are decoded with `onExcessProperty: "error"` before they are merged, so an unknown key in either stops the run with a message that names the field and the file ([rules above](#holyagent-configjson)).
- How nested objects and lists merge is to be settled when the schema is written.
- Tests cover the user and project merge inside the existing CI jobs.

Inference: Pi itself keeps provider logins, `defaultProjectTrust` and `npmCommand` in `~/.pi/agent`, so the user-level file is for HolyAgent's own defaults and not a second home for those. The file is read by the Claude plugin too; its scopes are in [usage.md](../usage.md#install-scopes).

## Files and locations

User-level config lives in the _agent directory_, default `~/.pi/agent`, overridable with `PI_CODING_AGENT_DIR` or the SDK `agentDir` option ([configuration.md L7-L9](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/configuration.md#L7-L9), [environment-variables.md L81](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/environment-variables.md#L81)).

| Path in the agent directory                                              | Purpose                                                     |
| ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `settings.json`                                                          | preferences, defaults, resource paths, package declarations |
| `keybindings.json`                                                       | key bindings                                                |
| `mcp.json`                                                               | MCP servers for every project                               |
| `models.json`                                                            | compatible endpoints, custom models, model overrides        |
| `auth.json`                                                              | saved API keys and OAuth credentials                        |
| `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD` | user instructions                                           |
| `SYSTEM.md`, `APPEND_SYSTEM.md`                                          | replace / append to the system prompt                       |
| `extensions/`, `skills/`, `prompts/`, `themes/`                          | user resources                                              |

Source: [configuration.md L11-L24](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/configuration.md#L11-L24). Project config lives in `.pi/` under the working directory: `settings.json`, `mcp.json`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/`, `skills/`, `prompts/`, `themes/` ([configuration.md L26-L37](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/configuration.md#L26-L37)). Other state: saved trust decisions in `~/.pi/agent/trust.json` ([security.md L67-L71](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/security.md#L67-L71)); sessions in `~/.pi/agent/sessions/` grouped by working directory ([sessions.md L50](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/sessions.md#L50)). The config directory name `.pi` comes from `piConfig.configDir` in `package.json` ([package.json L6-L8](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/package.json#L6-L8)). JSON schemas are published for editors: `https://pi.dev/schemas/settings.schema.json` and `models.schema.json` ([settings.md L5](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L5), [models.md L51](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/models.md#L51)).

## Precedence

1. **Settings.** Project `.pi/settings.json` overrides the agent-directory `settings.json`; resource lists (`packages`, `extensions`, `skills`, `prompts`, `themes`) are combined ([settings.md L3](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L3), [settings.md L148-L163](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L148-L163)). In code, the two layers are deep-merged: nested objects merge recursively, any other value (including arrays) from the project replaces the global one, and `defaultTools` has a special rule where a list made only of `+name`/`-name` entries modifies the inherited list ([settings-manager.ts L60-L146](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/settings-manager.ts#L60-L146)).
2. **Project settings only apply after project trust** (see below). The one exception is `sessionDir`, read before trust ([configuration.md L3](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/configuration.md#L3)).
3. **CLI over settings.** For example, `--tools`, `--no-tools`, `--no-builtin-tools` override `defaultTools`; `--session-dir` beats `PI_CODING_AGENT_SESSION_DIR`, which beats `sessionDir` ([settings.md L58-L60](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L58-L60), [settings.md L66](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L66), [cli.md L96-L97](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/cli.md#L96-L97)).
4. **Credentials.** Order: runtime `--api-key`, then stored `auth.json`, then `apiKey` in `models.json`, then provider environment variables or ambient cloud credentials ([models.md L23](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/models.md#L23)).
5. **System prompt files.** A trusted project `SYSTEM.md`/`APPEND_SYSTEM.md` takes precedence over the agent-directory file of the same name; files are not combined ([configuration.md L39](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/configuration.md#L39)).
6. **Context files** load from the agent directory, the working directory and its parents, and apply below their directory; `AGENTS.override.md` replaces `AGENTS.md`/`CLAUDE.md` only within its own directory; discovery does not need project trust, and `-nc/--no-context-files` disables it ([configuration.md L41-L47](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/configuration.md#L41-L47), [cli.md L214](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/cli.md#L214)).
7. **Reload.** After hand-editing settings, instructions or resources, run `/reload` ([configuration.md L5](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/configuration.md#L5)).

## Project trust

Pi asks for a trust decision before loading `.pi/settings.json`, `.pi/mcp.json`, `.pi/extensions|skills|prompts|themes`, `.pi/SYSTEM.md`/`APPEND_SYSTEM.md` and project `.agents/skills` ([security.md L35-L45](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/security.md#L35-L45)). Decision order: CLI `--approve`/`--no-approve`; then `project_trust` extension handlers (user-level and `-e` extensions only); then saved decisions (closest parent wins); then `defaultProjectTrust` (`ask` by default; agent-directory settings only) ([security.md L59-L73](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/security.md#L59-L73), [settings.md L36](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L36)). Print, JSON and RPC modes cannot show the prompt: with no override, extension or saved decision, `always` loads project resources while `ask` and `never` skip them ([security.md L75-L82](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/security.md#L75-L82)). Trust does not limit what tool calls can do ([security.md L33](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/security.md#L33)).

## Settings keys most relevant to HolyAgent

Full reference: [settings.md](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md) (also at [pi.dev/docs/latest](https://pi.dev/docs/latest)).

| Key                                                                               | Meaning and default                                                                         | Source                                                                                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaultProvider`, `defaultModel`                                                 | startup provider/model, default automatic                                                   | [L13-L14](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L13-L14)     |
| `defaultThinkingLevel`                                                            | `off`..`max`, default `medium`                                                              | [L15](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L15)             |
| `modelThinkingLevels`                                                             | per `provider/modelId` thinking level                                                       | [L16](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L16)             |
| `enabledModels`                                                                   | model patterns for startup and cycling                                                      | [L18](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L18)             |
| `cacheWarming`                                                                    | `off` / `streaming` / `idle`, default `streaming`, global only                              | [L21](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L21)             |
| `showCacheMissNotices`                                                            | show cache-miss notices, default false                                                      | [L20](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L20)             |
| `defaultProjectTrust`                                                             | `ask` / `always` / `never`, agent-directory only                                            | [L36](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L36)             |
| `defaultTools`                                                                    | startup tools, default `read`, `bash`, `edit`, `write`; supports `+name`/`-name`            | [L42](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L42)             |
| `codemode.mode`, `codemode.inlineBudget`                                          | how the `codemode` tool presents other tools (`on`/`only`), description token budget (3000) | [L43-L44](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L43-L44)     |
| `sessionDir`                                                                      | session storage directory                                                                   | [L66](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L66)             |
| `compaction.*` (`enabled`, `reserveTokens`, `keepRecentTokens`, `modelOverrides`) | automatic compaction                                                                        | [L73-L76](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L73-L76)     |
| `transport`                                                                       | `auto`/`sse`/`websocket`/`websocket-cached`                                                 | [L124](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L124)           |
| `retry.*`                                                                         | agent-level and provider-level retry                                                        | [L128-L134](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L128-L134) |
| `shellPath`, `shellCommandPrefix`, `npmCommand`                                   | shell and package-manager commands                                                          | [L142-L144](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L142-L144) |
| `packages`, `extensions`, `skills`, `prompts`, `themes`                           | resource and package lists                                                                  | [L154-L158](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L154-L158) |
| `enableInstallTelemetry`                                                          | anonymous install/update ping, default true                                                 | [L170](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L170)           |

The plan sets two of these: `npmCommand` to `bun` (by `holyagent setup`) and `codemode.mode` to `only` for the root and every specialist. How `only` reaches each process, through settings or the launch, is to be settled at implementation ([How HolyAgent launches Pi](#how-holyagent-launches-pi)).

There is **no** settings key for prompt-cache retention or for tool approval: the only keys mentioning caches are `cacheWarming` and `showCacheMissNotices` ([settings.md L7-L25](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L7-L25)). Cache retention is an environment variable (see [caching-and-subagents.md](caching-and-subagents.md)).

## Environment variables relevant to a host

`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CODEMODE_MAX_WORKERS` (default 2; the plan sets 4), `PI_CACHE_RETENTION` ([environment-variables.md L81-L88](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/environment-variables.md#L81-L88)). Pi marks child processes with `AI_AGENT=pi` and `PI_CODING_AGENT=true`, and the `bash` tool exports `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` ([environment-variables.md L15-L16, L20-L30](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/environment-variables.md#L20-L30)). At startup Pi contacts `pi.dev` for a version check and an anonymous install ping unless `PI_OFFLINE=1`, `PI_SKIP_VERSION_CHECK=1` or `PI_TELEMETRY=0` ([environment-variables.md L84-L86](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/environment-variables.md#L84-L86), [settings.md L170](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L170)).

## How HolyAgent launches Pi

**Status: planned for 0.3.0.** Decided:

- Pi starts as plain `pi` after the one-time `pi install` ([installation.md](installation.md#how-holyagent-installs)); that session is the root. The root launches specialists as child Pi processes through `@tintinweb/pi-subagents` ([orchestration.md](orchestration.md#decision-for-030)).
- Specialists run in full access (see [auto-mode.md](auto-mode.md)) with `PI_SKIP_VERSION_CHECK=1` and `PI_TELEMETRY=0`, and inherit the parent session's project trust: they get `--approve` only when the parent trusted the project ([installation.md](installation.md#global-and-project-local-installs)). They are not run fully offline: the 1.5.0 docs word `PI_OFFLINE` as disabling automatic network activity, including model catalog refreshes.
- The root and every specialist run codemode in mode `only`, and `PI_CODEMODE_MAX_WORKERS` is 4 ([orchestration.md](orchestration.md#codemode-in-030)).
- `holyagent setup` sets Pi's `npmCommand` setting to `bun`, so Pi installs its packages with Bun ([installation.md](installation.md#what-setup-and-doctor-do)).
- Model and thinking level reach Pi as `--model <provider/id>:<thinking>` from the route table in `config.json` ([providers.md](providers.md#routing)).

Still to be settled at implementation: the name and values of the launch flag that tells the extension whether a session is the root, a specialist or another session, and whether the extension also loads in children by `-e` or by the user-level install.

Inference: to keep HolyAgent-driven Pi sessions reproducible, a launch should pass an explicit session directory, `--model`, `--tools` or `--exclude-tools` and `--approve` rather than rely on the user's `~/.pi/agent/settings.json`. All of those are documented flags and variables (links above, [cli.md L55-L110](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/cli.md#L55-L110)).

HolyAgent's own state (Intent revisions, Assignment status) has no place in Pi's settings; Pi offers `pi.appendEntry()` for session-attached data ([extensions.md L337-L355](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/extensions.md#L337-L355)), but the Intent store stays in HolyAgent.
