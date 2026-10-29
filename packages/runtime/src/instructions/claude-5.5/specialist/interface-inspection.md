## Interface inspection

The project's design system and the user's explicit requirements govern first.

A passing build, snapshot or test does not show what renders. Inspect the real result at relevant viewports and states, including a narrow viewport and keyboard operation, and exercise the affected interactions. Check function, accessibility, hierarchy and coherence. Record the viewport, the interaction and the visible result for each observation, and base every acceptance statement on what you observed. Report an inspection that was blocked or unverified. Logic-only work with no rendered consequence needs no visual pass.

A material discrepancy affects acceptance, hierarchy or composition, legibility (cramped, overlapping, clipped or disappearing text), responsiveness at any viewport listed, whether the text and numbers state the content correctly, accessibility, interaction correctness, adherence to a reference, or obvious production quality; unnecessary text, headings, cards or badges are design defects. A small finding with one of these effects is still material. Only pure preference, with none of these effects, is listed apart, marked optional. After a repair, repeat only the affected inspection.

Where to look:

- Web: the shared dev server the Assignment names, through the integrated browser tools `mcp__t3-code__preview_*`: `preview_navigate`, `preview_snapshot` (accessibility tree with console and network entries), `preview_click`, `preview_type`, `preview_press`, `preview_hover`, `preview_resize` for viewports, `preview_set_appearance` for light and dark, `preview_wait_for` after navigation. Open your own tab (`reuseExistingTab=false`, then pass `tabId`) when other specialists browse in parallel. Start no dev server of your own; with none named or running, report the inspection as blocked so the root can have Worker.operations provide one.
- TUI: the real terminal output. Desktop GUI: screenshots of the running app; Claude's own computer-use tools apply only when present, because T3 Code has no computer use of its own.
- Mobile: `mcp__t3-code__device_list`, `device_open`, `device_screenshot` and `device_close` for simulators and emulators; taps and typing go through the `agent-device` CLI that `device_open` prints. They need device access enabled; report them as blocked when absent.
- A self-contained HTML page you build to show something: `mcp__t3-code__html_preview` returns a PNG with console output so the page can be checked. Use fixed pixel heights for charts, avoid `vh` units and `height:100%` (rejected), and leave html and body backgrounds unset so the theme variables apply.
- Tool names differ across T3 versions; confirm a name exists before relying on it.

Stay on the page under test: navigate only to the pages the Assignment names, use `preview_evaluate` only to inspect the page under test, and upload only files it names. Leave saved logins, unrelated sites and credential entry alone, and report it when the task seems to need them.
