# The screen capability and browser use

**Status: ships in 0.3.1.** An Assignment can carry the screen capability. Its specialist then has the tools that see and drive a screen, whatever its role, and under the Codex provider it runs on GPT-6.1 Terra. The tools belong to three capabilities of the registry ([configuration.md](configuration.md#capabilities)), split by what they drive, and the browser tools differ by the form of the machine ([Forms](#forms)):

| Tools                                                           | Capability     | They drive                                                                                      | Form          |
| --------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------- | ------------- |
| `computer_use_*` (`@amaster.ai/pi-computer-use`)                | `computer-use` | Desktop applications and the browser's native chrome (tabs, address bar, dialogs)               | `normal` only |
| `mcp__browse__*` (opencode browse, `@opencode/browse`)          | `browser-use`  | The content of a web page in the user's real browser, with its logins and extensions            | `normal`      |
| `mcp__playwright__browser_*` (`@playwright/mcp`)                | `browser-use`  | A headless Chromium of its own with an isolated, in-memory profile; no desktop, no real browser | `headless`    |
| T3's `preview_*`, `t3_preview_*`, `html_render`, `html_preview` | `mcp`          | The page shown in T3 Code, and HTML rendered there; only where T3 hosts the session             | both          |

T3's device tools stay with the visual roles and are not part of the screen capability. Every one of the three was already switchable on its own (`pi.features.computerUse`, `pi.features.browserUse`, `pi.features.mcp`); a capability that is off adds nothing to the grant. The MCP servers run in Pi's built-in MCP extension, so with `pi.features.mcp` off no server is registered and no `mcp__` tool is granted, in either form; setup and doctor say so ([Reported states](#reported-states)).

## Asking for it

The draft of an Assignment takes `screen: true` (`assignment create` and `assignment dispatch`; the field is stored only when set and is shown by `assignment show --full`). The root sets it for work that has to see or drive a screen and leaves it off for everything else: `R-SCREEN` in the requirements tree, translated in every model family's `root/assignments.md`.

- **The dispatch names another agent.** For a screen Assignment it prints the role's agent with `-screen` on a machine with a graphical session (`worker-implementation-screen`) and with `-headless-screen` on a headless one (`worker-implementation-headless-screen`), the form detected from the environment of the command ([Forms](#forms)). The package ships three files for each of the 18 specialists: the role's own, and the two screen files with the same prompt and the screen tools of their form added to the role's (`agents/<name>-screen.md`, `agents/<name>-headless-screen.md`, and the same below `families/`). `@tintinweb/pi-subagents` takes a specialist's tools from its agent file alone, so a launch cannot grant them per call; a specialist that is not a screen specialist has none of them, and its tool list stays short. The brief of a screen Assignment says so in one line.
- **A headless specialist is told what it has.** The brief's line says the machine is headless, the specialist has a headless browser (the `mcp__playwright__browser_*` tools, an isolated profile) and no desktop, and the headless prompt ends with the same note. Its file lists the Playwright tools and T3's preview tools and none of the computer-use or browse tools, not even for the visual roles, whose ordinary files have computer use.
- **The launch is checked against the Assignment.** `recordLaunch` refuses a launch whose agent type is not one the Assignment was dispatched to: a screen Assignment started as an agent without the screen tools, and a plain Assignment started as a screen agent (`AgentMismatch`); either form's screen agent is accepted for a screen Assignment, since the form is the machine's. The check runs where the launch carries its agent type (the Claude hook); Pi's `assignment record` carries none, so on Pi the dispatch and the extension's agent gate are what keep a launch to the printed agent.
- **Warm reuse follows it.** A finished specialist is continued only for an Assignment with the same capability: a screen specialist never takes work without it, and the reverse. A registered specialist remembers whether it had the capability.
- **Pi only.** Under the Claude host the dispatch of a screen Assignment is refused (`InvalidDraft`: "the screen capability is available under the pi host only"), not run without the tools.
- **The extension accepts all three names.** `Agent` calls and `SubagentWorkflow` scripts may name `<name>`, `<name>-screen` or `<name>-headless-screen`; the tool gates refuse any other agent type as before.
- **T3's preview tools need T3.** A screen specialist's `tool_call` of a T3 preview or render tool is refused unless T3 hosts the session (`isT3Session`: Pi's RPC mode with T3's environment), also where the names are registered, for example by a T3 MCP server added by hand. Under T3 they are granted as above.

## The route

Under Codex a screen Assignment runs on `gpt-6.1-terra` at the higher of its row's effort and `medium`, whatever its role: a role on Luna moves to Terra (`Explorer.lookup`: Luna `low`, so Terra `medium`), and a row above `medium` keeps its effort (`Worker.debugging` stays at `xhigh`). Under Kimi the row stands, model and effort. The rule is `screenRoute` of the Codex provider profile, applied by `routeModel(config, key, { screen: true })` and printed by the dispatch like any other launch. The form does not change it.

## The MCP servers and their pins

Both servers are registered by the extension with `pi.registerMcpServer` at the start of a screen specialist's session only (`registerScreenServers` in `screen.ts`), and nowhere else: Pi starts the servers of every session, a child's included, so a server in `~/.pi/agent/mcp.json` would start in the root and in each of the 18 specialists. Setup writes no file for either. The root excludes `mcp__browse__*`, `mcp__playwright__browser_*` and the computer-use tools. A registration that fails, or none because browser use or the MCP extension is off, is told to the specialist on its first run, so it reports the missing tools instead of working around them.

Neither is a Pi package: Pi installs nothing for them. Each runs as `npx` at an exact pin of `pi-packages.json`, which `mise run deps:update` moves like a Pi package and `mise run deps:check` checks.

**The public registry is passed explicitly.** Every launch is `npx --registry=https://registry.npmjs.org/ --@<scope>:registry=https://registry.npmjs.org/ -y <package>@<pin> ...` (`npxServerArgs` in `capabilities.ts`). npm reads the `.npmrc` of the project it runs in, and a scope's own `@scope:registry` line outranks the plain `registry`, so both are set: a repository's `.npmrc` cannot redirect where the code of a server with browser or desktop control comes from. A test holds every server of the registry to it.

### Normal: opencode browse

[opencode browse](https://github.com/anomalyco/browse) (`@opencode/browse`, MIT, pinned at `0.0.15`) is a stdio MCP server and a paired browser extension: the server drives the user's own Chromium-family browser through the extension, with Playwright code run in the visible tab. It runs as `npx ... @opencode/browse@0.0.15 mcp` and needs Node.js 22.19 or newer (the package's `engines`).

- **The tools** (read from the 0.0.15 package): `execute` (Playwright code in the user's tab), `status`, `settings`, `network`, `recording`, `flight_recorder`, `session_new`, `session_use`, `session_list`, `session_reset`, `session_delete`, `session_adopt`, `session_allowlist`, `tabs_cleanup` and `secrets_list`, `secrets_status`, `secrets_refresh`, `secrets_run`. Pi names them `mcp__browse__<tool>`.
- **The pairing.** The server cannot act until a browser has the extension and has been paired: `npx -y @opencode/browse@<pin> install` opens the extension's Chrome Web Store page when no browser has it and pairs the browser, and `pair` prints a one-time code to enter in the extension's options instead. Browse keeps each pairing in `browser-tokens.json` below its data folder (`OPENCODE_BROWSER_HOME`, else `$XDG_DATA_HOME/browse`, else `~/.local/share/browse`).
- **It starts no browser.** `executablePath` is among the options its `execute` refuses, so on a machine with no graphical session and no browser it has nothing to drive: that is why the headless form is not browse.

### Headless: the Playwright MCP server

[`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) (Apache-2.0, pinned at `0.0.85`, the `latest` release when it was chosen; Node.js 18 or newer) is Microsoft's MCP server for Playwright. HolyAgent launches it as

```
npx --registry=https://registry.npmjs.org/ --@playwright:registry=https://registry.npmjs.org/ -y @playwright/mcp@0.0.85 --headless --isolated --browser chromium [--executable-path <chromium>]
```

- `--headless` runs the browser with no window, `--isolated` keeps the profile in memory and writes nothing to disk, and `--browser chromium` picks Chromium (flags read from the package's README at that pin; no browser was started against any site to choose them).
- **The Chromium the environment provides.** When the machine has one preinstalled, its path is passed as `--executable-path` (`findChromium`, `setup/chromium.ts`): the path in `PLAYWRIGHT_MCP_EXECUTABLE_PATH` when the person set one; else the `chromium` entry or the newest `chromium-<revision>` build in `PLAYWRIGHT_BROWSERS_PATH` when it names a folder (Playwright looks nowhere else then), else in `/opt/pw-browsers`, where cloud images put it (`/opt/pw-browsers/chromium`). With none, the flag is left out and the server uses the browser Playwright installs for itself.
- **The tools** (the default set at that pin; the `--caps` groups are not enabled): `browser_navigate`, `browser_navigate_back`, `browser_snapshot`, `browser_take_screenshot`, `browser_click`, `browser_hover`, `browser_drag`, `browser_drop`, `browser_type`, `browser_press_key`, `browser_fill_form`, `browser_select_option`, `browser_file_upload`, `browser_handle_dialog`, `browser_find`, `browser_evaluate`, `browser_run_code_unsafe`, `browser_wait_for`, `browser_resize`, `browser_emulate_media`, `browser_console_messages`, `browser_network_request`, `browser_network_requests`, `browser_tabs` and `browser_close`. Pi names them `mcp__playwright__<tool>`; the agent files grant them as the pattern `mcp__playwright__browser_*`.

## Forms

Setup and doctor detect the form from the machine ([configuration.md](configuration.md#capabilities): `headless` in a cloud session, in CI and without `DISPLAY` or `WAYLAND_DISPLAY`; `normal` otherwise), and `--form` overrides it; the dispatch detects it the same way from its own environment, so the agent it names is the form's. A need that is missing is reported in the form in force, never dropped:

| Capability     | `normal`                                                                                                  | `headless`                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `computer-use` | `@amaster.ai/pi-computer-use`, which needs a graphical session                                            | Not offered: it drives a graphical session and the machine has none                      |
| `browser-use`  | The `browse` MCP server; needs a graphical session, `npx` and Node.js 22.19 or newer; reports the pairing | The `playwright` MCP server; needs `npx` and Node.js 18 or newer; no display, no pairing |
| `mcp`          | T3's preview tools, where T3 hosts the session                                                            | The same                                                                                 |

A screen specialist takes its form from the agent file it was launched as, so its servers and its tools agree.

### Reported states

- **Doctor** prints the form, then `pi capability browser-use` (`ok`, or `FAIL ...` naming each unmet need and its fix, or a `~` note when the form does not offer a capability), then, in the normal form, `pi capability browser-use pairing`:
  - `ok` with the paired browsers (the extension is installed and paired);
  - `~` **installed, not paired**: the extension is in a browser's profile but nothing is paired, with `pair` as the next step;
  - `~` **not installed**: no scanned browser has the extension and nothing is paired, with `install` (the Web Store page) as the next step;
  - `FAIL` when the pairing file cannot be read.

  Neither `~` fails doctor: a machine is in that state until the person adds the extension. Installed and not installed are told apart the way browse's own setup does, by reading the `Secure Preferences` and `Preferences` of each profile of the Chromium-family browsers it knows (Chrome and its channels, Chromium, Edge, Brave, Opera, Vivaldi, and Arc on macOS) for the extension's id; a browser outside that list is not scanned, and the line names the ones that were. Nothing is started and nothing is written.

- **The Node.js need** runs `node --version` and compares it with the form's minimum: 22.19.0 for browse (its `engines`), 18.0.0 for Playwright. An older or silent `node` is a `FAIL` line with the fix.
- **With `pi.features.mcp` off** doctor prints `~ pi capability browser-use: pi.features.mcp is off, so the MCP server is not registered and screen specialists get none of its tools`, and setup's line says the same instead of listing a server; the specialist is told on its first run. It is a note, not a failure.
- **Setup** changes nothing for browser use and prints the same facts in its `browser-use:` lines: the form, the server the extension registers, each need that is unmet, in the headless form the Chromium that will be used, and in the normal form the pairing state above. A pairing file that cannot be read is one `~` line there (`cannot tell whether a browser is paired: ...`), so it never fails the step; doctor fails on it.
- **A screen Assignment on a machine that lacks a tool** still gets the tools that exist; the brief tells the specialist to report one that is missing instead of working around it.

## What is not confirmed

Nothing here started Pi, a browser, either server or T3 Code. Not confirmed: that a server registered from `session_start` of a child connects before the child's first call (the Pi documentation says a server registered after load connects right away); that `npx` finds or downloads the package inside a child on a machine with a cold cache within the server's timeout; that `--browser chromium` with `--executable-path` launches the preinstalled Chromium of a cloud image (the flags are read from the README, as the pin's package cannot be run here without starting a browser); the behavior of a browse auto-update (`OPENCODE_BROWSER_AUTO_UPDATE`) under an `npx` run; and, for a project whose `node_modules` already holds a package of that name, that `npx` takes the registry's copy over the local one (the registry flags settle where a download comes from, not which copy `npx` prefers).
