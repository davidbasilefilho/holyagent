---
name: tui-design
description: Use when building, reshaping or judging a terminal UI or a command-line tool's interactive and piped output.
---

# Terminal UI design

Rules for full-screen terminal apps and line-based tools, judged on text frames and image frames. Terminal behavior that no still shows is a behavior check that Worker.operations runs in a terminal session by interrupting and killing the app.

<!-- design-core -->

## Terminal rules

### Layout follows the work

- Map the job to a layout: a list or table with a detail view, one focused form, a log or stream, or a dashboard.
- The layout meets an 80×24 floor and degrades gracefully below it, with no tearing or lost input.
- Run a clutter audit before adding a border or a panel. Borders are rare and use real box-drawing characters: heavy for the focused pane, light for the rest.

### Input and focus

- One element owns input at a time, and the focused one is visibly marked.
- Ctrl-C always exits, `q` quits where nothing is being edited, `?` shows help sized to the window, and `-h` or `--help` works. (behavior check)
- Pasted text is text, never commands. (behavior check)
- A resize reflows every screen. Capture before and after.

### State

- A slow reply never overwrites a newer one. (behavior check)
- Selection stays on the same item when the list reloads or re-sorts. (behavior check)
- Durable errors stay retrievable in a log or status view, not only in a toast that vanishes.
- Log lines never tear through the drawn screen.

### Terminal hygiene

- After the app exits, is interrupted or crashes, the shell works normally: echo on, the main screen back, the cursor visible. (behavior check)
- Untrusted text never changes colors or moves the cursor. (behavior check)
- Do not assume alternate-screen support; an inline mode is valid.

### Width and glyphs

- Measure and truncate by grapheme cells, never bytes or code points. Test real text with East Asian, emoji sequences and variation selectors; treat ambiguous width as narrow unless known.
- Read the locale (LC_ALL, then LC_CTYPE, then LANG). When it is not UTF-8, the whole glyph set is ASCII, never a mix, and an ASCII override always exists. (behavior check)
- Nerd Font glyphs are opt-in, and a private-use glyph is never the only carrier of meaning.

### Color

- Precedence is flag, then config, then environment, then TTY detection. A non-empty NO_COLOR removes added color but keeps bold and underline; FORCE_COLOR forces color; empty variables count as unset. When both are set NO_COLOR wins, an accessibility choice this skill makes because its sources disagree; an explicit flag beats both. (behavior check)
- Capability tier: COLORTERM of truecolor or 24bit, then a TERM ending in 256color, then 16 colors; TERM=dumb or no TTY gets none. COLORTERM is a hint that SSH and multiplexers lose. (behavior check)
- Detect a light or dark background with a bounded query and default to dark.
- At most three semantic colors plus one accent. (default)
- Status colors pair with text or a shape. Both light and dark backgrounds stay legible.

### Piped and scripted output

- Primary output goes to stdout and messages to stderr. With no TTY there is no animation, prompt or full-screen UI. (behavior check)
- Offer `--json`, `--plain` and `--no-input`, with JSON bypassing all formatting; page only on a TTY. (behavior check)
- First output appears within 100 ms. (default) (behavior check)

### Accessibility

- A linear, line-based mode exists: no decorative boxes, no redraw of unchanged content, static progress text instead of spinners, tables as "Header: value" lines, results left in scrollback.
- A reduced-motion switch exists. Independently updating content sits in a scrolling region instead of repainting the screen.
- A link label is followed by its full URL.

## Refuse list

Unless the brief asks for it, avoid:

- boxes around everything, or nested borders
- emoji or private-use glyphs as the only meaning
- a spinner with no static fallback
- color as the only status signal
- a full-screen UI where a line of output would do (preference)

## Capture checklist

Capture text frames (with and without escapes) and image frames at 80×24 and a large size. Vary:

- the color tier: truecolor, 256 color, 16 color and NO_COLOR;
- light and dark backgrounds;
- an ASCII locale;
- piped output.

Also capture a resize, the help view and the error view.
