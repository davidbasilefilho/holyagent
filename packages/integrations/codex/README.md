# Codex startup preview

HolyAgent can prepare a dedicated native Codex profile and install the HolyAgent plugin through Codex's marketplace commands. Setup does not change a running session or configure credentials, sandboxing or approvals. The T3 Code workflow with Pi remains the supported public workflow while hosted Codex startup is being verified.

Use a Codex CLI on the verified 0.172.0 line. Run these commands from the installed HolyAgent package, or select Codex in the interactive setup and review the plan.

```sh
profile="$HOME/.holyagent/codex"
holyagent setup codex --codex-home "$profile" --dry-run
holyagent setup codex --codex-home "$profile"
CODEX_HOME="$profile" codex features list
```

Pass an absolute directory, or omit `--codex-home` to use the `codex` directory under `HOLYAGENT_HOME` or `~/.holyagent`. Start Codex with `CODEX_HOME` set **before launch**. The new profile selects GPT-6.2 Sol, supplies a short native startup note and enables the Default-mode question and experimental context-management flags. The plugin provides the detailed workflow skill. Codex still decides whether experimental context management is available for the model and account.

Setup can adopt an earlier staged profile with the same delegation settings. It keeps unrelated settings and feature choices, refuses conflicting or modified files, and does not enable a plugin you disabled. Use another profile to change delegation modes.

The default profile disables native agents at the common entry point, including delegation from the root. Disabling only the V2 feature is not sufficient because Codex can select V2 from model metadata.

To test adaptive root-only delegation, download the [unmodified Codex 0.172.0 model catalog](https://raw.githubusercontent.com/openai/codex/rust-v0.172.0/codex-rs/models-manager/models.json). On a fresh profile, pass its absolute path to setup as `--root-only-catalog /absolute/models.json`. Setup checks the catalog fingerprint, selects native V1 with maximum depth one, and keeps the V2 tools unavailable. The root can work directly or delegate, while its specialists cannot delegate again.

The optional profile pins the model catalog. It is not a replacement for the hosted catalog. Verify the effective configuration layer in the launched process before enabling native delegation on a host. If the launcher does not select the profile or later overrides change the mode, do not enable delegation there.

## Select the profile in T3 Code

For a native Codex test, add a separate Codex provider instance under **Settings → Providers**. Set **CODEX_HOME path** to the profile directory and leave **Shadow home path** empty. T3 Code sets this path before spawning Codex. This is not the Pi provider or its OpenAI Codex model adapter. Follow [T3 Code's Codex provider guide](https://github.com/pingdotgg/t3code/blob/v0.1.12/docs/user/providers-codex.md#manage-multiple-codex-accounts) for account setup. A separate profile may need its own sign-in, and threads from another profile cannot continue there. Profile selection is documented upstream. The actual first turn and effective tool policy on this surface still need verification.
