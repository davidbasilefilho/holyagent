## Shared core

Judge every rule on the rendered result, from the captures. The one exception is the rules under Direction before code, which are checked as a plan in the worker's report or `DESIGN.md`, not on a render.

Two tags mark rules that are not judged from a capture:

- `(behavior check)` marks a rule no capture can show (a file, a process, an input sequence). Worker.operations runs it and reports it, and nobody infers it from a still.
- `(preference)` marks taste: list it, do not repair it.

A violation of any other rule is judged by this definition:

<!-- materiality -->

A number is binding only where a platform guideline fixes it; every other number is a default, marked `(default)`, that the design may override with a stated reason.

Apply the skill's capture checklist on the final captures: the worker before reporting, the reviewer in its findings and the root in its own final pass. Before visual work is reported done, the worker also measures the padding and gaps on those captures against the spacing rules (in pixels or computed styles on a web, mobile or desktop render, in character cells on a terminal frame), repairs what it finds, captures again and names each place where content still touches a rule, border or edge, or says none remain. The reviewer compares the same captures and any measurements the worker recorded against the spacing rules and names each visible contact or missing padding by its location, or says it found none; it gives no number it did not read from a capture or a record. <!-- O26 --> Check your own work as it takes shape, from captures wherever the environment can produce them. Report only checks actually run, and name each check not run.

### Direction before code

- When the brief leaves out the subject, the audience or the main job, confirm them with the user when one can answer, and otherwise state them as a proposal in the plan; remembered preferences or project context are a starting hint. The brief's own words outrank every avoid list below. <!-- O1 -->
- Let the subject supply the look: its trade, materials and idiom decide the visual choices, and the brief's real content stays in the work from start to finish. A ferry timetable and a toddler's game should look nothing alike.
- Choose palette, type and layout on purpose and for this brief alone, accept visual risk when it earns its place, and treat each project as a chance to try something new instead of repeating what you do best.
- Sketch a plan before building. It holds:
  - a small named palette: four to six colors, each with a value and a role;
  - the type roles;
  - a layout idea in one sentence, compared through rough ASCII wireframes, with how the content aligns (left, centered or justified);
  - two or three principles;
  - an audit with two questions, "would I make this for any similar product?" and the competitor test (drop an idea that still works with a competitor's name on it);
  - a rewrite of what fails, with a note of what changed and why.

  Write code only from the revised plan. <!-- O2: the plan's contents are named; the order is the one that matters. -->

- Say whether this is a refinement, which preserves the existing design, or a redesign, which replaces it.

### Platform fidelity over invention

- Use the platform's own components, navigation and conventions unless the brief gives a reason not to, and brand through the layer the platform leaves open.
- Ported-from-a-website test: a fluent user of the platform never pauses at an off-spec control.
- Rules here are platform concepts. Detect the project's stack and map each rule onto it; never assume one.

### Design record

- Read `DESIGN.md` at the project root before UI work and create or update it after. It holds: platform and stack, direction, color roles, type roles, spacing and shape, components and states, do and don't, and a brief log of the options already tried, so later passes explore new ground. Note a changed decision instead of silently overwriting it. (behavior check)

### Spend boldness in one place

- Make one detail per screen the memorable one and keep the rest calm and restrained. Strip ornament that does nothing for the brief, and before finishing remove one accessory more, filling the gap with scale, real content or a real image so the screen is not left thin. (preference)
- A labeled gray placeholder beats drawn art or emoji used as icons. (preference)

### Structure and content

- A border, divider, outline, label, eyebrow or number belongs only where it tells the reader something true about the content. Numbers mark a real sequence (steps, a timeline) and nothing else, so confirm it is one first. An eyebrow over every heading, all-caps labels and labels that say nothing are decoration, not structure.
- With no real content in the brief, invent specific copy from the subject: generic words flatten a design as much as a generic layout does.

### Copy

- Interface text exists to help someone understand and act, so treat it as part of the design. Decide what the screen must convey and the shortest way to convey it, with one job for each piece of text. <!-- O10 -->
- Speak in the user's terms, calling a thing what the user calls it ("saved searches", not "query presets"). Say what a thing is or does without selling it; concrete beats clever.
- Set text in sentence case unless the platform sets its own casing, leave out padding, keep the tone conversational and in step with the brand and its readers, and write in the active voice with everyday verbs.
- A control names its outcome ("Send invoice", not "Submit"), and each action carries one name from first label to confirmation: the Duplicate button leads to a "Duplicated" confirmation.
- When something fails or nothing is there yet, point the way. An error states what happened and how to recover, speaks as the interface and not as a person, and neither apologizes nor stays vague; an empty state invites the first action.

### Spacing and alignment

Models tend to ship cramped or misaligned spacing that a glance at the whole page misses, so these hold on every screen and are measured on the captures. <!-- O26 -->

- Use one spacing scale throughout. Every padding and gap is a step of it, because off-scale one-offs read as accident.
- Give every container (card, panel, button, field, cell) padding on all sides, so text and media never touch its edge.
- Keep a gap between every block and the rules, dividers, borders and section edges around it, below and beside it as well as above, so nothing sits flush against a line.
- Let the content of a column share one left edge and one right edge: headings, text and the outer edges of cards line up, and an element that starts further in or out than its neighbours has a reason the design states. Two edges in one column read as a mistake.
- Let no wrapped line begin with a dash or other closing punctuation (an em or en dash, comma, period, colon, or a closing quote or bracket). Join the mark to the word before it with a non-breaking join or the platform's text-wrap control, or reword (in a terminal frame, where no such join exists, reword or move the break), because a mark that wraps to a line start reads as a break. A dash that opens a line on purpose, such as an attribution, is fine.

### Quality floor, unannounced

- Text contrast is at least 4.5:1 and non-text control contrast at least 3:1. Color is never the only signal, and the colors work together as a palette.
- Every state exists and is captured where reachable: hover or press, focus, disabled, loading, empty, error and long content.
- The system's reduced-motion, larger-text and high-contrast settings, where the platform has them, change the render; under reduced motion, movement becomes a fade or nothing.

### Iteration quality

Assess the design system, composition, alignment, contrast, distribution, placement and sizing, and responsiveness. Exercise fluid component and route animation and transitions, including reduced motion. For each interactive element check hover where applicable, press or tap, keyboard focus and disabled appearance where relevant. Follow platform conventions while preserving creative latitude.
