---
name: web-design
description: "Use when building, reshaping or judging the visual design of a web page or web app. Holds the shared design core, web rules for systems, hierarchy, semantics, edge cases and motion, a refuse list and the capture checklist."
---

# Web design

Rules for pages and web apps, judged on what renders: the visual direction, the systems, the semantics and the capture floor.

<!-- design-core -->

## Web rules

- Name the mode in the plan. An expressive page (marketing, editorial) is judged on point of view and composition; a task-oriented product UI is judged on familiarity and speed of use. (preference)
- A product UI earns familiarity: one type family, motion of about 150 to 250 ms only as feedback to an action, no page-load choreography, and a modal only as a last resort. (default)

### Hero and typography

- Fill the hero with what is most distinctive about the subject, then pick the form that shows it best: a headline, an image, motion, a live demo or an interaction. The stock hero (one big figure over a small caption, a row of supporting stats, a gradient accent) needs a reason to be chosen.
- Typography is where a page gets its character. One family may carry both display and body when it suits the brief; two work if they differ plainly. Pick faces for this brief and not the ones you reach for every time, and build a clear scale on the conventions of The Elements of Typographic Style, with weights, widths and spacing set on purpose. (preference)
- Treat headline and display type as a design element in its own right and not a transparent carrier for the words.

### Systems, not values

- Space, type size, shadow and opacity come from small scales. For space, for example 4, 8, 12, 16, 24, 32, 48, 64 and 96, with no adjacent steps closer than about 25%. Symptom: near-identical gaps or one-off sizes in the capture. (default)
- More space surrounds a group than sits inside it, so groups read at a glance.
- Two font weights. Hierarchy comes from weight and color before size, with at most three text colors. (default)
- The layout holds its hierarchy in grayscale before color is added. (preference)
- Body text measure is 65 to 75 characters, and a line never spans a wide screen. A serif body face tolerates a somewhat longer measure but wants extra leading compared with a sans. (default)
- Set section spacing in one place and keep selector specificity flat, so a class rule and an element rule never override each other's padding or margin. Symptom: uneven or doubled gaps between sections.
- The layout holds from phone width to desktop with no horizontal scroll or clipped content.

### Actions and hierarchy

- One primary action per view, visibly dominant over the rest.
- A destructive action is not a big red button by default; the strong styling sits inside its confirmation. Capture the confirmation step.
- Destructive actions are confirmed or undoable. (behavior check)

### Semantics and input

- Buttons act and links navigate. A control that navigates is a link and one that acts is a button. (behavior check)
- Icon-only buttons have an accessible label, and a tooltip on hover and focus where a pointer exists.
- Focus is visible on every interactive element in a keyboard traversal. An outline is never removed without a visible replacement.
- Forms accept paste, use the input type and autofill hint that fit each field, and never block the user. (behavior check)
- After a failed submit, each error sits inline beside its field and focus moves to the first one. Capture that frame.

### Content edge cases

- Truncation, long words, an empty state and very long content render without overflow, overlap or a broken layout.
- State that should survive a reload or a share lives in the URL: reload and open the copied URL fresh, and the same view returns. (behavior check)

### Motion

- Spend unprompted motion on one moment, such as a single load sequence or reveal, and do not scatter it: entrance animations on every section and hover effects on every card are the stock look. Feedback motion earns its place by making the change visible.
- Only transform and opacity animate, never a blanket "all properties" transition. (behavior check)
- Animations can be interrupted.

### Themed browser surfaces

- Selection color, caret, scrollbars and focus rings are styled as part of the design in both themes.

## Refuse list

The brief's own words win over this list. Unless the brief asks for it, and without filling a choice the brief leaves open with one of these defaults, avoid:

- identical icon-card grids and hero metric tiles
- a card-kit page: look-alike rounded panels, one corner radius whatever an element's rank, the same faint shadow on every panel, and gradients as ornament
- picking out one word or phrase of a headline with italics, bold or another color
- gradient text and side-stripe borders
- glass as decoration (preference)
- emoji as icons
- a newspaper front page (hairline rules, square corners, dense multi-column text) for a subject that is not editorial (preference)
- default-kit trimmings that show up regardless of subject: a trailing arrow on links and buttons, monospace captions on small data, off-black fills used in place of true black, labels shaped as a capitalized word, a dash and a fragment, and metadata strung together with dots
- a warm paper-cream ground with a high-contrast serif and a terracotta accent, which has become a generated-page signature, or a near-black ground with one lone neon or red-orange accent (preference)

## Capture checklist

Capture at phone, tablet and desktop widths. At each width capture:

- light and dark;
- reduced motion on;
- 200% text zoom.

Also capture a keyboard-only focus traversal, each state of the key control, the confirmation of a destructive action and a failed form submit. <!-- K7: the list is counted by items, not "enough captures" -->
