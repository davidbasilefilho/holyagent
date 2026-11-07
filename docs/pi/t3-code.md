# T3 Code: the primary interface for HolyAgent on Pi

**Status: planned for 0.3.0. Nothing on this page is shipped.** HolyAgent 0.2.x supports Claude Code only. This page records the plan the maintainer decided for T3 Code as the primary interface of the Pi integration, with the research it rests on. The maintainer implements it in the open 0.3.0 Intent "0.3.0 pi 11/12". Where the page says "will", the code does not exist yet.

The maintainer's words: "also I want holyagent pi to be compatible with t3 code", in scope "In 0.3.0"; then "t3code shall be the primary interface for the pi integration, so we will deeply integrate with it. that means we can rely on its integrated browser, computer use, as well as enable anything beneficial we can from it globally or locally".

The research read T3 Code's documentation and pull requests on 2026-11-07. Several T3 source files were read through mirrors rather than upstream `main`; those links are labelled "third-party", and so are the third-party packages. T3's Pi provider is Early Access, so details change: the T3 release must be checked before a detail is relied on ([To verify](#to-verify)). "Inference:" marks a conclusion drawn here, not a stated fact. The Claude plugin under T3 Code is a separate case, described in [usage.md](../usage.md#t3-code).

## The decisions

| Area                  | Decision                                                                                                                                                            | Detail                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Primary interface     | The docs lead with T3 Code. The plain Pi terminal stays supported. HolyAgent relies on T3 features instead of rebuilding them.                                      | [Primary interface](#the-primary-interface)                               |
| How T3 runs Pi        | `pi --mode rpc` on the user's own Pi 0.80.5 or newer, enabled in T3 Settings. The 1.5.0 pin satisfies the floor. HolyAgent sets no launch args for mode or session. | [How T3 runs Pi](#how-t3-runs-pi)                                         |
| Dialogs and UI        | Only the RPC extension UI that T3 renders. Never `custom()`, widgets, footer, titles or theme calls. A HolyAgent adapter covers rpiv tools that need `custom()`.    | [Dialogs and status](#dialogs-and-status-only)                            |
| Approval              | HolyAgent threads run in T3's Full access mode. The docs and the setup check say so, and HolyAgent warns in Supervised and Auto-accept edits.                       | [Full access](#full-access-is-required)                                   |
| Specialists           | They report through `@tintinweb/pi-subagents`' own new-turn trigger, not T3's `delegate_task`. A recorded fixture verifies it under T3.                             | [Specialists and completion notices](#specialists-and-completion-notices) |
| T3's MCP tools        | Keep `html_render`, `html_preview`, `preview_*`, `t3_preview_*` and `device_*`. Deactivate every other `mcp__t3-code__` tool with `pi.setActiveTools`.              | [T3's tools](#t3s-tools-kept-and-deactivated)                             |
| Browser               | T3's integrated browser through the named `preview_*` tools, pinned in the fixed tool set.                                                                          | [Browser](#browser)                                                       |
| Computer use          | Cua Driver as bundled by the pinned `@amaster.ai/pi-computer-use` extension, standard mode, confirmations off, only for the two visual specialists.                 | [Computer use](#computer-use-through-cua-driver)                          |
| Devices               | T3's `device_*` tools are kept, and device access is enabled where the host supports it. Whether Pi reaches `device_*` is verified during implementation.           | [Devices](#devices)                                                       |
| T3 settings           | Setup writes the beneficial T3 settings once their file format is verified, and prints the UI steps until then.                                                     | [T3 settings](#t3-settings-written-by-setup)                              |
| Relied on as they are | T3's pickers, checkpoints, skills menu, worktrees, terminal, diff and PR flow.                                                                                      | [Relied on](#relied-on-as-they-are)                                       |
| Tests                 | Recorded `pi --mode rpc` fixtures inside the existing CI jobs.                                                                                                      | [Tests](#tests)                                                           |

## The primary interface

T3 Code is the primary interface for HolyAgent on Pi. The Pi documentation leads with it, and HolyAgent relies on T3's browser, dialogs, pickers, worktrees and the rest instead of rebuilding them. The plain `pi` terminal stays supported: everything in the other [Pi pages](README.md) works there, and nothing in this plan removes a terminal path. The pieces below that exist only under T3 (the MCP bridge tools, the dialogs) are absent in a terminal, and the visual roles report an inspection as blocked when their tools are missing, as the Claude text already does ([claude-parity.md](claude-parity.md#8-what-pi-cannot-carry)).

## How T3 runs Pi

Sourced from T3's [Pi provider page](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-pi.md) and [PR #7211](https://github.com/pingdotgg/t3code/pull/7211) (merged 2026-09-10; the PR marks the provider "Early Access"):

- T3 Code (`pingdotgg/t3code`, MIT) lists Pi as a built-in provider next to Codex, Claude, Cursor, Grok, OpenCode, Antigravity and fx ([FAQ](https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md)). Pi is off by default and is enabled in T3 Settings.
- T3 runs the user's own `pi` install, so Pi's models, authentication, extensions, skills and context files carry over. It needs Pi 0.80.5 or newer; HolyAgent pins 1.5.0 ([installation.md](installation.md#the-pin)), which satisfies the floor.
- The protocol is `pi --mode rpc` over stdio JSONL. T3 rejects launch args that change the mode or pick a session. Pi's own [RPC](https://pi.dev/docs/latest/rpc) and [extension UI](https://pi.dev/docs/latest/rpc-extension-ui) docs describe the same protocol.
- T3 injects its own MCP bridge extension into Pi, started as `pi --mode rpc --extension <t3 mcp extension>` with `T3_MCP_URL` and `T3_MCP_BEARER_TOKEN`; it routes calls to `http://127.0.0.1:<port>/mcp` with a per-session credential ([orchestrator-mcp-server.md](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md), "Pi V2"). Pi does not need `builtin:mcp` to reach these tools. Pi's own project MCP servers are separate, and untrusted folders skip them; T3's `mcp.json` entries override Pi's native MCP registrations (research of 2026-11-07, from T3's docs).
- Pi keeps its own discovery: user extensions and skills load from `~/.pi` (or `PI_CODING_AGENT_DIR`), and project `.pi/` extensions, skills and MCP load only after the folder is trusted ([configuration.md](configuration.md#project-trust)). A Pi instance in T3 can set the binary path, environment variables and launch args.

**What HolyAgent does under RPC mode.** Its extension sees `ctx.mode` as `"rpc"` and `ctx.hasUI` as true, and sets no launch args for mode or session. It already has to work in RPC mode for its own children ([extensions.md](extensions.md#the-holyagent-package)).

## Dialogs and status only

The maintainer's words: "I want tthem to run with t3code's dialogs/ui, no weird tui stuff". Decided: under T3, every HolyAgent interaction uses only the RPC extension UI that T3 renders, which is:

| Pi call                                | Where T3 shows it | Source                                                                      |
| -------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| `select`, `confirm`, `input`, `editor` | T3's composer     | [rpc-extension-ui](https://pi.dev/docs/latest/rpc-extension-ui), T3 Pi page |
| `notify`                               | The work log      | same                                                                        |
| `setStatus`                            | Near the composer | same                                                                        |

HolyAgent never calls `custom()`, widgets, footer, titles or theme methods. `setWidget` and titles have no T3 equivalent, and `custom()` returns `undefined` in RPC mode.

- **Ask-user and todo follow the rule.** Inference: an rpiv tool that depends on `custom()` TUI rendering is dead under T3 unless it falls back to the dialog methods. Whether `@juicesharp/rpiv-ask-user-question` and `@juicesharp/rpiv-todo` use `custom()` is to be verified ([extensions.md](extensions.md#tool-surface-for-030)). Where one does, HolyAgent supplies an adapter that renders through the dialogs and status above and leaves the package unchanged.
- **Consequence for progress and notices.** Since widgets are not used, anything HolyAgent shows the user under T3 goes through `notify` or `setStatus`.

## Full access is required

The maintainer's words: "Require Full access". HolyAgent threads in T3 run in T3's Full access mode, consistent with full access as the default ([auto-mode.md](auto-mode.md)).

- **How T3 applies modes (sourced):** Supervised, Auto-accept edits and Full access are applied through Pi's blocking tool hook; extension tools prompt in Supervised and Auto-accept edits; changing the mode restarts the Pi session and resumes it; there is no "Auto" mode for Pi.
- **Why not the other modes (inference):** HolyAgent's extension tools and codemode would prompt on every call, and background specialists' tool calls could stall waiting on a human.
- **What HolyAgent does:** the docs and the setup check state the requirement, and HolyAgent warns when a T3 session runs in Supervised or Auto-accept edits. How a session learns T3's mode is not stated by the sources and is to be settled when the warning is built.

## Specialists and completion notices

The maintainer's words: "pi's stuff". Specialists and workflows run through `@tintinweb/pi-subagents` ([orchestration.md](orchestration.md#decision-for-030)), and its own new-turn trigger reports each completion to the root. T3's `delegate_task` is not used, and the tool is deactivated ([next section](#t3s-tools-kept-and-deactivated)).

- **Why it needs a check (inference):** T3 treats a turn as done on Pi's `agent_settled`, so a completion notice from detached work that arrives afterwards may not appear as a turn. T3 does handle detached compaction at settlement. This needs a real test.
- **The test:** a recorded fixture of T3's RPC traffic verifies that a completion notice arriving after `agent_settled` starts a new root turn in T3 ([Tests](#tests)). What HolyAgent does if the fixture shows otherwise is not decided.
- **What T3 would give instead (sourced):** `delegate_task` creates T3 child threads, which are durable, while Pi's example `subagent` extension shows as progress cards only and its children cannot be resumed. Inference: HolyAgent's specialists would appear like those cards if they work like that extension. Choosing `delegate_task` would couple HolyAgent to T3, which the maintainer did not choose.

## T3's tools: kept and deactivated

T3's bridge registers its tools under the prefix `mcp__t3-code__`; on current Pi it also registers hidden `mcp__t3_code__` aliases that the model cannot call. The names come from T3's orchestrator doc, PR #7211 and the bridge source ([mcpExtensionSource.ts](https://git.cafe/pingdotgg/t3code/blob/c273a8f6fa921f02e7f2fc2d055aa6891cfe04f9/packages/provider-pi/src/server/mcpExtensionSource.ts), third-party mirror); a third-party adapter, `pi-pstack-adapter` 0.7.0, uses the same `mcp__t3-code__delegate_task`.

| Tool                                                                                                                                                                                                                                                 | Decision   | Why                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `html_render`, `html_preview`                                                                                                                                                                                                                        | Keep       | HolyAgent's visual route for the root ([html-renders](https://github.com/pingdotgg/t3code/blob/main/docs/user/html-renders.md))                                          |
| `preview_*`, the integrated browser, and `t3_preview_*` (`t3_preview_list`, `t3_preview_close`)                                                                                                                                                      | Keep       | The visual specialists' browser ([Browser](#browser))                                                                                                                    |
| `device_*` (`device_list`, `device_open`, `device_screenshot`, `device_close`)                                                                                                                                                                       | Keep       | HolyAgent's device access for simulators and emulators ([Devices](#devices))                                                                                             |
| `orchestrator_capabilities`, `delegate_task`, `task_status`, `task_cancel`                                                                                                                                                                           | Deactivate | They duplicate `@tintinweb/pi-subagents`                                                                                                                                 |
| `create_threads`, `t3_thread_launch`, `t3_thread_list`, `t3_thread_read`, `t3_thread_update`, `t3_thread_send`, `t3_thread_wait`, `t3_thread_interrupt` (the `t3_thread_*` family), `schedule_task`, `list_scheduled_tasks`, `delete_scheduled_task` | Deactivate | They are outside HolyAgent's flow; T3's scheduled tasks stay usable from T3's UI, which needs no agent tool                                                              |
| `t3_pending_request`                                                                                                                                                                                                                                 | Deactivate | It reads and answers a child thread's questions, so with delegation off it is unneeded (inference); the research marked this one to verify                               |
| Any other `mcp__t3-code__` tool outside the kept families (the research also saw `t3_thread_search` and PR watch and worktree tools in [PR #15219](https://github.com/pingdotgg/t3code/pull/15219), third-party mirror)                              | Deactivate | Same rule: HolyAgent keeps the families above and removes the rest. The doc names `OrchestratorToolkit` as the authoritative list, and the research read it only in part |

**Mechanism.** Pi's `pi.getAllTools()`, `pi.getActiveTools()` and `pi.setActiveTools(names)` work on any tool, including ones another extension registered; `setActiveTools` ignores unknown and `hidden` tools, and Pi has no `unregisterTool` ([extensions](https://pi.dev/docs/latest/extensions)). Decided: a HolyAgent extension calls `pi.setActiveTools` with the active set filtered by prefix from `getAllTools()`, so only the kept T3 families (`html_render`, `html_preview`, `preview_*`, `t3_preview_*` and `device_*`) stay.

- It applies once at `session_start`, before the first request, and reapplies on `before_agent_start` and `session_tree`. Pi's own example [tools.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tools.ts) reapplies on `session_tree` too. Inference: T3's bridge calls `getActiveTools` and probably `setActiveTools` itself when its exposure changes and after tree restores, so it may re-add tools after HolyAgent's call; filtering by prefix each time is the mitigation.
- A `tool_call` handler blocks a call to any deactivated `mcp__t3-code__` tool as a backstop, because hiding a tool is not an execution policy (third-party source).
- **There is no T3 setting for this.** The research found none for Pi: issue [#4150](https://github.com/pingdotgg/t3code/issues/4150) asks for a browser-MCP toggle and says none exists, and its workarounds are for Codex and Claude only. A Pi launch-arg route (`--tools` as a strict allowlist, per a third-party source) would drop Pi's own tools too and was not verified.
- **Resume and restart.** A restart reloads extensions and fires `session_start` with a reason (startup, resume or fork), so the filter runs again. The research found no persistence of the active tools across restarts.
- **Residue (to verify):** disabled tools may still leave a small orchestration-instructions residue in T3's first-turn prompt.

**Prompt caching.** The active tool set is fixed at `session_start` and not toggled mid-session, so the cached prefix holds. Pi's docs say a change of the active tools updates the prompt contributions and the provider tools; models without mid-conversation system messages take a cache miss per change ([caching-and-subagents.md](caching-and-subagents.md#cache-target)). Inference: a reapplication that finds the set already right changes nothing.

## Browser

The visual roles use T3's integrated browser. The toolkit has these twelve tools (source: a mirror of [`toolkits/preview/tools.ts`](https://git.kaki87.net/VibedByKaKi/t3-code-android-nightly/src/branch/main/apps/server/src/mcp/toolkits/preview/tools.ts), third-party; DeepWiki, third-party; [discussion #24799](https://github.com/pingdotgg/t3code/discussions/24799)); upstream `main` was not read directly:

- `preview_status`, `preview_open`, `preview_dialog`, `preview_navigate`, `preview_resize`, `preview_set_appearance`;
- `preview_snapshot` (accessibility tree, console, network and a screenshot);
- `preview_act` (click, type, hover, select, drag, upload, press, scroll);
- `preview_evaluate`, `preview_wait_for`, `preview_recording_start`, `preview_recording_stop`.

Console and network output arrive through snapshot diagnostics; dedicated `preview_console` and `preview_network` tools are only a proposal in the discussion. The same discussion names `t3_preview_list` and `t3_preview_close`, which are kept with the rest of the `t3_preview_*` family. The bridge is always on for Pi and T3 has no toggle for it ([issue #4150](https://github.com/pingdotgg/t3code/issues/4150)).

Decided: the fixed tool set pins these names (with `html_render`, `html_preview`, `t3_preview_list` and `t3_preview_close`), because on Pi 0.99 and newer only `orchestrator_capabilities`, `delegate_task` and `task_status` are exposed directly and every other T3 tool, `preview_*` included, is `deferred` behind Pi's `tool_search`. The alternative the research offered, keeping `tool_search` active, is not taken. Inference: pinning by name activates the deferred tools at session start; whether a deferred tool stays discoverable once it is excluded is to be verified.

## Computer use through Cua Driver

T3 serves no OS-level desktop control of its own. Codex threads get Codex's computer use, Claude threads get none, and the Pi adapter is not mentioned ([issue #31437](https://github.com/pingdotgg/t3code/issues/31437)); a proposal for a T3-mediated desktop toolkit on Linux ([#32088](https://github.com/pingdotgg/t3code/issues/32088), quoted in #31437 by a third-party comment) is unshipped as far as the research found. So HolyAgent adds computer use itself.

The maintainer's words: "cua driver". Decided, from the research ([trycua/cua](https://github.com/trycua/cua)):

- **What it is.** Cua Driver (`trycua/cua`, `libs/cua-driver`) is a background computer-use driver. It reads the accessibility tree and sends input to windows without moving the user's pointer or taking focus. It is MIT-licensed (the optional `cua-perception` extension is AGPL-3.0-only and is not needed). It runs on macOS 14 or newer, Windows 10 and 11, and x86_64 Linux on X11 or XWayland with AT-SPI 2 (Linux is described as preview builds, [quickstart](https://cua.ai/docs/cua-driver/quickstart)). It controls the host desktop, not a VM. The research identified it from the two words "cua driver"; the decision confirms it.
- **How HolyAgent connects it.** Through the existing Pi extension [`@amaster.ai/pi-computer-use`](https://pi.dev/packages/@amaster.ai/pi-computer-use) (third-party; 0.1.36, Apache-2.0, published 2026-11-05 when read), pinned and moved only through `mise run deps:update` ([installation.md](installation.md#the-pin)). The driver is the copy the extension bundles: there is no separate driver install, and the bundled version moves with the extension pin. The research read it as exposing about 62 `computer_use_*` tools with a core profile by default. Cua's docs list Pi as a client that uses one-shot `cua-driver call` commands, without MCP ([connect your agent](https://cua.ai/docs/cua-driver/guides/connect-your-agent)); whether Pi accepts an MCP entry natively is unverified, and HolyAgent does not rely on it.
- **Permission mode and prompts.** The driver runs in `standard` mode, its default, which allows input to every app; the mode is fixed at launch ([operate](https://cua.ai/docs/cua-driver/guides/operate)). The extension's confirmations (it asks on app launch and dangerous actions, per the research) are off, in the maintainer's words "Full access, no prompts".
- **Who gets it.** Only Worker.visual and Reviewer.visual receive the computer-use tools, pinned by name in their fixed tool set like the browser tools. Everyone else gets none.
- **Setup.** There is no driver to install, because the extension carries it. `holyagent setup` for Pi walks through the macOS permissions only: Accessibility and Screen Recording, which the bundled driver needs to read the screen and send input ([quickstart](https://cua.ai/docs/cua-driver/quickstart)).
- **The browser stays on T3's `preview_*` tools.** Computer use is for what the browser cannot reach, such as native and desktop apps.

**Security.** Inference: under T3's Full access, a Pi agent with these tools can operate any app of the user's, including a signed-in mail client, and the screenshots enter the model's context. Only the two visual roles have the tools, and the research found no dedicated Cua security page. A user who does not want this leaves the extension off in `config.json` ([configuration.md](configuration.md#holyagent-configjson)).

The research read the extension as bundling Cua Driver 0.37.0 through npm while the latest standalone driver release was 0.41.3 (2026-11-07); the decision is to run the bundled copy, so the driver version follows the extension pin and lags Cua's releases until the pin moves.

To verify: how the extension's confirmations are turned off; the Linux preview quality; and whether the prompts of the extension, if left on, would route through T3's dialogs.

## Devices

T3's device tools (`device_list`, `device_open`, `device_screenshot`, `device_close`; taps and typing go through the `agent-device` CLI) cover iOS simulators and Android emulators. They need macOS with Xcode for iOS or the Android SDK. They are enabled in T3 under Settings, Integrations, Devices, "Agent device access", and the session is restarted afterwards ([devices.md](https://git.cafe/pingdotgg/t3code/blob/d06f0ff1048d42a156824765316c5a2dc54f5bca/docs/user/devices.md), third-party mirror).

Decided (the root's default from the maintainer's "enable anything beneficial"): device access is enabled where the host supports it. The research found no documented way for a Pi session to reach `device_*`; the orchestrator doc lists only the `preview` and `orchestration` credential capabilities. Whether Pi reaches it, and so whether the visual roles can use it, is verified during implementation. The `device_*` tools are kept by the deactivation rule above. If Pi reaches them, the fixed set pins them for the visual roles, which the implementation settles.

## T3 settings written by setup

The maintainer's words: "Setup writes them". Once the implementation has verified the format of T3's `settings.json` under `T3CODE_HOME` (default `~/.t3`; `--base-dir` also sets it), `holyagent setup` for Pi writes the beneficial T3 settings globally or as per-project overrides, with an undo. They are: the Pi provider enabled, worktrees and device access; the context meter is left as the user has it. The settings follow `.holyagent/config.json` ([configuration.md](configuration.md#keys-and-defaults)): with `pi.enable` false setup leaves T3's Pi provider alone, with it true (the default) setup always enables the provider, and `pi.t3.worktrees` and `pi.t3.deviceAccess` (both default true) are the options the setup TUI preselects. When the format is unverified or unsupported, setup prints the T3 Settings steps instead.

What is known ([project-settings](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md); the `useSettings.ts` source, read through a third-party mirror): server-side settings apply to all environments or to one, with per-project overrides, and a provider can be switched on or off per project; appearance, confirmations and browser profiles are per device. Server settings persist in `settings.json` under `T3CODE_HOME`. `~/.t3/service.env` takes `T3CODE_*` variables for the background service. Not known: whether hand-editing `settings.json` is supported, and the key names for the browser and device settings.

The fallback UI steps, from the research: enable Pi in Settings; turn on worktrees under Settings, Worktrees (with a per-project override if wanted); enable device access under Settings, Integrations, Devices.

## Relied on as they are

| T3 feature                            | Pi gets it  | Basis                                                                                                                                  |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Model and effort pickers              | Yes         | Per thread (T3 docs)                                                                                                                   |
| Checkpoints and rollback              | Yes         | Native Pi session files; forks and provider switches use T3 handoff summaries; `/compact` works                                        |
| Skills menu (`$`)                     | Yes         | Pi skills, user and project                                                                                                            |
| Worktrees, terminal, diff and PR flow | Yes         | Inference: UI-side and provider-agnostic                                                                                               |
| Context meter                         | Yes         | Reads Pi's usage and context window; inference that it works while Billion Context leaves Pi's usage reporting unchanged, not verified |
| Scheduled tasks and webhooks          | UI only     | They run from T3's own scheduler (inference) and need no agent tool, so the agent tools stay deactivated                               |
| Permission mode                       | Full access | [Full access is required](#full-access-is-required)                                                                                    |
| T3's "Auto-compact after" setting     | Not for Pi  | Documented only for Claude; Pi's own `/compact` and compaction apply                                                                   |
| MCP server management in T3           | Unknown     | HolyAgent uses Pi's own MCP configuration                                                                                              |

## To verify

Each point is settled during implementation and recorded here when it is:

- The T3 release that contains PR #7211.
- The exact `preview_*` set on upstream `main` against the mirror.
- The tool names Pi sees after T3's namespacing.
- Whether T3's bridge re-adds tools after HolyAgent filters them, and whether a deferred tool stays discoverable through `tool_search` once excluded.
- Pi 1.5.0 against T3's `agent_settled` and `clear_queue` assumptions. T3's adapter mentions Pi 0.84.4, 0.85.1 and 0.86 behaviors; the research did not check 1.x.
- Whether the rpiv packages use `custom()`, and whether a `custom()`-based extension fails cleanly under RPC.
- Whether a completion notice after `agent_settled` starts a new root turn in T3.
- How a HolyAgent session detects T3's permission mode.
- Whether Pi reaches `device_*`, which is kept either way.
- Whether `settings.json` can be hand-edited, and its key names.
- How the extension's confirmations are turned off.
- Whether T3's context meter holds with Billion Context.
- That the T3 documents, which the research read in part, match the release in use.

## Tests

CI covers T3 with recorded fixtures of `pi --mode rpc` traffic inside the existing `check` and `windows` jobs, as the other Pi tests do ([orchestration.md](orchestration.md#ci-and-windows)); no job is added or renamed. The fixtures are re-recorded when `mise run deps:update` moves Pi. They cover:

- the dialogs, `notify` and `setStatus` HolyAgent sends, and that no `custom()` call is made;
- the active tool set after `session_start`, `before_agent_start` and `session_tree`, and the `tool_call` block on a deactivated T3 tool;
- a completion notice after `agent_settled` starting a new root turn;
- the warning in Supervised and Auto-accept edits.

## Sources

- T3 Code: [repository](https://github.com/pingdotgg/t3code), [Pi provider page](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-pi.md), [FAQ](https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md), [ACP providers](https://github.com/pingdotgg/t3code/blob/main/docs/user/providers-acp.md), [orchestrator MCP server](https://github.com/pingdotgg/t3code/blob/main/docs/orchestration-v2/orchestrator-mcp-server.md), [HTML renders](https://github.com/pingdotgg/t3code/blob/main/docs/user/html-renders.md), [project settings](https://github.com/pingdotgg/t3code/blob/main/docs/user/project-settings.md), [PR #7211](https://github.com/pingdotgg/t3code/pull/7211), [issue #4150](https://github.com/pingdotgg/t3code/issues/4150), [issue #31437](https://github.com/pingdotgg/t3code/issues/31437), [discussion #24799](https://github.com/pingdotgg/t3code/discussions/24799).
- Pi: [RPC](https://pi.dev/docs/latest/rpc), [RPC extension UI](https://pi.dev/docs/latest/rpc-extension-ui), [extensions](https://pi.dev/docs/latest/extensions), [packages](https://pi.dev/docs/latest/packages), [settings](https://pi.dev/docs/latest/settings), [security](https://pi.dev/docs/latest/security), [example tools.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/tools.ts).
- Cua: [trycua/cua](https://github.com/trycua/cua), [releases](https://github.com/trycua/cua/releases), [quickstart](https://cua.ai/docs/cua-driver/quickstart), [connect your agent](https://cua.ai/docs/cua-driver/guides/connect-your-agent), [operate](https://cua.ai/docs/cua-driver/guides/operate).
- Third-party: mirrors of T3 source ([bridge](https://git.cafe/pingdotgg/t3code/blob/c273a8f6fa921f02e7f2fc2d055aa6891cfe04f9/packages/provider-pi/src/server/mcpExtensionSource.ts), [html toolkit](https://git.cafe/pingdotgg/t3code/blob/e2875821820e34047bc70bc786b8b39ef3fc35eb/apps/server/src/mcp/toolkits/html/tools.ts), [preview toolkit](https://git.kaki87.net/VibedByKaKi/t3-code-android-nightly/src/branch/main/apps/server/src/mcp/toolkits/preview/tools.ts), [devices.md](https://git.cafe/pingdotgg/t3code/blob/d06f0ff1048d42a156824765316c5a2dc54f5bca/docs/user/devices.md)); [DeepWiki on MCP and preview automation](https://deepwiki.com/pingdotgg/t3code/5.9-mcp-and-preview-automation); [flaviocopes.com on T3 Code](https://flaviocopes.com/t3-code/); [`@amaster.ai/pi-computer-use`](https://pi.dev/packages/@amaster.ai/pi-computer-use); `pi-pstack-adapter` 0.7.0, `pi-lazy-tools` and `pi-capability-index` package pages.
