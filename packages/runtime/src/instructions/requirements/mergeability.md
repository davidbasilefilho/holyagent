# Mergeability

An input to the instructions, not behavior. The bar for any change HolyAgent produces: the repository's maintainer would merge it.

## Dimensions

Six dimensions in the style of FrontierCode 1.1 mergeability grading. Each Assignment's criteria cover the ones that apply, each criterion marked blocking or non-blocking. The runtime stores them as `behavior`, `regressions`, `tests`, `scope`, `style` and `repo-standards`.

| Dimension      | What it asks                                                          | Blocking when                                                                                | Non-blocking when                       |
| -------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| behavior       | Does the change do what was asked, including error paths?             | Wrong, incomplete or unverified behavior                                                     | Polish beyond the request               |
| regressions    | Does everything that worked still work?                               | Existing behavior, interfaces or compatibility break                                         | The failure already existed on the base |
| tests          | Do tests protect the new behavior?                                    | A behavior change has no test that fails without it; a test is weakened, deleted or tailored | Extra coverage beyond need              |
| scope          | Is every changed line called for?                                     | Extra features, invented limits, unjustified refactors, formatting churn, generated noise    | An idea named for later                 |
| style          | Does it pass the project's lint, format and type-check and read well? | A gate fails                                                                                 | Naming and comment taste                |
| repo-standards | Does it follow the project's stated rules and conventions?            | A rule in CLAUDE.md, AGENTS.md or the contributing guide is broken                           | An unstated convention                  |

A blocker in any dimension fails the change. Acceptance needs support for every blocking criterion.

## What to measure

Reference only; nothing here is run by HolyAgent. The Artificial Analysis Coding Agent Index v2.0 combines FrontierCode v1.1, Terminal-Bench 4.0 and SWE-Atlas-QnA-AA. They set what a coding agent is judged on, and so what the design should keep measurable:

- mergeable implementation (FrontierCode v1.1): the dimensions above;
- terminal work (Terminal-Bench 4.0): completing real command-line tasks end to end;
- repo understanding (SWE-Atlas-QnA-AA): answering questions about a codebase from its source;
- tokens, cache use, cost and time per task: the efficiency side of the same tasks.
