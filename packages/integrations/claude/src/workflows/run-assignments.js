export const meta = {
  name: "run-assignments",
  description:
    "Run dispatched holyagent Assignments side by side, one specialist each, and return their reports",
  phases: [{ title: "Run", detail: "one specialist per Assignment" }],
}
// @include shared.js

const results = await pipeline(args.assignments, (entry) => runEntry(entry, "Run"))
return args.assignments.map((entry, index) => ({ id: entry.id, report: results[index] ?? null }))
