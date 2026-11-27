import { afterEach, beforeEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, sep } from "node:path"

import { Deferred, Effect, Fiber, Layer, Option } from "effect"

import { FileSystem, nodeFileSystem } from "../../core/src/ports/filesystem.ts"
import { run } from "../src/cli/program.ts"
import {
  liveBrowseDesktop,
  planTerminalBrowse,
  runTerminalBrowse,
  terminalBrowseUnavailable,
  type BrowseDesktopHost,
  type BrowseTerminalMode,
} from "../src/setup/browse-handoff.ts"
import { browseRelaySafe, checkLocalBrowseRelay } from "../src/setup/browse-local-relay.ts"
import {
  BROWSE_EXTENSION_IDS,
  BROWSE_EXTENSION_STORE,
  BROWSE_VERSION,
  browserDirectories,
  browsePairingFile,
} from "../src/setup/browse.ts"
import type { Env } from "../src/setup/environment.ts"
import { SetupFailure } from "../src/setup/errors.ts"
import { fakeShell, scratch } from "./setup-fixture.ts"

const mode: BrowseTerminalMode = {
  terminal: { stdin: true, stdout: true },
  form: { form: "normal", source: "flag", reason: "--form normal" },
  dryRun: false,
  nonInteractive: false,
}
const display = { DISPLAY: ":0", TERM: "xterm" }

test("screenless Browse still needs a local desktop terminal independently of --form normal", () => {
  expect(terminalBrowseUnavailable(display, mode, "linux", "regular desktop")).toBeUndefined()
  expect(terminalBrowseUnavailable({}, mode, "win32")).toBeUndefined()
  expect(terminalBrowseUnavailable({}, mode, "darwin")).toBeUndefined()
  for (const fake of [
    { CI: "true" },
    { CODEX_CAAS_SESSION_ID: "fixture" },
    { CLAUDE_CODE_REMOTE: "true" },
    { SSH_CLIENT: "fixture" },
    { SSH_CONNECTION: "fixture" },
    { SSH_TTY: "fixture" },
    { WSL_DISTRO_NAME: "fixture" },
    { WSL_INTEROP: "fixture" },
    { TERM: "dumb" },
    { DISPLAY: "localhost:10.0" },
    { DISPLAY: "" },
  ]) {
    expect(
      terminalBrowseUnavailable({ ...display, ...fake }, mode, "linux", "regular desktop"),
    ).toBeDefined()
  }
  expect(terminalBrowseUnavailable(display, mode, "linux", "microsoft-standard-WSL2")).toBeDefined()
  expect(terminalBrowseUnavailable({ SESSIONNAME: "Services" }, mode, "win32")).toBeDefined()
  for (const suppressed of [
    { terminal: { stdin: false, stdout: true } },
    { terminal: { stdin: true, stdout: false } },
    { dryRun: true },
    { nonInteractive: true },
    { form: { ...mode.form, form: "headless" } as const },
  ]) {
    expect(
      terminalBrowseUnavailable(display, { ...mode, ...suppressed }, "linux", "desktop"),
    ).toBeDefined()
  }
})

let directory: string
let remove: () => Promise<void>
beforeEach(async () => {
  const fixture = await scratch("holyagent-browse-terminal-")
  directory = fixture.directory
  remove = fixture.remove
})
afterEach(async () => remove())

