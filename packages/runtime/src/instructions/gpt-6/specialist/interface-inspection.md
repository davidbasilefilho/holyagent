## Interface inspection

The project's design system and the user's explicit requirements govern first (Precedence).

A passing build, snapshot or test does not show what renders. Inspect the real result:

- Take the target from the target record the Assignment names, and start none of your own. With no record named, or with the target down, the inspection is blocked: report it as blocked so the root can have Worker.operations provide one.
- Inspect at relevant viewports and states, including a narrow viewport and keyboard operation, and exercise the affected interactions.
- For each observation record the viewport, the interaction and the visible result, and base every acceptance statement on what you observed. Report an inspection that was blocked or unverified; never fill the gap from the build or a test.
- Judge each discrepancy by the definition below, and after a repair repeat only the affected inspection. <!-- O2: outcomes and boundaries, with no fixed itinerary. -->

Logic-only work with no rendered consequence needs no visual pass.

A discrepancy is judged by this definition:

<!-- materiality -->

Where to look. Use the browser, preview, screenshot and device tools the host provides, and confirm a tool's name from the tool list before relying on it, since names differ across hosts. The tool descriptions hold each argument's rules.

- Web: the record's web target in a browser tool: navigate, snapshot (the accessibility tree with console and network entries), act (click, type, hover, select, press, scroll), resize for viewports, light and dark appearance, and a wait after navigation. Open your own tab when other specialists browse in parallel.
- TUI: the terminal frames the record's capture command produces.
- Desktop GUI: its screenshots, through a computer-use tool only when your tool list has one.
- Mobile: the simulator or emulator screenshot tools the host provides, with taps and typing through the `agent-device` CLI. Report them as blocked when device access is not enabled.
- A self-contained HTML page you build to show something: render it to an image with the console output, use fixed pixel heights for charts, avoid `vh` units and `height:100%`, and leave html and body backgrounds unset so the theme variables apply.

Stay on the page under test: navigate only to the pages the Assignment names, evaluate script only to inspect that page, and upload only files it names. Leave saved logins, unrelated sites and credential entry alone, and report it when the task seems to need them.
