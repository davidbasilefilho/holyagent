# Codex startup preview

This developer tool stages a fresh Codex profile. It does not install a public HolyAgent setup target, edit an existing Codex profile, or change the environment of a running session.

From the checkout, pass an existing absolute staging directory. The command prints the path to a new private profile.

```sh
profile="$(bun packages/integrations/codex/src/startup.ts /absolute/staging-directory)"
CODEX_HOME="$profile" codex plugin marketplace add "$profile/holyagent/marketplace"
CODEX_HOME="$profile" codex plugin add holyagent@holyagent-local
CODEX_HOME="$profile" codex features list
```

Set `CODEX_HOME` on the process that starts Codex. The staged profile selects GPT-6.2 Sol and enables the native Default-mode question feature where the installed Codex supports it. It does not configure credentials, sandboxing, or approvals.

Native agent delegation is disabled in the default profile, including delegation from the root. Disabling only the V2 feature is not sufficient because the selected model can activate V2.

To evaluate root-only delegation locally on the 0.172.0 runtime line, download the [unmodified Codex model catalog at that tag](https://raw.githubusercontent.com/openai/codex/rust-v0.172.0/codex-rs/models-manager/models.json) and pass the absolute path to `startup.ts` as `--root-only-catalog /absolute/models.json`. The staging command verifies the catalog fingerprint. The new profile directs native Codex to a copy of that catalog in which V2 models use V1, sets V1 depth to one, and withholds the V2 native tools. Sol remains the default model. The V1 collaboration tools stay directly visible on the root even when the model uses Code Mode.

The optional profile pins the whole model catalog instead of taking live catalog updates. It is for isolated local compatibility checks, not a replacement for the hosted model catalog. Check the effective configuration on the target before enabling a supported launch. If the launcher does not select this profile or its higher-priority settings change the effective mode, use the direct-only profile.

An environment setup script can stage the files before a launch, but staging alone does not prove a hosted launcher will select that profile. Verify the effective user configuration layer in the launched process before enabling hosted use.
