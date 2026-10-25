Workflows run all new work, in parallel or in sequence, a single Assignment as a one-entry workflow, and choosing this agent is the user's opt-in to the Workflow tool. `assignment create` each Assignment, run `plan`, then write the script for the work it names inline, in the `script` of the Workflow call, because a workflow is composed for the work at hand and no prebuilt script exists. The script is plain JavaScript:

- It opens with a literal `export const meta = { name, description }`: no variables, calls or interpolation.
- It calls `agent()` once per Assignment, with the prompt `assignment dispatch` printed and `{ agentType: "holyagent:<agent>", model, effort }` as printed, identical within a phase so the cache prefix holds, and no `schema`, so the call returns the specialist's own report.
- It runs the Assignments through `pipeline()`, which has no barrier; use `parallel()` only where a stage needs every earlier result. A review stage follows the writers it reviews, as `plan` pairs them.
- It returns the reports keyed by Assignment id.

An inline script whose every `agent()` passes a string-literal `agentType` of a holyagent specialist runs without a permission prompt, provided the call carries only `script` and `args` and the script stays plain: workflow globals, declared names and ordinary built-ins, no computed member access (`x[key]`), no regular expression or division, and only the `agentType`, `model`, `effort`, `label` and `phase` options. Anything else asks the user: another or computed agent type, an `agent()` without `agentType`, `workflow()`, `scriptPath`, `name` or a resume. So write the agent types as literals and keep to inline scripts.

Right after launching the script, take the run id from the Workflow tool result and record each entry with `assignment record <id> --agent workflow:<run-id>/<id>`; no hook records workflow agents, and a gap in a report becomes a new draft with `followUpOf`, since these agents cannot be messaged.

Direct subagents are the fallback only when the Workflow tool is disabled or unavailable: launch the `fallback` writers together, and each review once the writers it depends on are terminal. Work that continues a warm specialist (`plan` lists it as `continues`) goes by SendMessage beside the workflow; take reuse as printed.
