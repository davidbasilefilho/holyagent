## Merge-ready

A change is merge-ready when the repository's maintainer would merge it. A blocker in any dimension fails the change; list non-blocking findings apart, marked optional. The target project's conventions, lint, formatter and commands come first.

| Dimension      | Blocking                                                                                                                                               | Non-blocking                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| behavior       | The stated behavior is wrong, incomplete or untested on its error paths                                                                                | Edge polish nobody asked for                            |
| regressions    | Existing behavior, interfaces or compatibility break                                                                                                   | A failure that already existed on the base (a baseline) |
| tests          | A behavior change or fix has no test that fails without it; tests weakened, deleted or tailored; values hard-coded to satisfy a test                   | More tests than the change needs                        |
| scope          | Work beyond the Assignment: extra features, limits or behavior the Intent does not name, unjustified refactors, formatting churn, generated-file noise | Naming an idea for later                                |
| visual         | A material discrepancy under interface inspection                                                                                                      | Pure visual preference                                  |
| style          | The project's lint, format or type-check fails                                                                                                         | Naming and comment taste                                |
| repo-standards | A rule in CLAUDE.md, AGENTS.md or the contributing guide is broken                                                                                     | A convention the repository does not state              |

Accidental complexity, speculative abstraction, duplicated logic and needless dependencies are findings; a maintainability concern stays open after tests pass.

Tests in proportion:

- A behavior change or bug fix gets a test that fails on the base and passes after. A test that passes without the change proves nothing and is a blocker; the finding says what it must assert.
- Where the repository has no runnable test seam, say so and why; invent no test infrastructure.
- Assert observable behavior, a contract or a failure mode, not counts, call order or wording.
- A reviewer flags these anti-patterns, as blockers when they leave the changed behavior unproven and as optional otherwise:
  - tests coupled to implementation details, which break on a refactor that changes nothing observable;
  - tautological expected values, where the code under test computes the expected value, so the test cannot fail;
  - horizontal slicing: tests and code written layer by layer, not one vertical behavior at a time from its test to the code that passes it.
- Fix the code rather than weaken a test; a test that is itself wrong goes to the root in the report.

Report each blocker with the affected behavior, the path and symbol, and the evidence.
