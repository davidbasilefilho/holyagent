# Codex startup preview

HolyAgent can prepare a dedicated native Codex profile and install the HolyAgent plugin through Codex's marketplace commands. Setup does not change a running session or configure credentials, sandboxing or approvals. The T3 Code workflow with Pi remains the supported public workflow while hosted Codex startup is being verified.

Apply verifies that the installed Codex CLI offers the native marketplace and plugin commands used by setup. A compatible CLI stays in place, independent of its version. If it is absent or incompatible, setup explains the missing capability. To install or update Codex yourself, run `npm install -g @openai/codex@latest` and rerun setup. Preview does not require Codex.

In a terminal with a detected ChatGPT desktop installation, setup offers the [native browser options](../../../docs/setup-surfaces.md). Run the installed HolyAgent package or select Codex in the interactive setup and review the plan. Use `--non-interactive` or `--form headless` for line-based setup.

```sh
profile="$HOME/.holyagent/codex"
holyagent setup codex --codex-home "$profile" --dry-run
holyagent setup codex --codex-home "$profile"
CODEX_HOME="$profile" codex features list
```

Pass an absolute directory, or omit `--codex-home` to use the `codex` directory under `HOLYAGENT_HOME` or `~/.holyagent`. Start Codex with `CODEX_HOME` set **before launch**. The new profile selects GPT-6.2 Sol, supplies a short native startup note and enables the Default-mode question and experimental context-management flags. The plugin provides the detailed workflow skill. Codex still decides whether experimental context management is available for the model and account.

Setup can adopt an earlier staged profile with the same delegation settings. It recognizes equivalent local marketplace paths, including the extended Windows path Codex writes. When a marketplace points to another location, setup can relink it only if the previous HolyAgent marketplace still has its unchanged receipt-backed files. Otherwise it leaves the entry alone. Setup preserves unrelated settings and plugin opt-outs. Use another profile to change delegation modes.

The default profile disables native agents at the common entry point, including delegation from the root. Disabling only the V2 feature is not sufficient because Codex can select V2 from model metadata.

To test adaptive root-only delegation, download the [unmodified Codex 0.172.0 model catalog](https://raw.githubusercontent.com/openai/codex/rust-v0.172.0/codex-rs/models-manager/models.json). On a fresh profile, pass its absolute path to setup as `--root-only-catalog /absolute/models.json`. Setup checks the catalog fingerprint, selects native V1 with maximum depth one, and keeps the V2 tools unavailable. The root can work directly or delegate, while its specialists cannot delegate again.

The optional profile pins the model catalog, not the installed CLI version. The setup command checks the plugin API, which does not prove support for root-only delegation. Verify the effective policy in the launched process on your exact CLI build before enabling native delegation on a host. Use the default direct-only setup if the launcher cannot select the profile or the policy cannot be verified.

## Select the profile in T3 Code

For a native Codex test, add a separate Codex provider instance under **Settings → Providers**. Set **CODEX_HOME path** to the profile directory and leave **Shadow home path** empty. T3 Code sets this path before spawning Codex. This is not the Pi provider or its OpenAI Codex model adapter. Follow [T3 Code's Codex provider guide](https://github.com/pingdotgg/t3code/blob/v0.1.12/docs/user/providers-codex.md#manage-multiple-codex-accounts) for account setup. A separate profile may need its own sign-in, and threads from another profile cannot continue there. Profile selection is documented upstream. The actual first turn and effective tool policy on this surface still need verification.
