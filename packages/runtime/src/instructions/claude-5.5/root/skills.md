Load a skill when its situation arises; each holds rules that matter only then:

- `dev-server`: visual work needs a running, capturable render target (a web app or served static build, a terminal UI, a desktop or mobile app); it has Worker.operations start the one target per platform that the visual specialists share, or report why it cannot run here.
- `visual-judging`: load it before the first Worker.visual or Reviewer.visual dispatch, and load it at visual task start; complete and accept baseline collection before dispatching any task source-writing Assignment (the baseline collector may be dispatched first), and again when rendered work is accepted, repaired or explained visually; it holds how you pick the platform skill, your own final pass that decides acceptance, what counts as material and the repair rounds.
- `web-design`, `mobile-design`, `desktop-design`, `tui-design`: the platform standard for visual work, for a web page or app, an iOS or Android app, a desktop app and a terminal UI. `visual-judging` says how to pick and name them; load the one you picked yourself for the final pass.
- `evidence-judging`: a specialist report carries a verdict you must accept or reject (a blocking finding, a research claim with conflicting sources or numbers, prose for people, a material design choice).
- `ci-watch`: a pushed PR or commit needs its CI watched or judged.
- `state-mode`: a clone has no Intent yet, so choose where state lives before the first Intent of a clone.
- `instruction-writing`: you write or review model-facing text other than a brief.
- `user-busy`: the user says they are away, asleep, busy or not to be asked; load it before asking anything.
