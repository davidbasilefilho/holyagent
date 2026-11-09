import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { CAPABILITIES } from "../src/config/capabilities.ts"
import {
  BROWSE_COMMAND,
  BROWSE_PAIR_FIX,
  BROWSE_VERSION,
  browseDataDirectory,
  browsePairingFile,
  describePairing,
  readBrowsePairing,
} from "../src/setup/browse.ts"
import { reportBrowserUse } from "../src/setup/browser-use.ts"
import { doctor } from "../src/setup/doctor.ts"
import { chooseForm } from "../src/setup/form.ts"
import { checkPairing } from "../src/setup/pi-check.ts"
import { setup } from "../src/setup/steps.ts"
import {
  BROWSE_LAST_SEEN_TEXT,
  fakeShell,
  scratch,
  writeBrowsePairing,
  writeCompleteSettings,
} from "./setup-fixture.ts"

let home: string
let project: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-browse-")
  home = join(made.directory, "home")
  project = join(made.directory, "project")
  await mkdir(project, { recursive: true })
  await writeCompleteSettings(join(home, ".claude"))
  remove = made.remove
})
afterEach(() => remove())

const write = async (file: string, content: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, typeof content === "string" ? content : JSON.stringify(content))
}
const setConfig = (config: unknown) => write(join(home, ".holyagent", "config.json"), config)

const TOKEN = "B".repeat(43)

const BROWSER_USE = CAPABILITIES.find((capability) => capability.name === "browser-use")
if (BROWSER_USE === undefined) throw new Error("the registry has no browser-use capability")

const shell = (commands: ReadonlyArray<string> = ["bun", "ctx7", "pi", "node", "npx"]) =>
  fakeShell({ commands })

const report = (
  form: "headless" | "normal",
  env: Record<string, string> = { DISPLAY: ":0" },
  commands?: ReadonlyArray<string>,
) =>
  Effect.runPromise(
    reportBrowserUse(
      { HOME: home, ...env },
      { scope: "user", cwd: project, dryRun: false, form },
    ).pipe(Effect.provide(shell(commands).layer)),
  )

describe("where browse keeps its pairings", () => {
  test("follows browse's own rules: its home variable, an absolute XDG_DATA_HOME, else ~/.local/share", () => {
    expect(browseDataDirectory({ HOME: "/h" })).toBe(join("/h", ".local", "share", "browse"))
    expect(browseDataDirectory({ HOME: "/h", XDG_DATA_HOME: "/data" })).toBe(
      join("/data", "browse"),
    )
    // A relative XDG_DATA_HOME is ignored, as browse ignores it.
    expect(browseDataDirectory({ HOME: "/h", XDG_DATA_HOME: "data" })).toBe(
      join("/h", ".local", "share", "browse"),
    )
    expect(browseDataDirectory({ HOME: "/h", OPENCODE_BROWSER_HOME: "/elsewhere" })).toBe(
      "/elsewhere",
    )
    expect(browseDataDirectory({ HOME: "/h", OPENCODE_BROWSER_HOME: "" })).toBe(
      join("/h", ".local", "share", "browse"),
    )
    expect(browsePairingFile({ HOME: "/h" })).toBe(
      join("/h", ".local", "share", "browse", "browser-tokens.json"),
    )
  })

  test("the pinned release is the one the commands name", () => {
    expect(BROWSE_VERSION).toBe("0.0.15")
    expect(BROWSE_COMMAND).toBe("npx -y @opencode/browse@0.0.15")
    expect(BROWSE_PAIR_FIX).toContain(`${BROWSE_COMMAND} install`)
    expect(BROWSE_PAIR_FIX).toContain(`${BROWSE_COMMAND} pair`)
  })
})

