import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { Effect } from "effect"

import { CAPABILITIES } from "../src/config/capabilities.ts"
import {
  BROWSE_COMMAND,
  BROWSE_EXTENSION_IDS,
  BROWSE_INSTALL_FIX,
  BROWSE_PAIR_FIX,
  BROWSE_VERSION,
  browseDataDirectory,
  browsePairingFile,
  browserDirectories,
  describeBrowseState,
  describePairing,
  findBrowseExtension,
  readBrowsePairing,
  readBrowseState,
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
// A file standing in for the Chromium executable a person configured, which has to exist.
let chromiumPath: string
let remove: () => Promise<void>

beforeEach(async () => {
  const made = await scratch("holyagent-browse-")
  home = join(made.directory, "home")
  project = join(made.directory, "project")
  await mkdir(project, { recursive: true })
  await writeCompleteSettings(join(home, ".claude"))
  chromiumPath = join(made.directory, "chromium")
  await writeFile(chromiumPath, "")
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

// `node --version` answers with `node`, which the capability's Node.js need reads.
const shell = (
  commands: ReadonlyArray<string> = ["bun", "ctx7", "pi", "node", "npx", "uvx"],
  node: string = "v22.19.0",
) =>
  fakeShell({
    commands,
    respond: (line) => (line === "node --version" ? { stdout: `${node}\n` } : undefined),
  })

const report = (
  form: "headless" | "normal",
  env: Record<string, string> = { DISPLAY: ":0" },
  commands?: ReadonlyArray<string>,
  node?: string,
  platform?: string,
) =>
  Effect.runPromise(
    reportBrowserUse(
      { HOME: home, ...env },
      { scope: "user", cwd: project, dryRun: false, form },
      platform,
    ).pipe(Effect.provide(shell(commands, node).layer)),
  )

// A data folder whose name no file system can open: reading the pairing file in it fails, for every
// user on every platform, which a mode bit would not do for root.
const UNREADABLE = { OPENCODE_BROWSER_HOME: "/holyagent-unreadable\0browse" }

// A browser profile that has the browse extension, in the folder the scan reads on this platform.
const installExtension = async (options: { readonly disabled?: boolean } = {}) => {
  const [chrome] = browserDirectories({ HOME: home })
  if (chrome === undefined) throw new Error("no browser directories")
  await write(join(chrome.directory, "Local State"), {
    profile: { info_cache: { "Profile 1": { name: "Work" } } },
  })
  await write(join(chrome.directory, "Profile 1", "Preferences"), {
    extensions: {
      settings: {
        [BROWSE_EXTENSION_IDS[0] ?? ""]: options.disabled === true ? { disable_reasons: [1] } : {},
      },
    },
  })
  return chrome.directory
}

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
    expect(BROWSE_VERSION).toBe("0.0.16")
    expect(BROWSE_COMMAND).toBe("npx -y @opencode/browse@0.0.16")
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

describe("finding the browse extension in the browsers' profiles", () => {
  test("lists the user-data folders of the browsers browse sets up, per platform", () => {
    const linux = browserDirectories({ HOME: "/h" }, "linux")
    expect(linux[0]).toEqual({
      name: "Google Chrome",
      directory: join("/h", ".config", "google-chrome"),
    })
    expect(browserDirectories({ HOME: "/h", XDG_CONFIG_HOME: "/cfg" }, "linux")[3]).toEqual({
      name: "Chromium",
      directory: join("/cfg", "chromium"),
    })
    expect(browserDirectories({ HOME: "/h" }, "darwin")[0]?.directory).toBe(
      join("/h", "Library", "Application Support", "Google", "Chrome"),
    )
    expect(browserDirectories({ HOME: "/h", LOCALAPPDATA: "/local" }, "win32")[1]?.directory).toBe(
      join("/local", "Microsoft", "Edge", "User Data"),
    )
  })

  test("finds the store extension or the unpacked build in a profile, enabled or not", async () => {
    expect(await Effect.runPromise(findBrowseExtension({ HOME: home }))).toEqual([])
    await installExtension()
    expect(await Effect.runPromise(findBrowseExtension({ HOME: home }))).toEqual([
      { browser: "Google Chrome", profile: "Profile 1", enabled: true },
    ])
    await installExtension({ disabled: true })
    expect(await Effect.runPromise(findBrowseExtension({ HOME: home }))).toEqual([
      { browser: "Google Chrome", profile: "Profile 1", enabled: false },
    ])
  })

  test("a profile with other extensions, or files that are not JSON, shows nothing", async () => {
    const [chrome] = browserDirectories({ HOME: home })
    const directory = chrome?.directory ?? ""
    await write(join(directory, "Local State"), "not json")
    await write(join(directory, "Default", "Preferences"), {
      extensions: { settings: { abcdefghijklmnopabcdefghijklmnop: {} } },
    })
    await write(join(directory, "Default", "Secure Preferences"), "{ broken")
    expect(await Effect.runPromise(findBrowseExtension({ HOME: home }))).toEqual([])
  })

  test("the state is paired with a pairing, installed with only the extension, else missing", async () => {
    const state = () => Effect.runPromise(readBrowseState({ HOME: home }))
    expect(await state()).toMatchObject({ state: "missing" })
    await installExtension()
    expect(await state()).toMatchObject({ state: "installed" })
    await writeBrowsePairing(home)
    expect(await state()).toMatchObject({ state: "paired" })
    const missing = describeBrowseState({ state: "missing", scanned: ["Google Chrome", "Brave"] })
    expect(missing.text).toBe(
      "the browse extension is not installed in any browser this check scans (Google Chrome, Brave) and no browser is paired with browse",
    )
    expect(missing.fix).toBe(BROWSE_INSTALL_FIX)
  })
})

describe("doctor's line on browse's pairing", () => {
  const check = (
    form: "headless" | "normal",
    platform?: string,
    env: Record<string, string> = {},
  ) => Effect.runPromise(checkPairing({ HOME: home, ...env }, BROWSER_USE, form, platform))

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
      "~ pi capability browser-use pairing: the browse extension is not installed in any browser",
    )
    expect(line).toContain(BROWSE_INSTALL_FIX)
  })

  test("an installed extension that is not paired is told apart from one that is not installed", async () => {
    const [missing] = await check("normal")
    expect(missing).toContain("is not installed in any browser this check scans")
    expect(missing).toContain(BROWSE_INSTALL_FIX)
    await installExtension()
    const [installed, ...rest] = await check("normal")
    expect(rest).toEqual([])
    expect(installed).toStartWith(
      "~ pi capability browser-use pairing: the browse extension is installed (Google Chrome, profile Profile 1) but no browser is paired with browse",
    )
    expect(installed).toContain(BROWSE_PAIR_FIX)
    expect(installed).not.toContain("not installed")
    expect(installed).not.toStartWith("FAIL")
  })

  test("a pairing file that cannot be read is a FAIL line that names it", async () => {
    const env = UNREADABLE
    const [line, ...rest] = await check("normal", undefined, env)
    expect(rest).toEqual([])
    expect(line).toStartWith("FAIL pi capability browser-use pairing: cannot read")
    expect(line).toContain(browsePairingFile({ HOME: home, ...env }))
  })

  test("the headless form has no pairing line: it drives no paired browser", async () => {
    expect(await check("headless")).toEqual([])
  })

  test("a form without the pairing flag has none, nor has a capability without a server", async () => {
    const todo = CAPABILITIES.filter((capability) => capability.name === "todo")
    expect(todo).toHaveLength(1)
    for (const capability of todo)
      expect(await Effect.runPromise(checkPairing({ HOME: home }, capability, "normal"))).toEqual(
        [],
      )
  })
})

