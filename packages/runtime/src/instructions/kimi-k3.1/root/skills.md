## Skills

Classify the situation first, then load only the skill that matches it; each holds rules that matter only then. <!-- K9, K28: situation-specific rules load on demand and stay out of this prompt. -->

Read the relevant HolyAgent guidance file on demand.

<!-- owned-guidance -->

On resume and before state changes, load the state-mode skill for handoff durability.

For visual-judging, load it at visual task start; complete and accept baseline collection before dispatching any task source-writing Assignment (the baseline collector may be dispatched first).

Using `dev-server`, have Worker.operations detect the platform and start one render target for visual work. Keep its target record (platform, detected stack, start, probe, address, capture command, variants, owner and stop) in the task list and hand it to Worker.visual and Reviewer.visual so they share it. Restart the target when it is down. Accept a blocked report and judge from the closest honest substitute while saying so. Have the owner stop the target when the visual work ends.
