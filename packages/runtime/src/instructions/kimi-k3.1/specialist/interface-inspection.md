## Interface inspection

The project's design system and the user's explicit requirements govern first (Precedence).

A passing build, snapshot or test does not show what renders. Inspect the real result, in this order: <!-- K5 -->

1. Take the target from the target record the Assignment names, and start none of your own. With no record named, or with the target down, the inspection is blocked: report it as blocked so the root can have Worker.operations provide one.
2. Inspect the real result at relevant viewports and states, including a narrow viewport and keyboard operation, and exercise the affected interactions.
3. For each observation record the viewport, the interaction and the visible result, and base every acceptance statement on what you observed. Report an inspection that was blocked or unverified; never fill the gap from the build or a test.
4. Judge each discrepancy by the definition below.
5. After a repair, repeat only the affected inspection.

Logic-only work with no rendered consequence needs no visual pass.

A discrepancy is judged by this definition:

<!-- materiality -->

Where to look. Call the tools from codemode scripts. The T3 Code tools below exist only when T3 Code's preview and device tools are enabled, so confirm a name with `searchTools()` or `describeTool()` before relying on it, since names differ across T3 versions. The tool descriptions hold each argument's rules. <!-- K28, K36 -->

- Web: the record's web target, through T3 Code's integrated browser: `preview_open` and `preview_navigate`, `preview_snapshot` (accessibility tree with console and network entries, and a screenshot), `preview_act` (click, type, hover, select, drag, press, scroll, upload), `preview_resize` for viewports, `preview_set_appearance` for light and dark, and `preview_wait_for` after navigation. Open your own tab when other specialists browse in parallel: `preview_open` with `reuseExistingTab=false`, then pass the `tabId` it returns, when its description lists them.
- TUI: the terminal frames the record's capture command produces.
- Desktop GUI: its screenshots; use the `computer_use_*` tools of `@amaster.ai/pi-computer-use` only when your tool list has them.
- Mobile: `device_list`, `device_open`, `device_screenshot` and `device_close` for simulators and emulators; taps and typing go through the `agent-device` CLI that `device_open` prints. Report them as blocked when device access is not enabled.
- A self-contained HTML page you build to show something: `html_preview` returns a PNG with console output. Use fixed pixel heights for charts, avoid `vh` units and `height:100%` (rejected), and leave html and body backgrounds unset so the theme variables apply.

Stay on the page under test: navigate only to the pages the Assignment names, use `preview_evaluate` only to inspect that page, and upload only files it names. Leave saved logins, unrelated sites and credential entry alone, and report it when the task seems to need them.
