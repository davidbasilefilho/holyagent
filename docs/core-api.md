# Shared functional core

`@holyagent/core` is a private workspace package. Its Node-safe entrypoint exports `makeContext`, `executionConfig`, `loadHolyagentConfig`, `loadConfigWithSource`, `stateDirectory`, and `resolveState`. Import them directly from `@holyagent/core`; none invokes the HolyAgent CLI. For example:

```ts
const context =
  yield *
  makeContext({
    cwd,
    env,
    host: "pi",
    authorize,
    workflowsAvailable: false,
    firstPass: { "Reviewer.code": codePrompt, "Reviewer.security": securityPrompt },
  })
const result = yield * assignment.dispatch(context, draft)
```

`makeContext` accepts only trusted host data: working directory, environment, host kind, an authority callback, optional observed workflow-tool exposure, and optional first-pass prompt text assets. It resolves execution settings without creating state. `authorize` receives a `Capability` string on each operation and is called again under the state lock before mutation. Initialization and worktree migration additionally require the trusted `state.initialize` capability, which is rechecked under the relevant locks along with the operation capability. Without it, read operations use a non-mutating view of already available state; it may omit state that has not yet been initialized or migrated. State-writing operations require it when initialization can occur. It must deny unknown or unsupported capabilities and reflect live host revocation. It cannot be constructed from model input, mutable agent names, or the environment alone. The Pi adapter must independently enforce the root launch capability, configuration-enabled lifecycle, model registry and privileged-operation approval gates. For Pi's two first-pass review roles the host must provide their prompt assets; a missing asset fails the dispatch.

`intent` and `assignment` export Effect-returning named operations and each has a `schemas` object containing the corresponding strict Effect schemas. `plan`, `status`, `reconcile`, `handoff`, and `stateMode` use `overviewSchemas`; `migrate` uses `migrationSchema`. All operations take `(context, input)` and return structured results or tagged failures. The CLI adapter translates parsed flags/stdin into these inputs and renders its existing views. Dispatch returns `{ assignment, directive, briefPath, prompt, agent, launch }`; `launch` contains selected model/effort and, when profiled, ranking diagnostics. Authority is never part of a model-supplied input.

Handoff is read-only and rejects uncertain state. Initialization and migration recheck authority after preparation and before writes. The host authorization callback is synchronous and must be side-effect-free; migration uses it as a terminal guard after asynchronous checks. Direct `resolveState` callers supplying a custom authorization Effect must also supply a synchronous terminal guard; omission fails before a non-peek state resolution can change state. Cancelled file preparation can finish in the background and remove its private temporary file once the filesystem request settles; cleanup checks the original file identity and retains replacements at the temporary pathname. It cannot publish a target or remove a source. These checks do not provide filesystem isolation against concurrent external changes. Worktree checkout and Git subprocesses remain interruptible. A durable journal records migration before the state branch is updated; a later authorized operation verifies and resumes an interrupted migration. Read-only resolution refuses an unfinished migration, and read-only Core operations check the journal and state branch before and after reading; a read that spans migration fails and can be retried. Migration preserves tracked source files, including their separate staged and unstaged versions, for the user to reconcile; unchanged untracked migrated files can be removed. Conflicting target or source changes stop recovery for inspection. Artifact paths are local and report filenames require a valid Assignment id.

Configured evidence is a declared allowlist, not proof of live account entitlement. Profile decisions and warm reuse happen in core; Pi profiles use direct agents because the pinned workflow resolver can fall back to another provider. Setup, doctor and VCS have typed Core operations with host-provided services. The interactive screen, lifecycle hooks and browser server remain host adapters. A host must grant only capabilities it can enforce and must supply trusted paths, state and services; these values are never model authority.

## Command ownership

| Command family                                                  | Shared operation or boundary                                                                                                                                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent and Assignment lifecycle, briefs and reports             | Core typed operations; CLI and Pi adapt input and output.                                                                                                                                      |
| Plan, status, reconcile, handoff, state-mode read and migration | Core operations. Pi refuses a state-mode change until the host can provide equivalent approval.                                                                                                |
| Setup and doctor                                                | Core typed operations perform installation and diagnostics through a Shell service. CLI parses flags, resolves interactive choices and renders the result. Pi native tools do not expose them. |
| VCS commit, identity and PR                                     | Core typed operations compose message policy, Git/GitHub services and state recording. CLI parses flags and renders results; Pi does not expose these operations.                              |
| Hooks                                                           | Runtime retains host lifecycle payloads and event handling. The launch hook still uses the shared core domain transition under the state lock, with hook-specific launch validation.           |
| `rg`, `fd`, browser server                                      | CLI passthrough or long-lived stdio host integration; no generic native adapter.                                                                                                               |

The `setup` and `vcs` namespaces expose strict schemas and Effect-returning operations. Setup receives a `Shell` service; VCS receives `Git` and, for pull requests, `GitHub` services and a trusted state adapter. Both use the injectable `FileSystem` service, which defaults to Node filesystem operations when not provided; a trusted state adapter can also supply its own state reader. Node-compatible live services are available, but a host must constrain the working directory, environment, filesystem, process and GitHub access to its own authority. Authorization is checked at each operation boundary; hosts must also enforce revocation and per-effect permissions in their injected services. A capability is not an approval receipt. Native Pi does not expose these operations; hooks, the terminal UI, raw search passthrough and the stdio browser transport remain runtime-owned.
