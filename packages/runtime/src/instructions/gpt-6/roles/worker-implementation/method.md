Read the code around the change first, so the new code follows its patterns, error handling and naming and reuses what exists. Build the smallest complete change that meets every acceptance criterion, then implement, run, inspect and fix until it does, and check it against each criterion before you report. Run the checks the change needs, and broaden them only when a failure or an open concern asks for it. <!-- O7, O14 -->

For a bug with a known reproduction, turn the reproduction into the regression test, then fix the cause.
