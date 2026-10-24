# Pi coding agent: research notes for the HolyAgent Pi integration

These notes are the foundation for a later HolyAgent integration with the Pi coding agent harness. They are based on Pi's official docs and source code only. Nothing was installed and no Pi code was written.

## Summary

Pi is a minimal terminal coding harness. It gives the model four tools by default (`read`, `bash`, `edit`, `write`), and it is customised through TypeScript extensions, skills, prompt templates, themes and installable packages ([README](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/README.md), [index.md L1-L8](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/index.md#L1-L8), [settings.md L42](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#L42)). It runs interactively, in print mode, as a JSONL event stream, as an RPC child process, or embedded through a TypeScript SDK ([cli-integration.md L9-L18](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/cli-integration.md#L9-L18)). It deliberately has no built-in permission system and no sandbox: tools run with the OS permissions of the Pi process, and approval is something an extension builds on the `tool_call` event ([security.md L3](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/security.md#L3), [README L88-L90](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/README.md#L88-L90)). Sub-agents and plan mode are not built in either; a sub-agent example spawns separate `pi` processes ([subagent/index.ts L298](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/examples/extensions/subagent/index.ts#L298)). The nearest analogue of Claude Code dynamic workflows is the built-in `codemode` tool, a QuickJS sandbox in which the model writes JavaScript that calls other tools ([codemode.md L1-L8](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/codemode.md#L1-L8)). Pi has been moving quickly (see "Version risk" below), so HolyAgent should pin an exact Pi version.

## Which project "Pi" is

Pi is Mario Zechner's coding agent, now maintained under the Earendil Works organisation. The brief's guess (`badlogic/pi-mono`, `@mariozechner/pi-coding-agent`) is the old name of the same project:

- Official site and docs: [pi.dev](https://pi.dev) and [pi.dev/docs/latest](https://pi.dev/docs/latest). The root README links both ([README](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/README.md)).
- Official repository: [github.com/earendil-works/pi](https://github.com/earendil-works/pi). The old `badlogic/pi-mono` raw URL serves a `packages/coding-agent/package.json` that is already named `@earendil-works/pi-coding-agent` ([raw file via the old URL](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/package.json)).
- Current npm package: `@earendil-works/pi-coding-agent`, latest `1.4.0` published 2026-10-21 (npm registry time; the changelog heading agrees: [CHANGELOG.md L3](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/CHANGELOG.md#L3)), author "Mario Zechner", MIT, repository `earendil-works/pi` ([npm registry metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent)).
- Legacy npm package: `@mariozechner/pi-coding-agent` stopped at `0.73.1` and is deprecated with the message "please use @earendil-works/pi-coding-agent instead going forward" ([npm registry metadata](https://registry.npmjs.org/@mariozechner/pi-coding-agent)). The `v0.73.1` git tag is commit `781152fc24841dc54b22284514604048ebe5e2c9` ([ref list](https://github.com/earendil-works/pi.git/info/refs?service=git-upload-pack)). Do not rely on old docs: they differ materially (for example the 0.73.1 README says "No MCP." and "No permission popups." in its philosophy section, [0.73.1 README L470-L474](https://github.com/earendil-works/pi/blob/781152fc24841dc54b22284514604048ebe5e2c9/packages/coding-agent/README.md#L470-L474), whereas built-in MCP and codemode arrived in 0.99.0, see [CHANGELOG.md L440](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/CHANGELOG.md#L440)).
- pi.dev reports the same latest version: [pi.dev/api/latest-version](https://pi.dev/api/latest-version) returned `{"ok":true,"version":"1.4.0","packageName":"@earendil-works/pi-coding-agent"}`.

## What was read

| Item                               | Value                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Release read                       | `@earendil-works/pi-coding-agent` **1.4.0** (2026-10-21)                                                                                                                        |
| Git tag / commit                   | `v1.4.0` = `4a080252f06caf63a525d7873c5d94d3c23887e0` (same commit as branch `stable`) ([ref list](https://github.com/earendil-works/pi.git/info/refs?service=git-upload-pack)) |
| `main` at read time                | `d0aa218cb16c333c008f6aa3dcd670ac8b68383c` (newer, not read)                                                                                                                    |
| Permalink base used in these notes | `https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/`                                                                                           |
| Model catalog read                 | the copy shipped in [`@earendil-works/pi-ai@1.4.0`](https://unpkg.com/@earendil-works/pi-ai@1.4.0/dist/providers/data/openai-codex.json) (see [providers.md](providers.md))     |

Method: `git clone` was blocked in the research sandbox, so files were fetched from `raw.githubusercontent.com` at the tag and from the published npm tarballs. Nine docs (`security`, `models`, `extensions`, `settings`, `quickstart`, `models-configuration`, `codemode`, `cli`, `providers`) were compared byte for byte between the tarball and the tag and were identical. Source files cited with line numbers were read at the tag.

### Version risk

Pi released 1.0.1 on 2026-10-03 and 1.4.0 on 2026-10-21, roughly weekly minor releases ([CHANGELOG.md L3, L280](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/CHANGELOG.md#L3), [npm registry metadata](https://registry.npmjs.org/@earendil-works/pi-coding-agent)). The 1.4.0 changelog alone adds codemode wiring fixes, a models-configuration reference and classifier image input ([CHANGELOG.md L3-L50](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/CHANGELOG.md#L3-L50)). Everything below is true for 1.4.0 only. The `pi-durable` package is marked experimental ([durable README](https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/durable/README.md)).

## Index

| File                                                 | Topic                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------ |
| [extensions.md](extensions.md)                       | Extension API, events/hooks, custom tools, commands, packages, loading   |
| [configuration.md](configuration.md)                 | Config files, locations, precedence, settings keys, project trust        |
| [providers.md](providers.md)                         | Providers and models, Codex/ChatGPT subscription providers, `gpt-6-luna` |
| [approval.md](approval.md)                           | No native approval; what extensions can intercept                        |
| [caching-and-subagents.md](caching-and-subagents.md) | Prompt caching per provider; sub-agent support and context reuse         |
| [installation.md](installation.md)                   | Installing Pi; Bun status                                                |
| [orchestration.md](orchestration.md)                 | A dynamic-workflow equivalent mapped to Intents and Assignments          |
| [auto-mode.md](auto-mode.md)                         | Requirements for a HolyAgent auto mode on Pi                             |

## Top findings and gaps

1. **`gpt-6-luna` exists, but in three different forms.** It is a chat model on `openai-codex` (ChatGPT subscription, legacy provider), a chat model on `openai` (API key or Sign in with ChatGPT), and a typed _classifier_ model on `openai` via the Decisions API that works only with `OPENAI_API_KEY`, not with ChatGPT sign-in. See [providers.md](providers.md).
2. **Pi has no native approval mechanism.** The only gate is an extension's `tool_call` handler returning `{ block: true }`, plus `ctx.ui.confirm/select` for asking a human. There is no "undecided, ask Pi" return value for tool calls (that exists only for project trust). See [approval.md](approval.md).
3. **Bun is not an officially documented install route.** Docs show the `pi.dev/install.sh` installer, `npm install -g --ignore-scripts`, and Nix. Source recognises Bun as an install method for self-update, and the SDK/RPC docs say Node.js or Bun hosts. The CLI shebang is `node`. See [installation.md](installation.md).
4. **There is no resumable workflow engine.** `codemode` runs model-written JS with no `agent()` primitive, no result schemas on agents, no cached resume, and at most two workers per process. A HolyAgent orchestrator must live in the host (SDK or RPC) with an extension for tools and gating. See [orchestration.md](orchestration.md).
5. **Prompt caching is mostly automatic and keyed by Pi's session id; the only retention switch is `PI_CACHE_RETENTION=long`.** Sub-agent context can be continued by reusing a session id; the shipped example does the opposite (`--no-session`). See [caching-and-subagents.md](caching-and-subagents.md).
