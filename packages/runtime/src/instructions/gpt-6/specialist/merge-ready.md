## Merge-ready

A change is merge-ready when the repository's maintainer would merge it. A blocker in any dimension fails the change, and acceptance needs support for every blocking criterion. List non-blocking findings apart, marked optional. The target project's conventions, lint, formatter and commands come first (Precedence).

Judge each criterion in one of these six dimensions, and name it by its exact lowercase name.

| Dimension      | Asks                                                                  | Blocking                                                                                                                                               | Non-blocking                                            |
| -------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| behavior       | Does the change do what was asked, including error paths?             | The stated behavior is wrong, incomplete or untested on its error paths; a rendered result has a material discrepancy under interface inspection       | Edge polish nobody asked for; pure visual preference    |
| regressions    | Does everything that worked still work?                               | Existing behavior, interfaces or compatibility break                                                                                                   | A failure that already existed on the base (a baseline) |
| tests          | Do tests protect the new behavior?                                    | A behavior change or fix has no test that fails without it; tests weakened, deleted or tailored; values hard-coded to satisfy a test                   | More tests than the change needs                        |
| scope          | Is every changed line called for?                                     | Work beyond the Assignment: extra features, limits or behavior the Intent does not name, unjustified refactors, formatting churn, generated-file noise | Naming an idea for later                                |
| style          | Does it pass the project's lint, format and type-check and read well? | The project's lint, format or type-check fails                                                                                                         | Naming and comment taste                                |
| repo-standards | Does it follow the project's stated rules and conventions?            | A rule in CLAUDE.md, AGENTS.md or the contributing guide is broken                                                                                     | A convention the repository does not state              |

Accidental complexity, speculative abstraction and needless dependencies are findings, as are breaches of the code quality rules, which set their own severity; a maintainability concern stays open after tests pass.

Tests in proportion:

- A behavior change or bug fix gets a test that asserts the previously failing behavior: it fails on the base and passes after. A test that passes without the change proves nothing and is a blocker; the finding says what it must assert.
- Run the checks the change needs, and broaden them only when a new change, a failure or an open concern asks for it. A low-impact change gets no test that only mirrors its implementation. <!-- O14 -->
- Where the repository has no runnable test seam, say so and why; invent no test infrastructure.
- Assert observable behavior, a contract or a failure mode, not counts, call order or wording.
- A reviewer flags these anti-patterns, as blockers when they leave the changed behavior unproven and as optional otherwise:
  - tests coupled to implementation details, which break on a refactor that changes nothing observable;
  - tautological expected values, where the code under test computes the expected value, so the test cannot fail;
  - horizontal slicing: tests and code written layer by layer, not one vertical behavior at a time from its test to the code that passes it.
- Fix the code rather than weaken a test; a test that is itself wrong goes to the root in the report.

Report each blocker with the affected behavior, the path and symbol, and the evidence.
