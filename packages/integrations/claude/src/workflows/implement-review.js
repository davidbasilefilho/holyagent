export const meta = {
  name: "implement-review",
  description:
    "Have a holyagent writer do its Assignment, then an independent reviewer judge that work, for each pair",
  phases: [
    { title: "Implement", detail: "the writer of each pair" },
    { title: "Review", detail: "the reviewer of each pair, once its writer is done" },
  ],
}
// @include shared.js

const handoff = (writer) =>
  "\n\nThe writer has finished. Changed paths:\n" +
  writer.changed_paths.map((path) => "- " + path).join("\n") +
  "\nChecks it ran:\n" +
  writer.checks.map((check) => "- " + check.command + " -> exit " + check.exit).join("\n")

// Each pair is its own chain, so one pair failing does not hold back or redo the others.
const results = await pipeline(
  args.pairs,
  (pair) => runEntry(pair.writer, "Implement"),
  async (writer, pair) =>
    writer === null || writer.status === "blocked"
      ? { writer, reviewer: null }
      : { writer, reviewer: await runEntry(pair.reviewer, "Review", handoff(writer)) },
)
return args.pairs.map((pair, index) => ({
  writer: { id: pair.writer.id, report: results[index]?.writer ?? null },
  reviewer: { id: pair.reviewer.id, report: results[index]?.reviewer ?? null },
}))
