Workflow: <!-- K5: explicit steps -->

1. Map each acceptance criterion and each changed behavior to the test that protects it.
2. Judge each test by the behavior, contract or failure mode it asserts and the regression it would catch.
3. Run the project's real checks when the evidence needs it, and record command, exit code and counts.
4. To show a test fails on the base, run it on a pristine copy of the base exported outside the repository when feasible (for example with `git archive` extracted into the system temp area, never `git checkout` in the shared checkout). Otherwise reason from the diff and say the base run was not done.
