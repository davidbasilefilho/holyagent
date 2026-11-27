# Codex startup preview

HolyAgent can prepare a dedicated native Codex profile and install the HolyAgent plugin through Codex's marketplace commands. Setup does not change a running session or configure credentials, sandboxing or approvals. The T3 Code workflow with Pi remains the supported public workflow while hosted Codex startup is being verified.

Apply requires the installed Codex CLI to expose the native marketplace and plugin commands. A compatible CLI stays in place. If it is missing, install the official CLI with `npm install -g @openai/codex@latest` or another supported installer. If an existing CLI is incompatible, use its original installer and update only to a newer compatible stable release. Preview does not require Codex.

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

Ordinary setup checks the plugin API without pinning the installed CLI. Those checks cannot prove root-only delegation. The optional experimental mode still accepts only the runtime for which that policy has been verified (`0.172.0` stable) and the matching catalog. On another build, keep your installed CLI and use a direct-only profile. Verify the effective policy in the launched process before enabling adaptive mode on a host.

## Managed Codex Cloud

Export a skills-only plugin for the managed service. This is separate from preparing a local `CODEX_HOME`. Use an existing output directory and a new filename.

```sh
bunx holyagent@dev setup codex cloud --output ./holyagent-cloud.zip --dry-run
bunx holyagent@dev setup codex cloud --output ./holyagent-cloud.zip
```

Preview writes nothing. The export contains a portable `plugin.json` and the `holyagent-workflow` and `hillclimb-iteration` skills. It does not contain launcher code, local model profiles, roles, credentials or permission settings. No account or workspace settings change. The exporter cannot tell which plugins your Cloud account permits. [Plugin package format](https://developers.openai.com/plugins/build/plugins#plugin-structure)

If the plugin is not already available, the documented web ZIP upload is an admin action. An eligible workspace owner or admin can use **Admin Console → Plugins → Add → Upload plugin** when separately authorized. If the workspace offers limited access, choose only the approved people or groups. Do not switch to a workspace-wide install to get around a missing option. A local marketplace in Codex CLI or ChatGPT desktop is not proof that the plugin is available in Cloud. [Plugin availability and administration](https://help.openai.com/en/articles/20001256-plugins-in-chatgpt) · [GitHub marketplace import](https://help.openai.com/en/articles/20001504-importing-and-syncing-plugin-marketplaces-from-github)

If the approved plugin becomes available to your account, install it once using the supported Plugins interface. In a new authorized Codex Cloud task, open **Sources → Use plugins** if available, select HolyAgent, and launch. Confirm both skills in the task's native skill inventory or runtime trace before asking it to open any skill file. Record the task and the archive version. If the picker is missing, the plugin is absent, or the service does not expose an activation receipt, mark the test unverified. A local ZIP, local CLI install, or task that read `SKILL.md` from a checkout does not prove native activation.

If the workspace uses a custom Cloud environment, prepare and test its **Install script** and **Start skill** before publishing that environment and launching the task. Install scripts prepare dependencies, and Start skills guide service startup and readiness checks. Neither registers this plugin for a running task. [Cloud environment setup](https://learn.chatgpt.com/docs/environments/cloud-environments#customize-installation-and-startup)

## Select the profile in T3 Code

For a native Codex test, add a separate Codex provider instance under **Settings → Providers**. Set **CODEX_HOME path** to the profile directory and leave **Shadow home path** empty. T3 Code sets this path before spawning Codex. This is not the Pi provider or its OpenAI Codex model adapter. Follow [T3 Code's Codex provider guide](https://github.com/pingdotgg/t3code/blob/v0.1.12/docs/user/providers-codex.md#manage-multiple-codex-accounts) for account setup. A separate profile may need its own sign-in, and threads from another profile cannot continue there. Profile selection is documented upstream. The actual first turn and effective tool policy on this surface still need verification.