describe("reading the browsers paired with browse", () => {
  const read = () => Effect.runPromise(readBrowsePairing({ HOME: home }))

  test("no file, an empty file and a file that is not an object are no pairing", async () => {
    expect(await read()).toEqual({ state: "unpaired" })
    await write(browsePairingFile({ HOME: home }), "")
    expect(await read()).toEqual({ state: "unpaired" })
    await write(browsePairingFile({ HOME: home }), "not json")
    expect(await read()).toEqual({ state: "unpaired" })
    await write(browsePairingFile({ HOME: home }), "[1, 2]")
    expect(await read()).toEqual({ state: "unpaired" })
  })

  test("an entry browse itself would drop (no valid token) is not a pairing", async () => {
    await write(browsePairingFile({ HOME: home }), {
      short: { token: "too-short", name: "Chrome" },
      none: { name: "Edge" },
      scalar: 3,
    })
    expect(await read()).toEqual({ state: "unpaired" })
  })

  test("a pairing is a browser with its profile key, and its name and last sighting once it connected", async () => {
    await write(browsePairingFile({ HOME: home }), {
      Default: { token: TOKEN, pairedAt: 1, extra: "kept by browse" },
      "Profile 1": { token: TOKEN, lastSeen: 1_700_000_000_000, id: "edge-desk", name: "Edge" },
    })
    const found = await read()
    expect(found).toEqual({
      state: "paired",
      browsers: [
        { key: "Default" },
        { key: "Profile 1", id: "edge-desk", name: "Edge", lastSeen: 1_700_000_000_000 },
      ],
    })
    expect(JSON.stringify(found)).not.toContain(TOKEN)
    expect(describePairing(found)).toBe(
      `2 browsers paired with browse (the extension is installed): Default, not connected yet; Edge, last seen ${BROWSE_LAST_SEEN_TEXT}`,
    )
  })

  test("a file that cannot be read is a failure that names it, not a pairing", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return
    const file = browsePairingFile({ HOME: home })
    await write(file, "{}")
    await chmod(file, 0o000)
    try {
      const error = await Effect.runPromise(Effect.flip(readBrowsePairing({ HOME: home })))
      expect(error._tag).toBe("SetupFailure")
      expect(error.message).toContain(file)
    } finally {
      await chmod(file, 0o600)
    }
  })

  test("says plainly that no pairing leaves the extension's install unknown", () => {
    expect(describePairing({ state: "unpaired" })).toBe(
      "no browser is paired with browse (the extension is not installed or not paired; browse cannot tell which)",
    )
  })
})

describe("doctor's line on browse's pairing", () => {
  const check = (form: "headless" | "normal", platform?: string) =>
    Effect.runPromise(checkPairing({ HOME: home }, BROWSER_USE, form, platform))

  test("a paired browser is an ok line naming it", async () => {
    await writeBrowsePairing(home)
    expect(await check("normal")).toEqual([
      `ok   pi capability browser-use pairing: 1 browser paired with browse (the extension is installed): Chrome, last seen ${BROWSE_LAST_SEEN_TEXT}`,
    ])
  })

  test("no browser is a hint with the way to pair one, not a failure", async () => {
    const [line, ...rest] = await check("normal")
    expect(rest).toEqual([])
    expect(line).toStartWith(
      "~ pi capability browser-use pairing: no browser is paired with browse",
    )
    expect(line).toContain(BROWSE_PAIR_FIX)
  })

  test("the headless form has no pairing line, since the capability is not offered there", async () => {
    expect(await check("headless")).toEqual([])
  })

  test("a capability without the probe has none", async () => {
    const todo = CAPABILITIES.filter((capability) => capability.name === "todo")
    expect(todo).toHaveLength(1)
    for (const capability of todo) {
      expect(capability.health).not.toContain("pairing")
      expect(await Effect.runPromise(checkPairing({ HOME: home }, capability, "normal"))).toEqual(
        [],
      )
    }
  })
})