const env = () => ({
  HOME: directory,
  PATH: join(directory, "bin"),
  XDG_DATA_DIRS: directory,
  ...display,
})
const selection = () => join(directory, ".holyagent", "browse-selection.json")
const executable = (name = "google-chrome") => join(directory, "bin", name)
const optionsUrl = (id: string) => `chrome-extension://${id}/settings.html`
const json = async (file: string, value: unknown) => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value))
}
const program = async (file: string, content = "fixture executable") => {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content, { mode: 0o755 })
}
const desktop = (respond?: (line: string) => void, defaultId = "google-chrome.desktop") => {
  const fixture = fakeShell({
    commands: ["xdg-settings"],
    respond: (line) => {
      respond?.(line)
      return {
        stdout: line.startsWith("/fake/bin/xdg-settings")
          ? defaultId + "\n"
          : BROWSE_VERSION + "\n",
      }
    },
  })
  // Hosted Linux runners ship Chrome in a prioritized known path. Keep the fixture's
  // executable lookup inside its own tree without changing production discovery order.
  const fs = Layer.succeed(
    FileSystem,
    FileSystem.of({
      ...nodeFileSystem,
      stat: (async (path: string) => {
        if (!path.startsWith(directory + sep))
          throw Object.assign(new Error("outside fixture"), { code: "ENOENT" })
        return nodeFileSystem.stat(path)
      }) as typeof nodeFileSystem.stat,
    }),
  )
  return { ...fixture, layer: Layer.merge(fixture.layer, fs) }
}
const profileFile = (profile = "Default") => {
  const browser = browserDirectories(env()).find(({ name }) => name === "Google Chrome")
  if (browser === undefined) throw new Error("fixture Chrome profile not found")
  return join(browser.directory, profile, "Preferences")
}
const extension = (id: string, reasons: ReadonlyArray<number> = []) => ({
  extensions: { settings: { [id]: { disable_reasons: reasons } } },
})
const pairing = () =>
  json(browsePairingFile(env()), {
    fixture: { token: "T".repeat(43), lastSeen: Date.now() },
  })

const fixtureCapabilities = () => ({
  id: BROWSE_EXTENSION_IDS[0]!,
  config: join(directory, ".config", "browse", "config.json"),
  receipt: join(directory, ".holyagent", "browse-setup.json"),
})
const shouldRunLinux = process.platform === "linux"
const root = "/tmp/bunx-1234-holyagent@dev/node_modules/holyagent"

test("the relay preflight uses native paths/ports and prevents legacy replacement", async () => {
  const local = { ...env(), XDG_STATE_HOME: join(directory, "state") }
  await json(join(local.XDG_STATE_HOME, "browse", "relays", "19988", "relay.json"), {
    configuredPort: 19988,
    port: 21031,
  })
  const ports: Array<number> = []
  const probe = (port: number) =>
    Effect.sync(() => {
      ports.push(port)
      return port !== 21031
    })
  const check = (environment: Env) => Effect.runPromise(checkLocalBrowseRelay(environment, probe))
  await expect(check(local)).rejects.toThrow("does not replace it")
  expect(ports.splice(0)).toEqual([19988, 21031])
  await check({ ...local, OPENCODE_BROWSER_PORT: "21032" })
  expect(ports.splice(0)).toEqual([21032])
  await expect(check({ ...local, HOME: "" })).rejects.toThrow("folders could not be verified")
  expect(ports).toEqual([])
})

test("ambiguous drive-less or device-namespace paths cannot authorize Windows pairing", async () => {
  const probe = () => Effect.die("must not probe an ambiguous root")
  const check = (environment: Env) =>
    Effect.runPromise(checkLocalBrowseRelay(environment, probe, "win32"))
  for (const directory of ["\\fake-drive-root", "/fake/drive-root", "\\\\?\\C:", "\\\\.\\pipe"]) {
    await expect(check({ OPENCODE_BROWSER_HOME: directory })).rejects.toThrow("fully qualified")
    await expect(check({ HOME: "C:\\Profile", XDG_DATA_HOME: directory })).rejects.toThrow(
      "complete drive or UNC",
    )
  }
})

test("legacy data stays untouched and the preflight never probes or starts the relay", async () => {
  const data = join(directory, "browse-data")
  const files = [
    join(data, "site-secrets"),
    join(data, "secrets"),
    join(data, "relays", "22017", "sessions.json"),
  ]
  for (const file of files) {
    await json(file, { fixture: "untouched" })
    await expect(
      Effect.runPromise(
        checkLocalBrowseRelay(
          {
            ...env(),
            OPENCODE_BROWSER_HOME: data,
            OPENCODE_BROWSER_PORT: "22017",
          },
          () => Effect.die("must not probe or migrate legacy state"),
        ),
      ),
    ).rejects.toThrow("does not change it")
    expect(await readFile(file, "utf8")).toBe('{"fixture":"untouched"}')
    await Bun.file(file).delete()
  }
})

