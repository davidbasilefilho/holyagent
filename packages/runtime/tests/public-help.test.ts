import { afterAll, beforeAll, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { basename, dirname, join } from "node:path"

import { generate } from "../../integrations/pi/src/generate.ts"
import { scratch } from "./setup-fixture.ts"

const node = Bun.which("node") ?? "node"
const posix = process.platform !== "win32"
const distributionFiles = new Set([
  "holyagent-public-bin.js",
  "holyagent-public.js",
  "launcher.js",
  "setup-tui.js",
  "empty-bunfig.toml",
])
let root: Awaited<ReturnType<typeof scratch>>
let launcher: string

beforeAll(async () => {
  root = await scratch("holyagent-static-help-")
  for (const { path, content } of await generate()) {
    const file = basename(path)
    if (distributionFiles.has(file)) await Bun.write(join(root.directory, file), content)
  }
  await symlink(
    join(import.meta.dir, "../../../node_modules"),
    join(root.directory, "node_modules"),
    "junction",
  )
  launcher = join(root.directory, "holyagent-public-bin.js")
}, 30_000)
afterAll(() => root.remove())

const env = {
  ...process.env,
  TERM: "xterm-256color",
  COLORFGBG: "15;0",
  NO_COLOR: "",
  CI: "",
}

const pty = async (command: ReadonlyArray<string>, width: number, noColor = "") => {
  let output = ""
  const decoder = new TextDecoder()
  await using terminal = new Bun.Terminal({
    cols: width,
    rows: 24,
    data(_terminal, bytes) {
      output += decoder.decode(bytes, { stream: true })
    },
  })
  const child = Bun.spawn([...command], {
    cwd: root.directory,
    env: { ...env, NO_COLOR: noColor },
    terminal,
    signal: AbortSignal.timeout(10_000),
  })
  const code = await child.exited
  await Bun.sleep(25)
  return { code, output: (output + decoder.decode()).replaceAll("\r\n", "\n") }
}

const piped = async (command: ReadonlyArray<string>) => {
  const child = Bun.spawn([...command], {
    cwd: root.directory,
    env: { ...env, FORCE_COLOR: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: AbortSignal.timeout(10_000),
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

test.skipIf(!posix)(
  "bare public help fits narrow and wide terminals without switching screens",
  async () => {
    for (const width of [60, 110]) {
      const result = await pty([node, launcher], width)
      expect(result.code).toBe(0)
      expect(result.output).toContain("\x1b[1;38;2;125;207;255mholyagent setup")
      // Only append SGR style spans; cursor movement, queries or screen control would remain ESC.
      // oxlint-disable-next-line no-control-regex -- Match the tested SGR terminal style spans.
      const visible = result.output.replace(/\x1b\[(?:[0-9]+;)*[0-9]+m/g, "")
      expect(visible).not.toContain("\x1b")
      expect(visible).toStartWith("HolyAgent\nManage your HolyAgent installation.")
      expect(visible).toContain("Get started\n  holyagent setup")
      expect(visible).toContain("Run holyagent help [command] for details.")
      expect(visible.split("\n").every((line) => Bun.stringWidth(line) <= width)).toBe(true)
      if (width === 60) {
        expect(visible).toContain("holyagent doctor\n  Check T3 Code")
        expect(visible).toContain("feature\n  packages")
      } else {
        expect(visible).toContain("  holyagent doctor  Check T3 Code")
        expect(visible).toContain("  holyagent update  Update")
      }
    }
    const monochrome = await pty([node, launcher], 60, "1")
    expect(monochrome.code).toBe(0)
    expect(monochrome.output).toContain("Get started")
    expect(monochrome.output).not.toContain("\x1b")
  },
  15_000,
)

test("piped bare help preserves the legacy bytes and does not import the renderer bundle", async () => {
  const probe = join(root.directory, "probe")
  for (const name of distributionFiles) {
    if (name === "setup-tui.js") continue
    await Bun.write(join(probe, name), Bun.file(join(dirname(launcher), name)))
  }
  await Bun.write(
    join(probe, "setup-tui.js"),
    'process.stderr.write("renderer loaded"); export const renderPublicHelp = () => Promise.resolve("rendered");',
  )
  const command = [node, join(probe, "holyagent-public-bin.js")]
  const expected = await piped([node, launcher, "--help"])
  expect(expected.code).toBe(0)
  expect(expected.stdout).toContain("Run holyagent <command> [options].")
  expect(expected.stderr).toBe("")
  expect(await piped(command)).toEqual(expected)
  expect(expected.stdout).not.toContain("\x1b")
  if (posix) {
    const destination = join(root.directory, "redirected-help")
    const redirected = await pty(
      [
        "/bin/sh",
        "-c",
        'destination=$1; shift; exec "$@" >"$destination"',
        "redirect",
        destination,
        ...command,
      ],
      60,
    )
    expect(redirected).toEqual({ code: 0, output: "" })
    expect(await Bun.file(destination).text()).toBe(expected.stdout)
    // The same staged launcher reaches the probe with both streams on the TTY.
    const interactive = await pty(command, 60)
    expect(interactive).toEqual({ code: 0, output: "renderer loadedrendered" })
  }
}, 15_000)
