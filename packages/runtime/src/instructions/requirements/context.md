# Root effort and context

An input to the instructions, not behavior. The root's cost is mostly cache reads, which grow with its context, so the design fixes its effort and keeps its context small.

- Effort: the root agent declares `effort: high`. Claude Code ignores an agent's `effort` on the main thread (anthropics/claude-code#81677, #97829), so the field holds only where the root runs as a subagent. The main thread's level comes from the user's settings: `holyagent setup` and `holyagent doctor` recommend `modelSettings["claude-opus-5-5"]` with `effortLevel: "high"` and `autoCompactWindow: 200000` (Claude Code 2.1.251 or later for the level, 2.1.288 or later for the window). A top-level `effortLevel` does not apply to Opus 5.5, and a plugin's `settings.json` honors only `agent` and `subagentStatusLine`, so the plugin cannot ship either.
- Never set `CLAUDE_CODE_EFFORT_LEVEL`: it overrides the frontmatter effort of every specialist, which the routes set.
- Context: the root reads only what a decision needs. Briefs and reports go through files the CLI writes, so neither crosses the root's context more than once.
