import { Effect } from "effect"

import {
  BROWSER_SERVER_COMMAND,
  BROWSER_USE_MCP_SERVER,
  CHROMIUM_FIX,
} from "../config/capabilities.ts"
import { liveHost, runBrowserServer } from "../pi/browser-launch.ts"
import { findChromium } from "../setup/chromium.ts"
import { type Command, Verbatim } from "./types.ts"

/**
 * The `browser-server` command: runs the browser-use MCP server of the headless screen capability
 * against a headless Chromium it starts. The Pi extension registers this command, not the server,
 * since Pi's MCP configuration takes a fixed command and the Chromium has to exist, with its own
 * port and profile, before the server starts and be gone after it ends.
 */
export const BROWSER_SERVER_COMMANDS: ReadonlyArray<Command> = [
  {
    path: [BROWSER_SERVER_COMMAND],
    usage: BROWSER_SERVER_COMMAND,
    summary:
      "Run the headless screen capability's browser-use MCP server against a headless Chromium this command starts, then remove the Chromium and its temporary directories",
    notes: [
      "stdin, stdout and stderr are the MCP server's own, so a host runs this command as a stdio MCP server; the exit code is the server's",
      "the server is `uvx` at the pin of pypi-packages.json with no uv config and the public PyPI index (see docs/pi/screen.md); telemetry is off and its state is temporary",
    ],
    flags: {},
    stateless: true,
    positionals: 0,
    run: (call) =>
      runBrowserServer(liveHost, {
        env: call.env,
        chromium: findChromium(call.env),
        chromiumFix: CHROMIUM_FIX,
        server: BROWSER_USE_MCP_SERVER,
      }).pipe(Effect.map((code) => new Verbatim("", "", code))),
  },
]
