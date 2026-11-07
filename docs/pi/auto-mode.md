# Auto-mode: dropped for 0.3.0

**Status: decided for 0.3.0; the Pi integration it describes is not shipped yet.**

HolyAgent will have no auto-mode on Pi in 0.3.0, and full access is the default. The maintainer's words: "there will be no auto-mode, full access shall be the default".

The 0.3.0 Intent that would have added an optional gate (a `tool_call` handler that has a model review risky operations) was closed for this reason. None of the eleven open Intents loads a gate.

## What full access means

- A Pi session and the specialists the root launches run with the permissions of the account that started them, as Pi does by default ([approval.md](approval.md#pi-deliberately-has-no-native-approval-mechanism)).
- No gate extension and no approval reviewer is loaded. Nothing in the HolyAgent package registers a `tool_call` handler that asks or reviews. Under T3 Code its one blocking handler is a backstop that refuses a call to a deactivated T3 tool, which is not an approval ([t3-code.md](t3-code.md#t3s-tools-kept-and-deactivated)).
- Under T3 Code, HolyAgent threads must run in T3's Full access mode, the same full access. In T3's Supervised and Auto-accept edits modes every extension tool call prompts and background specialists could stall, so the docs and the setup check require Full access and HolyAgent warns otherwise ([t3-code.md](t3-code.md#full-access-is-required)).
- The computer-use extension's own confirmations are off, so no step of a visual Assignment asks the user either ([t3-code.md](t3-code.md#computer-use-through-cua-driver)).
- No workflow script asks for confirmation, whatever agents it calls. This is the maintainer's decision, consistent with full access as the default ([claude-parity.md](claude-parity.md#5-workflows)).
- Project trust is inherited: every specialist the root launches is started with `--approve` when the root's session trusted the project, so a project's `.pi/` resources load without a prompt that print, JSON and RPC modes cannot show ([configuration.md](configuration.md#project-trust), [installation.md](installation.md#global-and-project-local-installs)).
- The version-control and state boundary stays instruction text, as on Claude: the root owns the branch, the PR and `.holyagent/` state, and specialists leave those writes to it ([claude-parity.md](claude-parity.md#1-rules-that-cut-across-the-rest)).
- Pi's own safety advice is isolation (a container or a micro-VM), not approval prompts. A user who wants a barrier runs Pi inside one ([approval.md](approval.md#pi-deliberately-has-no-native-approval-mechanism)).

## What this removes from the plan

The earlier research mapped seven requirements for a gate. With the decision, these are not planned:

- a reviewer model for risky operations, including the rule "GPT-6 Luna when the Codex provider is active, else an economical available model";
- a launch flag with values `off` and `on` for the gate, and the audit entries it would have recorded;
- the fail-closed handling of reviewer errors and timeouts, and the rule that an undecided call falls back to a confirmation dialog;
- the open questions that came with it: which provider counts as "Codex active", whether the legacy `openai-codex` backend is acceptable, and whether reviewer cost belongs to the Assignment.

The Kimi route table has no reviewer row, and [providers.md](providers.md) no longer needs the Codex and ChatGPT provider research. The detailed requirement map is in the repository history of this page.

## If a gate is wanted later

It would be a new Intent with its own decision, not part of 0.3.0. What Pi offers an extension for that purpose, and what it does not, is in [approval.md](approval.md).