test.skipIf(!shouldRunLinux)(
  "the loopback probe is read-only, native-only and does not follow redirects",
  async () => {
    let body: unknown = { version: "0.0.17", runtime: "typescript" }
    const calls: Array<string> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        calls.push(`${request.method} ${path}`)
        return body === null
          ? Response.redirect(new URL("/unsafe", request.url))
          : Response.json(body)
      },
    })
    try {
      expect(await Effect.runPromise(browseRelaySafe(server.port!))).toBe(false)
      body = { version: "0.1.5", runtime: "rust" }
      expect(await Effect.runPromise(browseRelaySafe(server.port!))).toBe(true)
      body = null
      expect(await Effect.runPromise(browseRelaySafe(server.port!))).toBe(false)
      expect(calls).toEqual(["GET /version", "GET /version", "GET /version"])
    } finally {
      await server.stop(true)
    }
  },
)

test("public Pi alone accepts the new flags and requires explicit terminal Browse intent", async () => {
  const host = {
    env: env(),
    cwd: directory,
    stdin: Effect.die("must not read stdin"),
    setupTui: () => Effect.die("must not initialize the UI"),
  }
  const pa = (args: ReadonlyArray<string>) => Effect.runPromise(run(args, host, "public"))
  expect(await pa(["setup", "pi", "--help"])).toMatchObject({
    code: 0,
    stdout: expect.stringContaining("--no-open-browse"),
  })
  expect(await pa(["setup", "pi", "--open-browse"])).toMatchObject({ code: 2 })
  expect(await pa(["setup", "pi", "--browse-browser", "chrome"])).toMatchObject({ code: 2 })
  expect(
    await pa([
      "setup",
      "pi",
      "--no-tui",
      "--browser-use",
      "on",
      "--open-browse",
      "--browser-executable",
      "/no",
    ]),
  ).toMatchObject({ code: 2 })
  expect(await pa(["setup", "--open-browse"])).toMatchObject({ code: 2 })
  expect(await pa(["setup", "claude", "--open-browse"])).toMatchObject({ code: 2 })
  expect(await pa(["setup", "claude", "--no-open-browse"])).toMatchObject({ code: 2 })
  expect(await pa(["setup", "pi", "--no-open-browse"])).toMatchObject({
    code: 2,
    stderr: expect.stringContaining("--no-open-browse requires --no-tui"),
  })
  const skipped = ["setup", "pi", "--no-tui", "--browser-use", "on", "--no-open-browse"]
  for (const flag of [["--open-browse"], ["--browse-browser", "chrome"]]) {
    expect(await pa([...skipped, ...flag])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining("--no-open-browse cannot be combined"),
    })
  }
})

test("the public Pi dry run respects terminal handoff flags without selecting, spawning or writing", async () => {
  const result = await Effect.runPromise(
    run(
      [
        "setup",
        "pi",
        "--scope",
        "project",
        "--skip-ctx7",
        "--dry-run",
        "--no-tui",
        "--browser-use",
        "on",
        "--browse-browser",
        "not-an-installed-browser",
      ],
      {
        env: env(),
        cwd: directory,
        terminal: mode.terminal!,
        stdin: Effect.die("must not read stdin"),
        setupTui: () => Effect.die("must not initialize the UI"),
      },
      "public",
    ),
  )
  expect(result.stdout).toContain("dry run does not open a browser or start pairing")
  expect(await Bun.file(selection()).exists()).toBe(false)
})

test.skipIf(!shouldRunLinux)(
  "one saved browser wins, a verified default is only used if no selection was saved",
  async () => {
    const s = desktop()
    await program(executable())
    await program(executable("brave"))
    const plan = (requested?: string) =>
      Effect.runPromise(
        planTerminalBrowse(env(), directory, requested).pipe(Effect.provide(s.layer)),
      )
    expect((await plan()).id).toBe("chrome")
    await json(selection(), { browsers: ["brave"] })
    expect((await plan()).id).toBe("brave")
    expect((await plan("chrome")).id).toBe("chrome")
    for (const browsers of [[], ["brave", "chrome"], ["vivaldi"]]) {
      await json(selection(), { browsers })
      await expect(plan()).rejects.toBeInstanceOf(SetupFailure)
    }
    expect((await plan("chrome")).id).toBe("chrome")
    expect(s.calls.length).toBe(1)
    await expect(plan("firefox")).rejects.toMatchObject({
      message: expect.stringContaining("compatible"),
    })
  },
)

