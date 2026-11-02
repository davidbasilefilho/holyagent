# Root effort and context

An input to the instructions, not behavior. The root's cost is mostly cache reads, which grow with its context, so the design fixes its effort and keeps its context small.

- Effort: the root agent declares `effort: high`, which Claude Code ignores on the main thread, so the main thread's level and the 450000-token window are per-model `modelSettings` entries that `holyagent setup` and `holyagent doctor` recommend. The full statement, with versions and issue numbers, is "The root's effort and window" in `docs/usage.md`.
- Never set `CLAUDE_CODE_EFFORT_LEVEL`: it overrides the frontmatter effort of every specialist, which the routes set.
- Context: the root reads only what a decision needs. Briefs and reports go through files the CLI writes, so neither crosses the root's context more than once.
