## Shared core

Judge every rule on the rendered result, from the captures; the rules under Direction before code are the exception, checked as a plan in the worker's report or `DESIGN.md`, not on a render. `(behavior check)` marks a rule no capture can show (a file, a process, an input sequence): Worker.operations runs it and reports it, and nobody infers it from a still. `(preference)` marks taste: list it, do not repair it. A violation of any other rule is judged by this definition:

<!-- materiality -->

A number is binding only where a platform guideline fixes it; every other number is a default, marked `(default)`, that the design may override with a stated reason.

Apply the skill's capture checklist on the final captures: the worker before reporting, the reviewer in its findings and the root in its own final pass. Report only checks actually run, and name each check not run.

### Direction before code

- Name the subject, the audience and the main job, and propose them when the brief omits them. The brief's own words outrank every avoid list below.
- Write a compact plan before building: palette roles, type roles, a layout concept and two or three principles. Test it with "would I make this for any similar product?" and the competitor test: drop an idea that still works with a competitor's name on it.
- Say whether this is a refinement, which preserves the existing design, or a redesign, which replaces it.

### Platform fidelity over invention

- Use the platform's own components, navigation and conventions unless the brief gives a reason not to, and brand through the layer the platform leaves open.
- Ported-from-a-website test: a fluent user of the platform never pauses at an off-spec control.
- Rules here are platform concepts. Detect the project's stack and map each rule onto it; never assume one.

### Design record

- Read `DESIGN.md` at the project root before UI work and create or update it after: platform and stack, direction, color roles, type roles, spacing and shape, components and states, do and don't. Note a changed decision instead of silently overwriting it. (behavior check)

### Spend boldness in one place

- One signature detail per screen, and remove one accessory before finishing. Replace removed ornament with scale, real content or a real image, so the screen is not left thin. (preference)
- A labeled gray placeholder beats drawn art or emoji used as icons. (preference)

### Quality floor, unannounced

- Text contrast is at least 4.5:1 and non-text control contrast at least 3:1. Color is never the only signal.
- Every state exists and is captured where reachable: hover or press, focus, disabled, loading, empty, error and long content.
- The system's reduced-motion, larger-text and high-contrast settings, where the platform has them, change the render.
- Copy uses the user's words, specific verbs and one name per action, and an error says how to fix it.
