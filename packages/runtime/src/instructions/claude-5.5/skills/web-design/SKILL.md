---
name: web-design
description: Use when building, reshaping or judging the visual design of a web page or web app. Holds the shared design core, web rules for systems, hierarchy, semantics, edge cases and motion, a refuse list and the capture checklist.
---

# Web design

Rules for pages and web apps, judged on what renders. Pair this with the embedded `frontend-design` guidance, which owns the visual direction; this skill adds the systems, the semantics and the capture floor.

<!-- design-core -->

## Web rules

- Name the mode in the plan. An expressive page (marketing, editorial) is judged on point of view and composition; a task-oriented product UI is judged on familiarity and speed of use.
- A product UI earns familiarity: one type family, motion of about 150 to 250 ms only as feedback to an action, no page-load choreography, and a modal only as a last resort. (defaults)

### Systems, not values

- Space, type size, shadow and opacity come from small scales. For space, for example 4, 8, 12, 16, 24, 32, 48, 64 and 96, with no adjacent steps closer than about 25%. Symptom: near-identical gaps or one-off sizes in the capture. (defaults)
- More space surrounds a group than sits inside it, so groups read at a glance.
- Two font weights. Hierarchy comes from weight and color before size, with at most three text colors. (defaults)
- The layout holds its hierarchy in grayscale before color is added. (preference)
- Body text measure is 65 to 75 characters, and a line never spans a wide screen. (default)

### Actions and hierarchy

- One primary action per view, visibly dominant over the rest.
- A destructive action is not a big red button by default; the strong styling sits inside its confirmation. Capture the confirmation step.
- Destructive actions are confirmed or undoable. (behavior check)

### Semantics and input

- Buttons act and links navigate. A control that navigates is a link and one that acts is a button. (behavior check)
- Icon-only buttons have a label, shown as a tooltip on hover and focus.
- Focus is visible on every interactive element in a keyboard traversal. An outline is never removed without a visible replacement.
- Forms accept paste, use the input type and autofill hint that fit each field, and never block the user. (behavior check)
- After a failed submit, each error sits inline beside its field and focus moves to the first one. Capture that frame.

### Content edge cases

- Truncation, long words, an empty state and very long content render without overflow, overlap or a broken layout.
- State that should survive a reload or a share lives in the URL: reload and open the copied URL fresh, and the same view returns. (behavior check)

### Motion

- Only position-like transforms and opacity animate, never a blanket "all properties" transition. (behavior check)
- Animations can be interrupted, and under reduced motion movement is replaced by a fade or nothing. Capture with the setting on.

### Themed browser surfaces

- Selection color, caret, scrollbars and focus rings are styled as part of the design in both themes.

## Refuse list

Unless the brief asks for it:

- identical icon-card grids and hero metric tiles
- an eyebrow label over every heading
- gradient text and side-stripe borders
- glass as decoration (preference)
- emoji as icons
- "01 / 02 / 03" numbering without a real sequence
- cream with terracotta, or near-black with an acid accent (preference)

## Capture checklist

Capture at phone, tablet and desktop widths. For each, capture light and dark, reduced motion on, and 200% text zoom; also a keyboard-only focus traversal, each state of the key control, the confirmation of a destructive action and a failed form submit.

Apply it on the final captures: the worker before reporting, the reviewer in its findings and the root in its own final pass. Report only checks actually run, and name each check not run.
