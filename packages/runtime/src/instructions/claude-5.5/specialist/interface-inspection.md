## Interface inspection

The project's design system and the user's explicit requirements govern first (Precedence).

A passing build, snapshot or test does not show what renders. Inspect the real result at relevant viewports and states, including a narrow viewport and keyboard operation, and exercise the affected interactions. For each observation record the viewport, the interaction and the visible result, and base every acceptance statement on what you observed. Take the target from the target record the Assignment names and start none of your own. Report an inspection that was blocked or unverified; with no record named or the target down it is blocked, so the root can have Worker.operations provide one. Logic-only work with no rendered consequence needs no visual pass.

<!-- materiality -->

After a repair, repeat only the affected inspection.

Where to look:

- Web: the record's web target, through the integrated browser tools `mcp__t3-code__preview_*`: `preview_navigate`, `preview_snapshot` (accessibility tree with console and network entries), `preview_click`, `preview_type`, `preview_press`, `preview_hover`, `preview_resize` for viewports, `preview_set_appearance` for light and dark, `preview_wait_for` after navigation. Open your own tab (`reuseExistingTab=false`, then pass `tabId`) when other specialists browse in parallel.
- TUI: the terminal frames the record's capture command produces. Desktop GUI: its screenshots; use Claude's computer-use tools only when present, since T3 Code has none.
- Mobile: `mcp__t3-code__device_list`, `device_open`, `device_screenshot` and `device_close` for simulators and emulators; taps and typing go through the `agent-device` CLI that `device_open` prints. Report them as blocked when device access is not enabled.
- A self-contained HTML page you build to show something: `mcp__t3-code__html_preview` returns a PNG with console output. Use fixed pixel heights for charts, avoid `vh` units and `height:100%` (rejected), and leave html and body backgrounds unset so the theme variables apply.
- Tool names differ across T3 versions; confirm a name exists before relying on it.

Stay on the page under test: navigate only to the pages the Assignment names, use `preview_evaluate` only to inspect that page, and upload only files it names. Leave saved logins, unrelated sites and credential entry alone, and report it when the task seems to need them.