test.skipIf(!shouldRunLinux)(
  "missing extension opens only official store and reports pending without a runner",
  async () => {
    await program(executable())
    await json(profileFile(), {})
    const shell = desktop()
    const plan = await Effect.runPromise(
      planTerminalBrowse(env(), directory, "chrome").pipe(Effect.provide(shell.layer)),
    )
    const opened: Array<unknown> = []
    const host: BrowseDesktopHost = {
      open: (command, args) =>
        Effect.sync(() => {
          opened.push([command, args])
        }),
      pair: () => Effect.die("must not start Browse pairing"),
    }
    const action = runTerminalBrowse(
      env(),
      directory,
      undefined,
      "chrome",
      plan,
      () => Effect.void,
      host,
      { timeoutMs: 40, intervalMs: 10 },
    )
    expect(await Effect.runPromise(action.pipe(Effect.provide(shell.layer)))).toMatchObject({
      ok: true,
      lines: [expect.stringContaining("installation and pairing are pending")],
    })
    expect(opened).toEqual([
      [executable(), ["--profile-directory=Default", BROWSE_EXTENSION_STORE]],
    ])
    expect(shell.calls).toEqual([])
  },
)

test.skipIf(!shouldRunLinux)(
  "disabled, ambiguous or missing default profiles never silently choose another browser",
  async () => {
    const id = BROWSE_EXTENSION_IDS[0]!
    await program(executable())
    const s = desktop(undefined, "firefox.desktop")
    const runPlan = (requested?: string) =>
      Effect.runPromise(
        planTerminalBrowse(env(), directory, requested).pipe(Effect.provide(s.layer)),
      )
    await expect(runPlan()).rejects.toMatchObject({
      message: expect.stringContaining("no compatible system default"),
    })
    await json(profileFile(), extension(id, [1]))
    const plan = await runPlan("chrome")
    const host: BrowseDesktopHost = {
      open: () => Effect.die("must not open disabled extension"),
      pair: () => Effect.die("must not start pairing for disabled extension"),
    }
    const result = await Effect.runPromise(
      runTerminalBrowse(env(), directory, root, "chrome", plan, () => Effect.void, host).pipe(
        Effect.provide(s.layer),
      ),
    )
    expect(result.lines.join()).toContain("extension is disabled")
    await json(join(dirname(dirname(profileFile())), "Local State"), {
      profile: { info_cache: { Default: {}, "Profile 2": {} } },
    })
    await json(profileFile(), extension(id))
    await json(profileFile("Profile 2"), extension(id))
    await expect(runPlan("chrome")).rejects.toMatchObject({
      message: expect.stringContaining("multiple possible profiles"),
    })
  },
)

test.each([
  ["/tmp/bunx-1234-holyagent@dev/node_modules/holyagent", "bunx"],
  ["/tmp/_npx/cache/node_modules/holyagent", "npm"],
  ["/tmp/installs/npm-holyagent/dev/lib/node_modules/holyagent", "mise"],
] as const)(
  "uses the owning runner in %s without leaking the code into browser arguments",
  async (packageRoot, runner) => {
    if (!shouldRunLinux) return
    const id = BROWSE_EXTENSION_IDS[1]!
    await program(executable())
    await json(profileFile(), extension(id))
    const shell = desktop()
    const plan = await Effect.runPromise(
      planTerminalBrowse(env(), directory, "chrome").pipe(Effect.provide(shell.layer)),
    )
    const opened: Array<unknown> = []
    const paired: Array<string> = []
    const host: BrowseDesktopHost = {
      open: (command, args) =>
        Effect.sync(() => {
          opened.push([command, args])
        }),
      pair: (command, args, options) =>
        Effect.tryPromise(() => pairing()).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              paired.push([command, ...args].join(" "))
              expect(options.env.OPENCODE_BROWSER_AUTO_UPDATE).toBe("off")
            }),
          ),
          Effect.as(0),
          Effect.orElseSucceed(() => 2),
        ),
    }
    const result = await Effect.runPromise(
      runTerminalBrowse(
        env(),
        directory,
        packageRoot,
        "chrome",
        plan,
        () => Effect.void,
        host,
      ).pipe(Effect.provide(shell.layer)),
    )
    expect(result).toMatchObject({ ok: true })
    expect(result.lines.join()).toContain("not which local profile")
    expect(opened).toEqual([[executable(), ["--profile-directory=Default", optionsUrl(id)]]])
    expect(paired).toHaveLength(1)
    expect(paired[0]).toMatch(new RegExp(`^${runner} .*browse@.+ browse pair$`))
  },
)

