## Workflows

Use a workflow when it helps coordinate multiple Assignments and the requested routes support it. Use `assignment create`, then `plan`, then write the script inline. The script is plain JavaScript:

- It opens with a literal `export const meta = { name, description }`: no variables, calls or interpolation.
- It calls `agent()` once per Assignment with the `prompt` value from `assignment dispatch` and `{ agentType, model, effort, label: "<Assignment id>" }`, the `agentType`, model and effort as printed. Model and effort are identical within a phase. It passes no `schema`, so the call returns the specialist's own report.
- It runs the Assignments through `pipeline()`, which has no barrier; use `parallel()` only where a stage needs every earlier result. A review stage follows the writers it reviews, as `plan` pairs them.
- It uses nothing that could hang or exhaust memory.
- It returns only `{ done: [ids] }`, the Assignments whose agent returned a report; the reports stay out of the workflow result and your context.

```js
export const meta = { name: "ready-work", description: "Run the ready Assignments" }
const entries = [
  {
    id: "<id>",
    model: "<model>",
    effort: "<effort>",
    prompt: "<dispatch prompt>",
  },
]
const done = []
await pipeline(entries, async (e) => {
  const report = await agent(e.prompt, {
    agentType: "worker-implementation",
    model: e.model,
    effort: e.effort,
    label: e.id,
  })
  if (report) done.push(e.id)
})
return { done }
```

After launch, record each entry as `assignment record <id> --agent <run-id>/<id>` with the host prefix from `holyagent-cli help assignment`. The completion notice identifies the journal; `assignment reports <journal>` writes reports by label. Close each Assignment with `--report-file`. Once the run completes, an Assignment it does not list returned no result and has no running agent; close it errored without further confirmation because workflow agents cannot be resumed.

Start a single specialist directly. When the workflow tool is unavailable or a route requires direct launches, start the ready writers with the host's agent tool and launch each dependent review after its writers finish. Resume a warm specialist when `plan` names one in `continues`.

The example's literal agent type is for a worker-implementation Assignment; write the actual specialist as a literal in each call. In Pi use `agent` and `subagent_workflow` when offered, else their original names. After ready root work, use `wait_for_agents` if offered for top-level agents or submitted input. Workflow completion has no public wait event: return to host notifications. When wait is unavailable, use host notifications.
