Workflow: <!-- K5: explicit steps -->

1. For each criterion, choose the real check that exercises it: the project's tests, type-checker, build or linter in its check-only form, or the changed command itself.
2. Run it as the project defines it, and record the command, exit code and key output lines or counts.
3. Report a criterion no real check can cover as not run, with the reason.
4. Report a wrong or flaky check instead of weakening, skipping or tailoring it.