test.skipIf(!shouldRunLinux)(
  "setup rechecks executable, extension and pairing after planning and runner probe",
  async () => {
    const id = BROWSE_EXTENSION_IDS[0]!
    await program(executable())
    await json(profileFile(), extension(id))
    const s = desktop((line) => {
      if (line.endsWith("--version"))
        writeFileSync(profileFile(), JSON.stringify(extension(id, [1])))
    })
    const read = () =>
      Effect.runPromise(
        planTerminalBrowse(env(), directory, "chrome").pipe(Effect.provide(s.layer)),
      )
    const host: BrowseDesktopHost = {
      open: () => Effect.die("must not open a stale profile"),
      pair: () => Effect.die("must not pair a stale profile"),
    }
    const apply = (plan: Awaited<ReturnType<typeof read>>) =>
      Effect.runPromise(
        runTerminalBrowse(env(), directory, root, "chrome", plan, () => Effect.void, host).pipe(
          Effect.provide(s.layer),
        ),
      )
    expect(await apply(await read())).toMatchObject({
      ok: false,
      lines: [expect.stringContaining("changed")],
    })
    await json(profileFile(), extension(id))
    const beforeSwap = await read()
    await program(executable(), "different file")
    expect(await apply(beforeSwap)).toMatchObject({
      ok: false,
      lines: [expect.stringContaining("changed")],
    })
  },
)

test.skipIf(!shouldRunLinux)(
  "a prior pairing is neither replaced nor claimed for the selected browser",
  async () => {
    const id = BROWSE_EXTENSION_IDS[0]!
    await program(executable())
    await json(profileFile(), extension(id))
    await pairing()
    const s = desktop()
    const plan = await Effect.runPromise(
      planTerminalBrowse(env(), directory, "chrome").pipe(Effect.provide(s.layer)),
    )
    const opened: Array<string | undefined> = []
    const host: BrowseDesktopHost = {
      open: (_command, args) =>
        Effect.sync(() => {
          opened.push(args.at(-1))
        }),
      pair: () => Effect.die("must not replace or add pairing while one exists"),
    }
    const report = await Effect.runPromise(
      runTerminalBrowse(env(), directory, root, "chrome", plan, () => Effect.void, host).pipe(
        Effect.provide(s.layer),
      ),
    )
    expect(report).toMatchObject({
      ok: true,
      lines: [expect.stringContaining("did not verify a connection")],
    })
    expect(opened).toEqual([])
    const explicit = await Effect.runPromise(
      runTerminalBrowse(env(), directory, root, "chrome", plan, () => Effect.void, host, {
        reopenPaired: true,
      }).pipe(Effect.provide(s.layer)),
    )
    expect(explicit).toMatchObject({
      ok: true,
      lines: [expect.stringContaining("did not verify a connection")],
    })
    expect(opened).toEqual([optionsUrl(id)])
    expect(s.calls).toEqual([])
  },
)

test.skipIf(!shouldRunLinux)(
  "the pairing runner has no terminal stdin and is cancelled with its process scope",
  async () => {
    const runner = executable("bunx")
    const args = ["--package", "@opencode/browse@0.1.5", "browse", "pair"]
    const pairEnv = { ...env(), PATH: env().PATH + ":/usr/bin:/bin" }
    await program(
      runner,
      '#!/bin/sh\n[ "$(readlink /proc/$$/fd/0)" = /dev/null ] || exit 93\nprintf "%s\\n" "$@" > "$HOME/args"\nexit 37\n',
    )
    const call = () => liveBrowseDesktop.pair("bunx", args, { cwd: directory, env: pairEnv })
    expect(await Effect.runPromise(call())).toBe(37)
    expect((await readFile(join(directory, "args"), "utf8")).trim().split("\n")).toEqual([
      ...args,
      "--wait-seconds",
      "180",
    ])
    await program(runner, '#!/bin/sh\necho "$$" > "$HOME/runner.pid"\nexec sleep 600\n')
    const cancelled = await Effect.runPromise(call().pipe(Effect.timeoutOption(450)))
    expect(Option.isNone(cancelled)).toBe(true)
    const pid = Number(await readFile(join(directory, "runner.pid"), "utf8"))
    expect(() => process.kill(pid, 0)).toThrow()
  },
  6000,
)

