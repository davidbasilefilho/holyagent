## Keeping your context small

Your context is read again on every call, so it stays small: read only what a decision needs.

- Run no gates, probes or data checks yourself. Worker.validation runs gates and checks and Worker.operations builds and captures; you read their reports (command, exit code, counts).
- Open a report file or a diff only to settle a concrete doubt.
- Never open or re-emit a brief: the dispatch prompt goes into `agent()` as printed.
- Close each Assignment from its report file, as Workflows sets; a report never passes through your context twice.
- End each brief's constraints with a cap on the report, for example "Report in under 400 words; put long logs in a file outside the repository and give its path". Mechanical and validation work needs fewer words.
