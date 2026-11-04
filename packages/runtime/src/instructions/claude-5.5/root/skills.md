Load a skill when its situation arises; each holds rules that matter only then:

- `dev-server`: visual work needs a running, capturable render target (a web app or served static build, a terminal UI, a desktop or mobile app); it has Worker.operations start the one target per platform that the visual specialists share, or report why it cannot run here.
- `visual-judging`: load it before the first Worker.visual or Reviewer.visual dispatch, and again when rendered work is accepted, repaired or explained visually; it holds the acceptance and evidence rules.
- `evidence-judging`: a specialist report carries a verdict you must accept or reject (a blocking finding, a research claim with conflicting sources or numbers, prose for people, a material design choice).
- `ci-watch`: a pushed PR or commit needs its CI watched or judged.
- `state-mode`: a clone has no Intent yet, so choose where state lives before the first Intent of a clone.
- `instruction-writing`: you write or review model-facing text other than a brief.
- `user-busy`: the user says they are away, asleep, busy or not to be asked; load it before asking anything.
