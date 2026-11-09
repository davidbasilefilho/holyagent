# The screen capability and browser use

**Status: ships in 0.3.1.** An Assignment can carry the screen capability. Its specialist then has the tools that see and drive a screen, whatever its role, and under the Codex provider it runs on GPT-6.1 Terra. The tools belong to three capabilities of the registry ([configuration.md](configuration.md#capabilities)), split by what they drive:

| Tools                                                           | Capability     | They drive                                                                           |
| --------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `computer_use_*` (`@amaster.ai/pi-computer-use`)                | `computer-use` | Desktop applications and the browser's native chrome (tabs, address bar, dialogs)    |
| `mcp__browse__*` (opencode browse, `@opencode/browse`)          | `browser-use`  | The content of a web page in the user's real browser, with its logins and extensions |
| T3's `preview_*`, `t3_preview_*`, `html_render`, `html_preview` | `mcp`          | The page shown in T3 Code, and HTML rendered there; only where T3 hosts the session  |

T3's device tools stay with the visual roles and are not part of the screen capability. Every one of the three was already switchable on its own (`pi.features.computerUse`, `pi.features.browserUse`, `pi.features.mcp`); a capability that is off adds nothing to the grant.

## Asking for it

The draft of an Assignment takes `screen: true` (`assignment create` and `assignment dispatch`; the field is stored only when set and is shown by `assignment show --full`). The root sets it for work that has to see or drive a screen and leaves it off for everything else: `R-SCREEN` in the requirements tree, translated in every model family's `root/assignments.md`.

- **The dispatch names another agent.** For a screen Assignment it prints the role's agent with `-screen` (`worker-implementation-screen`). The package ships both files for each of the 18 specialists: the same prompt, and in the screen file the tools of the role plus the screen tools (`agents/<name>-screen.md`, and the same below `families/`). `@tintinweb/pi-subagents` takes a specialist's tools from its agent file alone, so a launch cannot grant them per call; a specialist that is not a screen specialist has none of them, and its tool list stays short. The brief of a screen Assignment says so in one line.
- **Warm reuse follows it.** A finished specialist is continued only for an Assignment with the same capability: a screen specialist never takes work without it, and the reverse. A registered specialist remembers whether it had the capability.
- **Pi only.** Under the Claude host the dispatch of a screen Assignment is refused (`InvalidDraft`: "the screen capability is available under the pi host only"), not run without the tools.
- **The extension accepts both names.** `Agent` calls and `SubagentWorkflow` scripts may name `<name>-screen`; the tool gates refuse any other agent type as before.

## The route

Under Codex a screen Assignment runs on `gpt-6.1-terra` at the higher of its row's effort and `medium`, whatever its role: a role on Luna moves to Terra (`Explorer.lookup`: Luna `low`, so Terra `medium`), and a row above `medium` keeps its effort (`Worker.debugging` stays at `xhigh`). Under Kimi the row stands, model and effort. The rule is `screenRoute` of the Codex provider profile, applied by `routeModel(config, key, { screen: true })` and printed by the dispatch like any other launch.

## Browser use: opencode browse

[opencode browse](https://github.com/anomalyco/browse) (`@opencode/browse`, MIT) is a stdio MCP server and a paired browser extension: the server drives the user's own Chromium-family browser through the extension, with Playwright code run in the visible tab. HolyAgent registers it as the MCP server `browse` for Pi at an exact pin, `@opencode/browse` in `pi-packages.json` (0.0.15), which `mise run deps:update` moves like a Pi package. It is not a Pi package: Pi installs nothing for it, and the server runs as `npx -y @opencode/browse@<pin> mcp` (Node.js 22.19 or newer, the package's `engines`).

- **Where it is registered.** Pi starts the MCP servers of every session, a child's included, so a server in `~/.pi/agent/mcp.json` would start in the root and in each of the 18 specialists. The extension instead calls `pi.registerMcpServer` at the start of a screen specialist's session only (`registerScreenServers` in `screen.ts`), and nowhere else; setup writes no file for it. The root excludes `mcp__browse__*` like the computer-use tools. A registration that fails is told to the specialist on its first run.
- **The tools** (read from the 0.0.15 package): `execute` (Playwright code in the user's tab), `status`, `settings`, `network`, `recording`, `flight_recorder`, `session_new`, `session_use`, `session_list`, `session_reset`, `session_delete`, `session_adopt`, `session_allowlist`, `tabs_cleanup` and `secrets_list`, `secrets_status`, `secrets_refresh`, `secrets_run`. Pi names them `mcp__browse__<tool>`.
- **The pairing.** The server cannot act until a browser has the extension and has been paired: `npx -y @opencode/browse@<pin> install` opens the extension's Chrome Web Store page when no browser has it and pairs the browser, and `pair` prints a one-time code to enter in the extension's options instead. Browse keeps each pairing in `browser-tokens.json` below its data folder (`OPENCODE_BROWSER_HOME`, else `$XDG_DATA_HOME/browse`, else `~/.local/share/browse`). Setup and doctor read that file (`readBrowsePairing`, `setup/browse.ts`) without starting browse and without the network, and never print a token.
- **What the report can say.** A pairing exists only once the extension connected and redeemed a code, so a paired browser means the extension is installed and paired; the line names the browser and when it was last seen. With none, browse itself cannot tell an uninstalled extension from an unpaired one before a browser connects, so the line says both and gives the way to pair. Whether a paired browser is open right now is the relay's to say (`browse status`), which starts nothing to answer and is not asked.

## Forms

Setup and doctor detect the form from the machine ([configuration.md](configuration.md#capabilities): `headless` in a cloud session, in CI and without `DISPLAY` or `WAYLAND_DISPLAY`; `normal` otherwise), and `--form` overrides it. A need that is missing is reported in the form in force, never dropped:

| Capability     | `normal`                                                                                            | `headless`                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `computer-use` | `@amaster.ai/pi-computer-use`, which needs a graphical session                                      | Not offered: it drives a graphical session and the machine has none             |
| `browser-use`  | The `browse` MCP server; needs a graphical session and `npx`; a `~` line while no browser is paired | Not offered: browse starts no browser, and the machine has no graphical session |
| `mcp`          | T3's preview tools, wherever T3 hosts the session                                                   | The same                                                                        |

- **Doctor** prints the form, then `pi capability browser-use` (`ok`, or `FAIL ... needs npx on PATH; <fix>`, or a `~` note naming the form that does not offer it), then `pi capability browser-use pairing` (`ok` with the paired browsers, or a `~` line with the way to pair one). No pairing fails nothing: a machine is in that state until the person adds the extension to a browser.
- **Setup** changes nothing for browse and prints the same facts in its `browser-use:` lines: the form, the server the extension registers, each need that is unmet, and the pairing.
- **A screen Assignment on a machine that lacks a tool** still gets the tools that exist; the brief tells the specialist to report one that is missing instead of working around it.

### Cloud and headless Linux

Read from the 0.0.15 package source, not run:

- Browse launches no browser. `executablePath` is among the options its `execute` refuses, and the word `headless` appears nowhere in the package's `dist`. Every browser tool needs a browser that has the extension and is paired, so on a machine with no graphical session and no browser browse has nothing to drive.
- `browse mcp` itself starts without a display (it is plain Node, 22.19 or newer), and the tools answer with the pairing's next step while no browser is connected.
- For a browser on another computer the package has a path, `install --remote` with `set hostname 0.0.0.0` (the relay then accepts browsers of other computers after a pairing code). Whether that works from a cloud or CI session, and what it exposes there, is **not confirmed**: HolyAgent does not set it up and does not offer the capability in the headless form.
- The Intent's headless form for screen work, a headless Playwright Chromium, is **not built**: it would add a dependency (an MCP server for Playwright) that no pin of the repository holds yet.

## What is not confirmed

Nothing here started Pi, a browser, the browse server or T3 Code. Not confirmed: that a server registered from `session_start` of a child connects before the child's first call (the Pi documentation says a server registered after load connects right away), that `npx` finds or downloads the package inside a child on a machine with a cold cache within the server's timeout, and the behavior of a browse auto-update (`OPENCODE_BROWSER_AUTO_UPDATE`) under an `npx` run.
