# Codex startup preview

HolyAgent can prepare a dedicated native Codex profile and install the HolyAgent plugin through Codex's marketplace commands. Setup does not change a running session or configure credentials, sandboxing or approvals. The T3 Code workflow with Pi remains the supported public workflow while hosted Codex startup is being verified.

Use a Codex CLI on the verified 0.172.0 line. Run these commands from the installed HolyAgent package, or select Codex in the interactive setup and review the plan.

```sh
profile="$HOME/.holyagent/codex"
holyagent setup codex --codex-home "$profile" --dry-run
holyagent setup codex --codex-home "$profile"
CODEX_HOME="$profile" codex features list
```

Pass an absolute directory, or omit `--codex-home` to use the `codex` directory under `HOLYAGENT_HOME` or `~/.holyagent`. Start Codex with `CODEX_HOME` set **before launch**. The new profile selects GPT-6.2 Sol, supplies a short native startup note and enables the Default-mode question feature. The plugin provides the detailed workflow skill. Setup can adopt an earlier staged profile with the same delegation settings. It keeps unrelated settings, refuses conflicting or modified files, and does not enable a plugin you disabled. Use another profile to change delegation modes.

The default profile disables native agents at the common entry point, including delegation from the root. Disabling only the V2 feature is not sufficient because Codex can select V2 from model metadata.

To test adaptive root-only delegation, download the [unmodified Codex 0.172.0 model catalog](https://raw.githubusercontent.com/openai/codex/rust-v0.172.0/codex-rs/models-manager/models.json). On a fresh profile, pass its absolute path to setup as `--root-only-catalog /absolute/models.json`. Setup checks the catalog fingerprint, selects native V1 with maximum depth one, and keeps the V2 tools unavailable. The root can work directly or delegate, while its specialists cannot delegate again.

The optional profile pins the model catalog. It is not a replacement for the hosted catalog. Verify the effective configuration layer in the launched process before enabling native delegation on a host. If the launcher does not select the profile or later overrides change the mode, do not enable delegation there.