describe("holyagent doctor on browse", () => {
  const run = (
    form: "headless" | "normal",
    env: Record<string, string>,
    commands?: string[],
    node?: string,
  ) =>
    Effect.runPromise(
      doctor(
        { HOME: home, HOLYAGENT_HOST: "pi", ...env },
        { fix: false, cwd: project, scope: "user", form: chooseForm(env, form, "linux") },
      ).pipe(Effect.provide(shell(commands, node).layer)),
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
    expect(pairing).toStartWith(
      "~ pi capability browser-use pairing: the browse extension is not installed in any browser",
    )
    expect(pairing).toContain(BROWSE_INSTALL_FIX)
    expect(pairing).not.toStartWith("FAIL")
  })

  test("a missing npx is reported as a failing need with its fix, not dropped", async () => {
    await writeBrowsePairing(home)
    const result = await run("normal", { DISPLAY: ":0" }, ["bun", "ctx7", "pi", "node"])
    expect(lines(result)[0]).toBe(
      "FAIL pi capability browser-use: needs npx on PATH; install Node.js from https://nodejs.org, which ships npx",
    )
    expect(result.ok).toBe(false)
  })

  test("a node older than browse's 22.19 is a failing need, and 22.19 itself is fine", async () => {
    const old = await run("normal", { DISPLAY: ":0" }, undefined, "v22.18.9")
    expect(lines(old)[0]).toStartWith(
      "FAIL pi capability browser-use: needs Node.js 22.19.0 or newer, but /fake/bin/node is 22.18.9;",
    )
    expect(old.ok).toBe(false)
    const exact = await run("normal", { DISPLAY: ":0" }, undefined, "v22.19.0")
    expect(lines(exact)[0]).toStartWith("ok   pi capability browser-use: normal form")
    const silent = await run("normal", { DISPLAY: ":0" }, undefined, "hello")
    expect(lines(silent)[0]).toContain("did not report a version for --version")
  })

  test("the headless form is offered: the browser-use server, needing uvx and a Chromium and no node, npx or display", async () => {
    const chromium = { HOLYAGENT_CHROMIUM_PATH: chromiumPath }
    const ok = await run("headless", chromium, ["bun", "ctx7", "pi", "uvx"])
    expect(lines(ok)).toEqual([
      "ok   pi capability browser-use: headless form, specialists, nothing to install",
    ])
  })

  test("a missing uvx is a failing need with its fix, and so is a missing Chromium", async () => {
    const chromium = { HOLYAGENT_CHROMIUM_PATH: chromiumPath }
    const noUvx = await run("headless", chromium, ["bun", "ctx7", "pi", "node", "npx"])
    expect(lines(noUvx)[0]).toBe(
      "FAIL pi capability browser-use: needs uvx on PATH; install uv from https://docs.astral.sh/uv/, which ships uvx and provides the Python 3.11 or newer that browser-use needs",
    )
    expect(noUvx.ok).toBe(false)
    const noChromium = await run("headless", { PLAYWRIGHT_BROWSERS_PATH: join(home, "none") })
    expect(lines(noChromium)[0]).toStartWith(
      "FAIL pi capability browser-use: needs a Chromium; set HOLYAGENT_CHROMIUM_PATH to a Chromium executable",
    )
    expect(noChromium.ok).toBe(false)
    // Neither is a need of the normal form.
    const normal = await run("normal", { DISPLAY: ":0" }, ["bun", "ctx7", "pi", "node", "npx"])
    expect(lines(normal)[0]).toStartWith("ok   pi capability browser-use: normal form")
  })

  test("a configured Chromium path that does not exist is a failing need that names it, under the old variable too", async () => {
    const missing = join(home, "no", "chromium")
    for (const variable of ["HOLYAGENT_CHROMIUM_PATH", "PLAYWRIGHT_MCP_EXECUTABLE_PATH"]) {
      const report = await run("headless", { [variable]: missing })
      expect(lines(report)[0]).toStartWith(
        `FAIL pi capability browser-use: needs a Chromium; ${variable} is set to ${missing}, which does not exist; set HOLYAGENT_CHROMIUM_PATH to a Chromium executable`,
      )
      expect(report.ok).toBe(false)
    }
    const legacy = await run("headless", { PLAYWRIGHT_MCP_EXECUTABLE_PATH: chromiumPath })
    expect(lines(legacy)[0]).toStartWith("ok   pi capability browser-use: headless form")
  })

  test("with the MCP extension off the servers are not registered, and doctor says so", async () => {
    await setConfig({ pi: { features: { mcp: false } } })
    const normal = await run("normal", { DISPLAY: ":0" })
    expect(lines(normal)).toContain(
      "~ pi capability browser-use: pi.features.mcp is off, so the MCP server is not registered and screen specialists get none of its tools",
    )
    const headless = await run("headless", { HOLYAGENT_CHROMIUM_PATH: chromiumPath })
    expect(lines(headless)).toContain(
      "~ pi capability browser-use: pi.features.mcp is off, so the MCP server is not registered and screen specialists get none of its tools",
    )
    // A note, not a failure: the person switched the extension off.
    expect([...lines(normal), ...lines(headless)].some((line) => line.startsWith("FAIL"))).toBe(
      false,
    )
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
  const server =
    "npx --registry=https://registry.npmjs.org/ --@opencode:registry=https://registry.npmjs.org/ -y @opencode/browse@0.0.16 mcp"

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
    expect(lines[1]).toStartWith(
      "~ browser-use: the browse extension is not installed in any browser this check scans",
    )
    expect(lines[1]).toContain(BROWSE_INSTALL_FIX)
  })

  test("normal form: an installed extension that is not paired is told apart from a missing one", async () => {
    await installExtension()
    const lines = await report("normal")
    expect(lines).toHaveLength(2)
    expect(lines[1]).toStartWith(
      "~ browser-use: the browse extension is installed (Google Chrome, profile Profile 1) but no browser is paired with browse",
    )
    expect(lines[1]).toContain(BROWSE_PAIR_FIX)
    await installExtension({ disabled: true })
    expect((await report("normal"))[1]).toContain("Google Chrome, profile Profile 1, disabled")
  })

  test("a pairing file that cannot be read is a line, not a failure of the setup step", async () => {
    const lines = await report("normal", { DISPLAY: ":0", ...UNREADABLE })
    expect(lines).toHaveLength(2)
    expect(lines[1]).toStartWith(
      "~ browser-use: cannot tell whether a browser is paired: cannot read",
    )
    // Doctor says the same as a FAIL line (see the pairing line above).
  })

  test("with the MCP extension off it says no server is registered and reads no pairing", async () => {
    await setConfig({ pi: { features: { mcp: false } } })
    await writeBrowsePairing(home)
    expect(await report("normal")).toEqual([
      "~ browser-use: normal form; pi.features.mcp is off, so the MCP server is not registered and screen specialists get none of its tools",
    ])
    expect(await report("headless", { HOLYAGENT_CHROMIUM_PATH: chromiumPath })).toEqual([
      "~ browser-use: headless form; pi.features.mcp is off, so the MCP server is not registered and screen specialists get none of its tools",
      `= browser-use: the headless browser is the Chromium at ${chromiumPath}`,
    ])
  })

  test("a need that is not met is reported beside the form, not dropped", async () => {
    await writeBrowsePairing(home)
    const lines = await report("normal", { DISPLAY: ":0" }, ["bun", "ctx7", "pi", "node"])
    expect(lines).toContain(
      "~ browser-use: needs npx on PATH; install Node.js from https://nodejs.org, which ships npx",
    )
    expect(lines[0]).toStartWith("= browser-use: normal form;")
  })

  test("a node older than 22.19 is reported as a need of the normal form", async () => {
    await writeBrowsePairing(home)
    const lines = await report("normal", { DISPLAY: ":0" }, undefined, "v20.11.0")
    expect(lines).toContain(
      "~ browser-use: needs Node.js 22.19.0 or newer, but /fake/bin/node is 20.11.0; install Node.js 22.19.0 or newer from https://nodejs.org, which ships npx",
    )
  })

  test("on Linux, no graphical session is reported as a need of the normal form", async () => {
    await writeBrowsePairing(home)
    const lines = await report("normal", {}, undefined, undefined, "linux")
    expect(lines).toContain(
      "~ browser-use: needs a graphical session (no DISPLAY or WAYLAND_DISPLAY)",
    )
  })

  test("macOS and Windows have a graphical session without DISPLAY, so none is a need there", async () => {
    await writeBrowsePairing(home)
    for (const platform of ["darwin", "win32"])
      expect(await report("normal", {}, undefined, undefined, platform)).not.toContain(
        "~ browser-use: needs a graphical session (no DISPLAY or WAYLAND_DISPLAY)",
      )
  })

  test("headless form: registers the browser-use server through browser-server, and reads no pairing", async () => {
    await writeBrowsePairing(home)
    const lines = await report("headless", { HOLYAGENT_CHROMIUM_PATH: chromiumPath })
    expect(lines).toEqual([
      "= browser-use: headless form; the extension registers `uvx --no-config --default-index https://pypi.org/simple --from browser-use==1.0.0 browser-use --cli-mcp` for screen specialists through `holyagent browser-server`, which starts the headless browser and stops it with the server and writes no file for it",
      `= browser-use: the headless browser is the Chromium at ${chromiumPath}`,
    ])
  })

  test("headless form: a missing Chromium or uvx is reported beside the form, with its fix", async () => {
    const lines = await report("headless", { PLAYWRIGHT_BROWSERS_PATH: join(home, "none") }, [
      "bun",
      "ctx7",
      "pi",
    ])
    expect(lines).toHaveLength(3)
    expect(lines[0]).toStartWith("= browser-use: headless form; the extension registers `uvx ")
    expect(lines).toContain(
      "~ browser-use: needs uvx on PATH; install uv from https://docs.astral.sh/uv/, which ships uvx and provides the Python 3.11 or newer that browser-use needs",
    )
    expect(
      lines.some((line) =>
        line.startsWith("~ browser-use: needs a Chromium; set HOLYAGENT_CHROMIUM_PATH"),
      ),
    ).toBe(true)
  })

  test("headless form: names the Chromium the machine provides, and none when it has none", async () => {
    const browsers = join(home, "pw-browsers")
    const none = await report("headless", { PLAYWRIGHT_BROWSERS_PATH: browsers })
    expect(none.some((line) => line.includes("the headless browser is the Chromium"))).toBe(false)
    await write(join(browsers, "chromium"), "")
    const lines = await report("headless", { PLAYWRIGHT_BROWSERS_PATH: browsers })
    expect(lines).toContain(
      `= browser-use: the headless browser is the Chromium at ${join(browsers, "chromium")}`,
    )
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