test.skipIf(!shouldRunLinux)(
  "a pairing created during the pin probe suppresses both desktop process and pairing",
  async () => {
    const { id, receipt } = fixtureCapabilities()
    await program(executable())
    await json(profileFile(), extension(id))
    await mkdir(dirname(browsePairingFile(env())), { recursive: true })
    const s = desktop((line) => {
      if (line.endsWith("--version"))
        writeFileSync(
          browsePairingFile(env()),
          JSON.stringify({
            unrelated: { token: "T".repeat(43), lastSeen: 1 },
          }),
        )
    })
    const plan = await Effect.runPromise(
      planTerminalBrowse(env(), directory, "chrome").pipe(Effect.provide(s.layer)),
    )
    const host: BrowseDesktopHost = {
      open: () => Effect.die("must not open after another pairing"),
      pair: () => Effect.die("must not mint a second code"),
    }
    const report = await Effect.runPromise(
      runTerminalBrowse(env(), directory, root, "chrome", plan, () => Effect.void, host).pipe(
        Effect.provide(s.layer),
      ),
    )
    expect(report.ok).toBe(false)
    expect(report.lines.join()).toContain("was paired since review")
    expect(await Bun.file(receipt).exists()).toBe(false)
  },
)

test.skipIf(!shouldRunLinux)(
  "a remote relay or incomplete terminal pairing never claims completion",
  async () => {
    const { id, receipt, config } = fixtureCapabilities()
    await program(executable())
    await json(profileFile(), extension(id))
    const s = desktop()
    const plan = await Effect.runPromise(
      planTerminalBrowse(env(), directory, "chrome").pipe(Effect.provide(s.layer)),
    )
    const events: Array<string> = []
    const host: BrowseDesktopHost = {
      open: () =>
        Effect.sync(() => {
          events.push("opened")
        }),
      pair: () =>
        Effect.sync(() => {
          events.push("pair")
          return 1
        }),
    }
    const execute = () =>
      Effect.runPromise(
        runTerminalBrowse(env(), directory, root, "chrome", plan, () => Effect.void, host).pipe(
          Effect.provide(s.layer),
        ),
      )
    for (const hostname of ["0.0.0.0", "::", "192.0.2.5", "example.invalid", null]) {
      await json(config, { hostname })
      const refused = await execute()
      expect(refused.ok).toBe(false)
      expect(refused.lines.join()).toContain("configured for remote access")
    }
    expect(s.calls).toEqual([])
    expect(events).toEqual([])
    await json(config, { hostname: "127.0.0.1" })
    const expired = await execute()
    expect(expired.ok).toBe(false)
    expect(expired.lines.join()).toContain("pairing was not confirmed")
    expect(events).toEqual(["opened", "pair"])
    expect(await Bun.file(receipt).exists()).toBe(false)
  },
)

test.skipIf(!shouldRunLinux)(
  "screenless Pi applies before reporting an unavailable browser without --open-browse",
  async () => {
    await mkdir(join(directory, ".t3"), { recursive: true })
    const config = join(directory, ".holyagent", "config.json")
    await json(config, { pi: { providers: ["openai-codex"], features: { browserUse: false } } })
    await program(executable("pi"), '#!/bin/sh\n[ "$1" != "--version" ] || echo 1.5.0\n')
    await program(executable("node"), "#!/bin/sh\necho v26.13.1\n")
    await program(executable("npx"), "#!/bin/sh\nexit 93\n")
    const setup = (...flags: ReadonlyArray<string>) =>
      Effect.runPromise(
        run(
          ["setup", "pi", "--scope", "project", "--skip-ctx7", "--no-tui", ...flags],
          {
            env: { ...env(), HOLYAGENT_HOST: "pi" },
            cwd: directory,
            terminal: mode.terminal!,
            stdin: Effect.die("no terminal input requested"),
            setupTui: () => Effect.die("no setup renderer"),
          },
          "public",
        ),
      )
    const result = await setup("--browser-use", "on", "--browse-browser", "fixture-missing-browser")
    expect(result).toMatchObject({
      code: 0,
      stdout: expect.stringContaining('OpenCode Browse pending: browser "fixture-missing-browser"'),
    })
    expect(await Bun.file(config).json()).toMatchObject({
      pi: { features: { browserUse: true } },
    })
    const off = await setup("--browser-use", "off")
    expect(off.code).toBe(0)
    expect(off.stdout).not.toContain("OpenCode Browse")
    expect(await Bun.file(config).json()).toMatchObject({ pi: { features: { browserUse: false } } })
    const unattended = await setup("--browser-use", "on", "--non-interactive")
    expect(unattended.code).toBe(0)
    expect(unattended.stdout).toContain("--non-interactive never opens a browser")
    expect(unattended.stdout).not.toContain("OpenCode Browse pending")
  },
)

