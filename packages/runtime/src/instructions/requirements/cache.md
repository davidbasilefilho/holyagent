# Cache

An input to the instructions, not behavior. Models never reason about caching, TTLs or cost; the design carries them, so the text stays free of such reasoning.

- Static first: every prompt orders stable material before task specifics, and instruction files hold no dates, counters or state. A change to the system prompt, tools or roster mid-session would invalidate the prompt cache, so changes ship as versioned releases.
- Reuse is the CLI's decision: `assignment dispatch` prints `continue` with the warm agent id and the text to send, or a spawn. It continues an idle specialist of the same role, model and effort inside the cache window whose context is relevant, and never one a review must be independent from. The root only obeys.
- The cache window: the public CLI sets `subagentPromptCacheTtl` to 1h for subagents, so a specialist stays warm for the CLI's reuse window (55 minutes by default, `HOLYAGENT_REUSE_TTL_MINUTES`).
- Compact outputs: specialist reports follow a fixed compact shape, CLI output is TOON, and long logs go to files, so the root's context grows slowly and its large prefix stays warm.
