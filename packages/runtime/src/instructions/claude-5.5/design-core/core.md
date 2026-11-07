## Shared core

Judge every rule on the rendered result, from the captures; the rules under Direction before code are the exception, checked as a plan in the worker's report or `DESIGN.md`, not on a render. `(behavior check)` marks a rule no capture can show (a file, a process, an input sequence): Worker.operations runs it and reports it, and nobody infers it from a still. `(preference)` marks taste: list it, do not repair it. A violation of any other rule is judged by this definition:

<!-- materiality -->

A number is binding only where a platform guideline fixes it; every other number is a default, marked `(default)`, that the design may override with a stated reason.

Apply the skill's capture checklist on the final captures: the worker before reporting, the reviewer in its findings and the root in its own final pass. Critique your own work while you build, with captures wherever the environment can take them. Report only checks actually run, and name each check not run.

### Direction before code

- Name the subject, the audience and the main job, and propose them in the plan when the brief omits them, taking any known preferences or project context as a hint. The brief's own words outrank every avoid list below.
- Draw distinctive choices from the subject itself, its industry, materials and vernacular, and build with the brief's real content throughout: a toy for eight-year-olds and a dashboard for financial analysts should not look related.
- Make deliberate, opinionated choices on palette, type and layout that are specific to this brief, and take aesthetic risk when it is justified.
- Write a compact plan before building: four to six named palette colors with values and roles, type roles, a layout concept in one-sentence prose with ASCII wireframes to compare options and its alignment (left, centered or justified), and two or three principles. Test it with "would I make this for any similar product?" and the competitor test: drop an idea that still works with a competitor's name on it. Revise every part that fails, say what changed and why, and only then write code.
- Say whether this is a refinement, which preserves the existing design, or a redesign, which replaces it.

### Platform fidelity over invention

- Use the platform's own components, navigation and conventions unless the brief gives a reason not to, and brand through the layer the platform leaves open.
- Ported-from-a-website test: a fluent user of the platform never pauses at an off-spec control.
- Rules here are platform concepts. Detect the project's stack and map each rule onto it; never assume one.

### Design record

- Read `DESIGN.md` at the project root before UI work and create or update it after: platform and stack, direction, color roles, type roles, spacing and shape, components and states, do and don't, and a short note of what you tried, so later passes try something new. Note a changed decision instead of silently overwriting it. (behavior check)

### Spend boldness in one place

- One signature detail per screen; everything around it stays quiet and disciplined. Cut decoration that does not serve the brief, remove one accessory before finishing, and replace it with scale, real content or a real image, so the screen is not left thin. (preference)
- A labeled gray placeholder beats drawn art or emoji used as icons. (preference)

### Structure and content

- A structural device (outline, border, divider, eyebrow, label or number) encodes something true about the content and is not decoration. Number items only when the content is a sequence, such as steps or a timeline; check before adding numbers.
- When the brief has no real content, write specific copy and placeholder content from the subject: generic copy makes a design read as templated as generic layout does.

### Copy

- Words are design content, not decoration. Before writing, ask what the screen has to say and the simplest way to say it; each written element does one job.
- Write from the user's side, naming things as users understand them (notifications, not webhook config). Say what something is or does and do not sell it; specific and legible beats clever.
- Use active voice, plain verbs, sentence case (or the platform's own capitalization) and no filler, with a tone that fits the brand and the audience.
- A control says exactly what happens ("Save changes", not "Submit"), and an action keeps one name through the whole flow: the Archive button leads to an "Archived" confirmation.
- Failure and emptiness give direction. An error says what went wrong and how to fix it, in the interface's voice and without apology or vagueness; an empty screen invites the next action.

### Quality floor, unannounced

- Text contrast is at least 4.5:1 and non-text control contrast at least 3:1. Color is never the only signal, and the palette is harmonious.
- Every state exists and is captured where reachable: hover or press, focus, disabled, loading, empty, error and long content.
- The system's reduced-motion, larger-text and high-contrast settings, where the platform has them, change the render.
