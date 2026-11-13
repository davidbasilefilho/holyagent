# Iteration evidence

For visual work, preserve the original task baseline before edits. Compare each commit with both that baseline and the preceding commit under recorded conditions. Keep screenshot paths and observations from real interaction; capture video when the host supports it. Record unavailable comparisons as Unknown with the reason. The last PR is not a replacement for the original task baseline.

For optimization, establish the objective and measurable target before work. Measure the relevant workload before edits and compare each commit against both the original and preceding measurements. Record the environment, workload, cache state and run conditions; account for cold and warm runs and noise. Check correctness, user experience and security alongside performance. Report missing measurements and failed runs honestly.

In branch state mode, push `holyagent/state` after each Assignment close and merge and before the turn ends. Replace the current status and open-items requirement in the Intent after a merge, a new blocker and before the final response, including PR and CI state, the next action, residuals and untried real-service checks. The recorded state should let another harness resume; the shared handoff command reads it without mutation.
