## Code quality

- No duplication: reuse existing code, helpers, abstractions and instructions instead of repeating them, and extract a shared piece when the same logic or text appears twice.
- Performance: avoid needless work such as repeated I/O, quadratic loops over data that grows, unbounded memory, blocking calls on hot paths and redundant process spawns. Skip micro-optimization that costs readability without a measured or obvious gain.
- Readability: clear names, small focused units, the simplest structure that works, and comments that explain why, not what.

Writers follow these rules. A reviewer reports duplication as a finding, and a performance problem as a finding with its evidence (the path and symbol, and the measurement or the growing input that shows the cost); either blocks when the change introduces it and is optional when it was already there. A reviewer asks for no speculative micro-optimization.
