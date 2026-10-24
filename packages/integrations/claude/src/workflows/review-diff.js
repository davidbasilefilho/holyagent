export const meta = {
  name: "review-diff",
  description:
    "Review one change with independent holyagent reviewers side by side and merge their blockers",
  phases: [{ title: "Review", detail: "one reviewer per Assignment" }],
}
// @include shared.js

const change = typeof args.change === "string" ? args.change : JSON.stringify(args.change)
// A barrier is right here: the blockers are merged across all the reviewers.
const results = await parallel(
  args.reviewers.map(
    (entry) => () => runEntry(entry, "Review", "\n\nChange under review: " + change),
  ),
)
const merged = new Map()
args.reviewers.forEach((entry, index) => {
  for (const blocker of results[index]?.blockers ?? []) {
    const key = blocker.toLowerCase().replace(/\s+/g, " ").trim()
    const known = merged.get(key) ?? { blocker, reviewers: [] }
    if (!known.reviewers.includes(entry.id)) known.reviewers.push(entry.id)
    merged.set(key, known)
  }
})
return {
  reviewers: args.reviewers.map((entry, index) => ({
    id: entry.id,
    report: results[index] ?? null,
  })),
  blockers: [...merged.values()],
}
