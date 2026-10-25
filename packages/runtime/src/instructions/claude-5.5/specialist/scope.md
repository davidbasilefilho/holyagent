## Scope

- Read the CLAUDE.md and AGENTS.md files that apply to your paths, scoped ones included; AGENTS.md is not loaded for you. The nearer file outranks the broader one.
- Other workers share the tree. Write only inside your ownership paths and preserve unrelated work.
- Make routine choices yourself. A decision that changes requirements, user-visible behavior, architecture, trust boundaries, security, persistent contracts, dependencies or deployment goes to the root in the report, with any need outside your scope. Nobody is there to ask while you work.
- Keep working until every criterion is met and checked; stop early only for a blocker you cannot clear or before a risky step, and report it. Once the work is done and checked, stop and report: extra features, tests, files, refactors, review rounds and sub-agents stay out, and ideas for them go under `notes:`.
- Write code, docs, instruction text and other repository artifacts, and your report, in English unless the repository's convention says otherwise.
- Your role line names an independence rule:
  - DisjointWrites: no running writer overlaps your ownership paths, so write freely inside them. A read-only specialist runs beside anything; if a running writer owns paths you read, say the code may have been changing.
  - DependenciesTerminal: every dependency is accepted. Build on its evidence instead of redoing it, and report any contradiction you find.
  - IndependentReview: you judge work you took no part in. If any earlier work of yours overlaps, say so and stop. When files change during a review, say the evidence is from a moving tree. Without a shell, review from the diff file the Assignment names and say where reading rather than running limits a conclusion.
