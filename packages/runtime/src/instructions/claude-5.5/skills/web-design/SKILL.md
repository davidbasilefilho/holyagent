---
name: web-design
description: Use when building, reshaping or judging the visual design of a web page or web app. Holds the shared design core, web rules for systems, hierarchy, semantics, edge cases and motion, a refuse list and the capture checklist.
---

# Web design

Rules for pages and web apps, judged on what renders: the visual direction, the systems, the semantics and the capture floor.

<!-- design-core -->

## Web rules

- Name the mode in the plan. An expressive page (marketing, editorial) is judged on point of view and composition; a task-oriented product UI is judged on familiarity and speed of use. (preference)
- A product UI earns familiarity: one type family, motion of about 150 to 250 ms only as feedback to an action, no page-load choreography, and a modal only as a last resort. (default)

### Hero and typography

- The hero is the first thing a visitor sees. Open with the most characteristic thing in the subject's world, in the form that suits it: a headline, an image, an animation, a live demo or an interactive moment. A big number with a small label, supporting stats and a gradient accent is the default hero, so use it only when it is truly the best option.
- Type carries the page's personality. Use one family or two, and if two, clearly distinct ones. Choose typefaces for this brief and not the families you would reach for on any project, and set a clear type scale in the tradition of The Elements of Typographic Style, with intentional weights, widths and spacing. (preference)
- When type is a headline or a visual element, its treatment is part of the design and not a neutral vehicle for the words.

### Systems, not values

- Space, type size, shadow and opacity come from small scales. For space, for example 4, 8, 12, 16, 24, 32, 48, 64 and 96, with no adjacent steps closer than about 25%. Symptom: near-identical gaps or one-off sizes in the capture. (default)
- More space surrounds a group than sits inside it, so groups read at a glance.
- Two font weights. Hierarchy comes from weight and color before size, with at most three text colors. (default)
- The layout holds its hierarchy in grayscale before color is added. (preference)
- Body text measure is 65 to 75 characters, and a line never spans a wide screen. Serif body text may run slightly longer and takes more line height than sans serif. (default)
- Section spacing is set in one place and selector specificity stays flat, so a class like `.section` and a rule on an element like `.cta` do not cancel each other's padding or margin. Symptom: uneven or doubled gaps between sections.
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

- Motion nobody triggered is sparing and aimed at one moment, such as a single page-load sequence or one reveal. Fade-and-slide entrances on every section and hover transitions on every card are the generic default. Motion that answers an action (opening, expanding, confirming) is welcome when it shows what changed.
- Only transform and opacity animate, never a blanket "all properties" transition. (behavior check)
- Animations can be interrupted, and under reduced motion movement is replaced by a fade or nothing. Capture with the setting on.

### Themed browser surfaces

- Selection color, caret, scrollbars and focus rings are styled as part of the design in both themes.

## Refuse list

Unless the brief asks for it (its own words win, even when they name one of these looks), and without spending an axis the brief leaves free on one of these defaults:

- identical icon-card grids and hero metric tiles
- the SaaS-card kit: content chopped into identical rounded cards, one corner radius on everything whatever its rank, the same soft gray shadow under each, and gradient washes as decoration
- an eyebrow label over every heading, all-caps labels, and other labels above content that say nothing
- accenting a single word or phrase of a headline with italic, bold or another color
- gradient text and side-stripe borders
- glass as decoration (preference)
- emoji as icons
- "01 / 02 / 03" numbering without a real sequence
- a broadsheet layout of hairline rules, square corners and dense newspaper columns for a subject that is not editorial (preference)
- template chrome whatever the subject: meta strings joined with middle dots, labels built as "WORD — fragment" with a spaced em dash, a tinted near-black such as #0B0B0B or #111 standing in for black, a monospace face for small data labels, and "→" appended to link and button text
- cream (near #F4F1EA) with a high-contrast serif and a clay accent (near #D97757, which reads as a generated-page tell), or near-black with one acid-green or vermilion accent (preference)

## Capture checklist

Capture at phone, tablet and desktop widths. For each, capture light and dark, reduced motion on, and 200% text zoom; also a keyboard-only focus traversal, each state of the key control, the confirmation of a destructive action and a failed form submit.
