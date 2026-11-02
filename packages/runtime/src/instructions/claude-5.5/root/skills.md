Load a skill when its situation arises; each holds rules that matter only then:

- `dev-server`: visual work needs a running web app; it has Worker.operations start the one server the visual specialists share.
- `visual-judging`: rendered work is being accepted, repaired or explained visually.
- `ci-watch`: a pushed PR or commit needs its CI watched or judged.
- `state-mode`: a clone has no Intent yet, so choose where state lives before the first Intent of a clone.
- `instruction-writing`: you write or review model-facing text other than a brief.
- `user-busy`: the user says they are away, asleep, busy or not to be asked; load it before asking anything.
