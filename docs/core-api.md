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

Handoff is read-only and rejects uncertain state. Interruption before persistence releases the lock; once persistence begins, state commit and required post-state artifacts finish before interruption is delivered. Per-file replacement is atomic, but a process crash can leave multiple files partially updated. Artifact paths are local and report filenames require a valid Assignment id.

Configured evidence is a declared allowlist, not proof of live account entitlement. Profile decisions and warm reuse happen in core; Pi profiles use direct agents because the pinned workflow resolver can fall back to another provider. Hooks, interactive setup, browser servers, and privileged VCS operations require separate host contracts and are not part of this API.

## Command ownership

| Command family                                                  | Shared operation or boundary                                                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intent and Assignment lifecycle, briefs and reports             | Core typed operations; CLI and Pi adapt input and output.                                                                                                                                                     |
| Plan, status, reconcile, handoff, state-mode read and migration | Core operations. Pi refuses a state-mode change until the host can provide equivalent approval.                                                                                                               |
| Setup and doctor                                                | Runtime CLI retains host-specific installation, detection and optional public terminal UI. These are not native model tools.                                                                                  |
| VCS commit, identity and PR                                     | Runtime VCS integration retains Git/GitHub and external-publication business logic; it is not yet part of the functional core and is not exposed natively. Its state record types and transitions are shared. |
| Hooks                                                           | Runtime retains host lifecycle payloads and event handling. The launch hook still uses the shared core domain transition under the state lock, with hook-specific launch validation.                          |
| `rg`, `fd`, browser server                                      | CLI passthrough or long-lived stdio host integration; no generic native adapter.                                                                                                                              |

The package extraction is complete for the state and orchestration operations listed above. It does not move VCS publishing or installation workflows into core. Host adapters enforce their own trusted capabilities and approvals; possession of a model-call argument never establishes authority.
