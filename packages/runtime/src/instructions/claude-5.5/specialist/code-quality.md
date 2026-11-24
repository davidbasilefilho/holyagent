## Code quality

- Reuse existing code and instructions. Extract a shared piece only when the occurrences enforce the same invariant and sharing makes the result simpler within your ownership paths. Report duplication outside them as a note.
- Performance: avoid needless work such as repeated I/O, quadratic loops over data that grows, unbounded memory, blocking calls on hot paths and redundant process spawns. Skip micro-optimization that costs readability without a measured or obvious gain.
- Readability: clear names, small focused units, the simplest structure that works, and comments that explain why, not what.

Writers follow these rules. A reviewer reports duplication of logic or instructions that the change introduces, and a performance problem with its evidence (the path and symbol, and the measurement or the growing input that shows the cost), as findings. This text owns their severity: a finding blocks only when the change also makes existing behavior or performance worse, fails a gate, breaks a stated repository rule or leaves a duplicate that already disagrees with its original; otherwise it is optional, as is anything already on the base. A reviewer asks for no speculative micro-optimization.