describe("holyagent doctor on browse", () => {
  const run = (form: "headless" | "normal", env: Record<string, string>, commands?: string[]) =>
    Effect.runPromise(
      doctor(
        { HOME: home, HOLYAGENT_HOST: "pi", ...env },
        { fix: false, cwd: project, scope: "user", form: chooseForm(env, form, "linux") },
      ).pipe(Effect.provide(shell(commands).layer)),
    )
  const lines = (result: { readonly lines: ReadonlyArray<string> }) =>
    result.lines.filter((line) => line.includes("browser-use"))

  test("normal form: the capability line, then the pairing line", async () => {
    await writeBrowsePairing(home)
    const result = await run("normal", { DISPLAY: ":0" })
    expect(lines(result)).toEqual([
      "ok   pi capability browser-use: normal form, specialists, nothing to install",
      `ok   pi capability browser-use pairing: 1 browser paired with browse (the extension is installed): Chrome, last seen ${BROWSE_LAST_SEEN_TEXT}`,
    ])
  })

  test("normal form without a paired browser says how to pair one and does not fail doctor", async () => {
    const [capability, pairing] = lines(await run("normal", { DISPLAY: ":0" }))
    expect(capability).toBe(
      "ok   pi capability browser-use: normal form, specialists, nothing to install",
    )
    expect(pairing).toStartWith("~ pi capability browser-use pairing: no browser is paired")
    expect(pairing).toContain(BROWSE_PAIR_FIX)
    expect(pairing).not.toStartWith("FAIL")
  })

  test("a missing npx is reported as a failing need with its fix, not dropped", async () => {
    await writeBrowsePairing(home)
    const result = await run("normal", { DISPLAY: ":0" }, ["bun", "ctx7", "pi", "node"])
    expect(lines(result)[0]).toBe(
      "FAIL pi capability browser-use: needs npx on PATH; install Node.js 22.19 or newer from https://nodejs.org, which ships npx",
    )
    expect(result.ok).toBe(false)
  })

  test("the headless form is a note that says why, and nothing is expected of it", async () => {
    const result = await run("headless", {})
    expect(lines(result)).toEqual([
      "~ pi capability browser-use: not offered in the headless form (browse drives the browser of a graphical session through its extension and starts none itself, and this machine has no graphical session); nothing is expected of it",
    ])
  })

  test("the form is detected from the machine when it is not named", async () => {
    const detect = (env: Record<string, string>) =>
      Effect.runPromise(
        doctor(
          { HOME: home, HOLYAGENT_HOST: "pi", ...env },
          { fix: false, cwd: project, scope: "user", form: chooseForm(env, undefined, "linux") },
        ).pipe(Effect.provide(shell().layer)),
      )
    expect((await detect({ DISPLAY: ":0" })).lines).toContain(
      "ok   pi form: normal (detected: a graphical session is available)",
    )
    expect((await detect({ CI: "true", DISPLAY: ":0" })).lines).toContain(
      "ok   pi form: headless (detected: CI is set)",
    )
    expect((await detect({})).lines).toContain(
      "ok   pi form: headless (detected: no DISPLAY or WAYLAND_DISPLAY is set)",
    )
  })

  test("browser use off has no line at all", async () => {
    await setConfig({ pi: { features: { browserUse: false } } })
    expect(lines(await run("normal", { DISPLAY: ":0" }))).toEqual([])
  })
})

describe("holyagent setup on browse", () => {
  const server = "npx -y @opencode/browse@0.0.15 mcp"

  test("normal form, paired: says the form, the server the extension registers and the paired browser", async () => {
    await writeBrowsePairing(home)
    expect(await report("normal")).toEqual([
      `= browser-use: normal form; the extension registers \`${server}\` for screen specialists and writes no file for it`,
      `= browser-use: 1 browser paired with browse (the extension is installed): Chrome, last seen ${BROWSE_LAST_SEEN_TEXT}`,
    ])
  })

  test("normal form, nothing paired: asks the person to install and pair the extension", async () => {
    const lines = await report("normal")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toStartWith("~ browser-use: no browser is paired with browse")
    expect(lines[1]).toContain(BROWSE_PAIR_FIX)
  })

  test("a need that is not met is reported beside the form, not dropped", async () => {
    await writeBrowsePairing(home)
    const lines = await report("normal", { DISPLAY: ":0" }, ["bun", "ctx7", "pi", "node"])
    expect(lines).toContain(
      "~ browser-use: needs npx on PATH; install Node.js 22.19 or newer from https://nodejs.org, which ships npx",
    )
    expect(lines[0]).toStartWith("= browser-use: normal form;")
  })

  test("no graphical session is reported as a need of the normal form", async () => {
    await writeBrowsePairing(home)
    const lines = await report("normal", {})
    expect(lines).toContain(
      "~ browser-use: needs a graphical session (no DISPLAY or WAYLAND_DISPLAY)",
    )
  })

  test("headless form: says it is not offered and why, and reads no pairing", async () => {
    await writeBrowsePairing(home)
    expect(await report("headless", {})).toEqual([
      "~ browser-use: not offered in the headless form (browse drives the browser of a graphical session through its extension and starts none itself, and this machine has no graphical session); screen specialists get no tools of it here",
    ])
  })

  test("the capability off, or pi.enable off, has no line", async () => {
    await setConfig({ pi: { features: { browserUse: false } } })
    expect(await report("normal")).toEqual([])
    await setConfig({ pi: { enable: false } })
    expect(await report("normal")).toEqual([])
  })

  test("the whole setup run carries the lines and writes no MCP file", async () => {
    await writeBrowsePairing(home)
    const result = await Effect.runPromise(
      setup(
        { HOME: home, HOLYAGENT_HOST: "pi", DISPLAY: ":0" },
        {
          subagentCacheTtl: "1h",
          dryRun: true,
          skipCtx7: true,
          cwd: project,
          form: chooseForm({ DISPLAY: ":0" }, "normal", "linux"),
        },
      ).pipe(Effect.provide(shell().layer)),
    )
    expect(result.lines.filter((line) => line.includes("browser-use"))).toHaveLength(2)
    expect(await Bun.file(join(home, ".pi", "agent", "mcp.json")).exists()).toBe(false)
  })
})
