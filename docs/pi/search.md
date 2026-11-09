# The find and grep tools on fff

**Status: ships in 0.3.1 as the `fff` capability (`pi.features.fff`, on by default).** Pi's `find` and `grep` tools, for the specialists, are replaced by [fff](https://github.com/dmtrKovalenko/fff) through its Pi package `@ff-labs/pi-fff` (0.11.0, MIT), an in-process Rust file finder reached through a Node binding: no `fd` or `rg` process per call, a background index, frecency ranking and a fuzzy `find`. The Claude plugin is not affected: it keeps the bundled ripgrep and fd ([decisions.md](../decisions.md)).

## The decisions

- **Override mode (Intent default, revisitable).** The package has three modes, and setup puts it in `override`: its tools then take the names of Pi's own `grep` and `find` (and add `multi_grep`), so the tool surface of every role, the instruction text that names `grep` and `find`, and the agent files' `tools:` lines stay as they are. The default mode, `tools-and-ui`, adds `fffind`, `ffgrep` and `fff-multi-grep` beside Pi's tools, which would leave two search tools per role.
- **The switch is a key of the package's own file.** Setup merges `{ "mode": "override" }` into `pi-fff.json` in Pi's agent folder (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), the one place the package reads it from: it ignores a project file, so the setting is written at user scope only, and `holyagent setup --scope project` prints a skipped line for it. A `mode` the user already set stays (`~` line, "yours wins"). `--fff-mode` and `PI_FFF_MODE` outrank the file. Turning the capability off takes the key back out by setup's record, and a key the user had set before setup stays, so a package the user installs later is not switched into override mode.
- **The root keeps its search rule.** The root searches with `holyagent rg` and `holyagent fd`, and Pi's default selection leaves `grep` and `find` out of its active tools. The package activates every tool it registers, so the root excludes `grep`, `find` and `multi_grep` while the capability is on (`rootExclude` of the registry entry): the root's tools do not change, and the specialists' `grep` and `find` are fff's. The specialists' instruction text says "the `grep` and `find` tools", true with the capability on or off.
- **Where the native library has no build, the capability is off.** `@ff-labs/fff-node` ships its library for darwin (arm64, x64), linux (arm64, x64, each glibc and musl), win32 (arm64, x64) and android (arm64). On any other host the capability is not offered, in either form: setup loads no package and writes no setting, doctor prints `~ pi capability fff: not offered ... (its native library does not cover <host>, only ...)` and fails nothing, and Pi keeps its own `find` and `grep`. A supported host whose library failed to install is not detected: the package reports the failed start as an error when the session starts, and its tools then return errors.

## Switching it

`holyagent setup --fff on|off` writes `pi.features.fff` to the config of the scope and installs or removes `@ff-labs/pi-fff` in the same run, like any other capability ([configuration.md](configuration.md#capabilities)); `off` leaves Pi's own `find` and `grep` in place. The capability has both forms, with the same package, and needs nothing of the system. `holyagent doctor` prints `pi capability fff` with its package at its pin, and a `~` line for a missing `mode` in `pi-fff.json`.

## What the package does

Read from `@ff-labs/pi-fff@0.11.0` (`README.md`, `src/index.ts`, `src/config.ts`) and `@ff-labs/fff-node@0.11.0`:

- In `override` mode it registers `grep`, `find` and `multi_grep`. A session started from `$HOME` or `/` that the package's config opts out of indexing keeps the `ffgrep` and `fffind` names, so Pi's built-ins stay reachable there. By default `$HOME` is indexed, with a warning.
- It keeps two LMDB databases (frecency and query history) under `~/.pi/agent/fff/`, or reuses an fff.nvim database if one exists.
- Not confirmed: whether each specialist, which runs as an in-process child session, starts its own index, and the root's tool exclusion when the package registers its tools after HolyAgent's session start (the extension's `tool_call` gate refuses a call to an excluded tool either way).
