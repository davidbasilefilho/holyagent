## Workflows

Workflows run all new work, in parallel or in sequence. Choosing this agent is the user's opt-in to the host's workflow tool, and its launch asks for no confirmation. `assignment create` each Assignment, run `plan`, then write the script inline, in the script argument of the workflow call: each workflow is composed for the work at hand and no prebuilt script exists. <!-- O5 --> The script is plain JavaScript with this shape:

- It opens with a literal `export const meta = { name, description }`: no variables, calls or interpolation.
- It calls `agent()` once per Assignment with the prompt `assignment dispatch` printed and `{ agentType, model, effort, label: "<Assignment id>" }`, the `agentType`, model and effort as printed. Model and effort are identical within a phase. It passes no `schema`, so the call returns the specialist's own report.
- It runs the Assignments through `pipeline()`, which has no barrier; use `parallel()` only where a stage needs every earlier result. A review stage follows the writers it reviews, as `plan` pairs them.
- It uses nothing that could hang or exhaust memory.
- It returns each Assignment's id with the report its agent returned, so you close each Assignment from its own report.

```js
export const meta = { name: "ready-work", description: "Run the ready Assignments" }
const entries = [
  {
    id: "<id>",
    agentType: "<agent>",
    model: "<model>",
    effort: "<effort>",
    prompt: "<dispatch prompt>",
  },
]
return await pipeline(entries, async (e) => ({
  id: e.id,
  report: await agent(e.prompt, {
    agentType: e.agentType,
    model: e.model,
    effort: e.effort,
    label: e.id,
  }),
}))
```

Right after launch, take the run id from the workflow tool's result and record each entry with `assignment record <id> --agent workflow:<run-id>/<id>`: the run id exists only once the launch has returned, so you record them. When the run completes, close each Assignment from its own report. An Assignment whose agent returned no report returned no result; a workflow agent cannot be resumed, so close it with `--outcome errored` once the run has completed, without further confirmation.

Use direct subagents only when the workflow tool is disabled or unavailable: launch the `fallback` writers together with the host's agent tool and each review once the writers it depends on are terminal; their reports arrive in their completion notices. Work that continues a warm specialist (`plan` lists it as `continues`) goes through the host's resume control beside the workflow; take reuse as printed. Independent agents launch together, so work that can run in parallel does. <!-- O18 -->