test.skipIf(!shouldRunLinux)(
  "the same command observes only its chosen profile, then opens Options and pairs without reopening its Store on retry",
  async () => {
    const id = BROWSE_EXTENSION_IDS[0]!
    const otherId = BROWSE_EXTENSION_IDS[1]!
    const events: Array<string> = []
    await program(executable())
    await json(profileFile(), {})
    const s = desktop()
    const plan = () => planTerminalBrowse(env(), directory, "chrome")
    const ping = (message: string) =>
      Effect.sync(() => {
        events.push(message)
      })
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* Deferred.make<void>()
        const host: BrowseDesktopHost = {
          open: (program, args) =>
            Effect.gen(function* () {
              expect(program).toBe(executable())
              expect(args[0]).toBe("--profile-directory=Default")
              const url = args[1]
              if (url === BROWSE_EXTENSION_STORE) {
                yield* ping("store")
                yield* Deferred.succeed(store, undefined)
              } else {
                expect(url).toBe(optionsUrl(id))
                yield* ping("options")
              }
            }),
          pair: () =>
            Effect.tryPromise(() => pairing()).pipe(
              Effect.tap(() => ping("pair")),
              Effect.orElseSucceed(() => undefined),
              Effect.as(0),
            ),
        }
        const pending = yield* runTerminalBrowse(
          env(),
          directory,
          root,
          "chrome",
          yield* plan(),
          () => Effect.void,
          host,
          { timeoutMs: 1500, intervalMs: 12 },
        ).pipe(Effect.forkScoped)
        yield* Deferred.await(store)
        const profiles = join(dirname(dirname(profileFile())), "Local State")
        yield* Effect.tryPromise(() =>
          json(profiles, {
            profile: { info_cache: { Default: {}, "Profile 2": {} } },
          }),
        )
        yield* Effect.tryPromise(() => json(profileFile("Profile 2"), extension(otherId)))
        yield* Effect.sleep(65)
        expect(events).toEqual(["store"])
        yield* Effect.tryPromise(() => json(profileFile(), extension(id)))
        const connected = yield* Fiber.join(pending)
        expect(connected.ok).toBe(true)
        // With the ambiguous second fixture gone, rerunning does not mint another code.
        yield* Effect.tryPromise(() => json(profiles, { profile: { info_cache: { Default: {} } } }))
        const again = yield* runTerminalBrowse(
          env(),
          directory,
          root,
          "chrome",
          yield* plan(),
          () => Effect.void,
          host,
        )
        expect(again.ok).toBe(true)
        expect(again.lines.join()).toContain("existing pairings were kept")
        return connected
      }).pipe(Effect.scoped, Effect.provide(s.layer)),
    )
    expect(result.lines.join()).toContain("confirms code redemption")
    expect(events).toEqual(["store", "options", "pair"])
  },
)

test.skipIf(!shouldRunLinux)(
  "cancelling extension installation leaves the browser open, with no pairing or version checks",
  async () => {
    await program(executable())
    const s = desktop()
    const events: Array<string> = []
    const plan = await Effect.runPromise(
      planTerminalBrowse(env(), directory, "chrome").pipe(Effect.provide(s.layer)),
    )
    expect(plan.profile).toBe("Default")
    const host: BrowseDesktopHost = {
      signals: Effect.succeed(Effect.succeed(130)),
      open: (_program, args) =>
        Effect.sync(() => {
          expect(args).toEqual(["--profile-directory=Default", BROWSE_EXTENSION_STORE])
          events.push("store")
        }),
      pair: () => Effect.die("must not start pairing"),
    }
    const report = await Effect.runPromise(
      runTerminalBrowse(env(), directory, root, "chrome", plan, () => Effect.void, host, {
        timeoutMs: 200,
        intervalMs: 10,
      }).pipe(Effect.provide(s.layer)),
    )
    expect(report.lines.join()).toContain("stopped waiting")
    expect(events).toEqual(["store"])
    expect(s.calls).toEqual([])
    expect(await Bun.file(fixtureCapabilities().receipt).exists()).toBe(false)
  },
)
