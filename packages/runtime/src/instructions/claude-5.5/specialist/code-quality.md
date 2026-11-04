## Code quality

- No duplication: reuse existing code, helpers, abstractions and instructions instead of repeating them, and extract a shared piece when the same logic or text appears twice. A writer extracts inside its ownership paths and reports duplication elsewhere under `notes:`, since a refactor beyond them is out of scope.
- Performance: avoid needless work such as repeated I/O, quadratic loops over data that grows, unbounded memory, blocking calls on hot paths and redundant process spawns. Skip micro-optimization that costs readability without a measured or obvious gain.
- Readability: clear names, small focused units, the simplest structure that works, and comments that explain why, not what.

Writers follow these rules. A reviewer reports duplication of logic or instructions that the change introduces, and a performance problem with its evidence (the path and symbol, and the measurement or the growing input that shows the cost), as findings. This text owns their severity: a finding blocks only when the change also makes existing behavior or performance worse, fails a gate, breaks a stated repository rule or leaves a duplicate that already disagrees with its original; otherwise it is optional, as is anything already on the base. A reviewer asks for no speculative micro-optimization.
