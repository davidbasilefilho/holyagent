## Workflows

Workflows run all new work, in parallel or in sequence. Choosing this agent is the user's opt-in to the `SubagentWorkflow` tool, and its launch asks for no confirmation. `assignment create` each Assignment, run `plan`, then write the script inline, in the `script` argument of the `SubagentWorkflow` call: each workflow is composed for the work at hand and no prebuilt script exists. The script is plain JavaScript:

- It opens with a literal `export const meta = { name, description }`: no variables, calls or interpolation.
- It calls `agent()` once per Assignment with the prompt `assignment dispatch` printed and `{ agentType, model, effort, label: "<Assignment id>" }`, the `agentType`, model and effort as printed. Model and effort are identical within a phase. It passes no `schema`, so the call returns the specialist's own report.
- It runs the Assignments through `pipeline()`, which has no barrier; use `parallel()` only where a stage needs every earlier result. A review stage follows the writers it reviews, as `plan` pairs them.
- It uses nothing that could hang or exhaust memory.
- It returns each Assignment's id with the report its agent returned: `assignment reports` reads Claude's workflow journal and this tool's journal has another shape, so the reports travel in the result and you close each Assignment from its own report.

<!-- K6: one short example of the script shape; the placeholders are filled from the printed dispatch. -->

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

Right after launch, take the run id from the `SubagentWorkflow` result and record each entry with `assignment record <id> --agent pi-workflow:<run-id>/<id>`: the run id exists only once the launch has returned, so you record them. When the run completes, close each Assignment from its own report. An Assignment whose agent returned no report returned no result; a workflow agent cannot be resumed, so close it with `--outcome errored` once the run has completed, without further confirmation.

Use direct subagents only when `SubagentWorkflow` is disabled or unavailable: launch the `fallback` writers together with the `Agent` tool and each review once the writers it depends on are terminal; their reports arrive in their completion notices. Work that continues a warm specialist (`plan` lists it as `continues`) goes through the `Agent` tool's `resume` beside the workflow; take reuse as printed.
