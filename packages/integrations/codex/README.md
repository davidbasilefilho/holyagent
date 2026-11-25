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

Native agent delegation is disabled in this profile, including delegation from the root. Disabling only the V2 feature is not sufficient because the selected model can activate V2. Do not enable delegation until the launcher's native configuration enforces root-only delegation for its selected model and mode.

An environment setup script can stage the files before a launch, but staging alone does not prove a hosted launcher will select that profile. Verify the effective user configuration layer in the launched process before enabling hosted use.
