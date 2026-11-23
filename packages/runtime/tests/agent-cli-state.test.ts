import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { decode } from "@toon-format/toon"
import { $ } from "bun"

const dist = join(import.meta.dir, "../../integrations/pi/dist")
const rootManifest = join(import.meta.dir, "../../../package.json")
const windows = process.platform === "win32"

type Result = { code: number; stdout: string; stderr: string }

const toon = (result: Result, code = 0) => {
  expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(code)
  expect(result.stderr).toBe("")
  expect(result.stdout).not.toBe("")
  expect(result.stdout).not.toContain("\u001b")
  expect(result.stdout).not.toMatch(/[\u007f-\u009f]/)
  return decode(result.stdout)
}

test("the packed npm package installs distinct human and structured agent CLIs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "holyagent npm-"))
  try {
    const git = await $`git rev-parse --show-toplevel`.cwd(directory).quiet().nothrow()
    expect(git.exitCode).toBe(128)

    const { version } = (await Bun.file(rootManifest).json()) as { readonly version: string }
    await $`bun pm pack --destination ${directory}`.cwd(dist).quiet()
    const archive = `./holyagent-${version}.tgz`
    const env = {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      HOLYAGENT_HOST: "pi",
      FORCE_COLOR: "3",
      CLICOLOR_FORCE: "1",
      TERM: "xterm-256color",
      NPM_CONFIG_USERCONFIG: join(directory, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: join(directory, "global.npmrc"),
    }
    const npm = windows ? ["cmd.exe", "/d", "/c", "npm.cmd"] : ["npm"]
    await $`${npm} install -g --prefix prefix --cache cache --offline --ignore-scripts --legacy-peer-deps --no-audit --no-fund ${archive}`
      .cwd(directory)
      .env(env)
      .quiet()

    // Invoke npm's native Windows shim or the POSIX link to the packaged launcher.
    const command = (name: "holyagent" | "holyagent-cli") =>
      windows
        ? ["cmd.exe", "/d", "/c", `prefix\\${name}.cmd`]
        : [join(directory, "prefix", "bin", name)]
    const installed =
      (name: "holyagent" | "holyagent-cli") =>
      async (...args: string[]): Promise<Result> => {
        const result = await $`${command(name)} ${args}`.cwd(directory).env(env).quiet().nothrow()
        return {
          code: result.exitCode,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
        }
      }
    const publicCli = installed("holyagent")
    const agentCli = installed("holyagent-cli")
    const humanVersion = await publicCli("--version")
    expect(humanVersion.code).toBe(0)
    expect(humanVersion.stdout.trim()).toBe(version)
    const publicHelp = await publicCli("--help")
    expect(publicHelp.code).toBe(0)
    for (const operation of ["install", "setup", "doctor", "update"])
      expect(publicHelp.stdout).toContain(operation)
    expect(publicHelp.stdout).not.toContain("intent create")
    expect((await publicCli("setup", "--help")).stdout).toContain("T3 Code")
    const privateCommand = await publicCli("intent", "list")
    expect(privateCommand.code).toBe(2)
    expect(privateCommand.stderr).toContain("Unknown command")

    // Project-level Bun startup code must never run before either installed command.
    await Bun.write(join(directory, "bunfig.toml"), 'preload = ["./preload.ts"]\n')
    await Bun.write(join(directory, "preload.ts"), 'console.log("unexpected project preload")\n')
    expect(await publicCli("--version")).toEqual(humanVersion)
    const help = await agentCli("--help")
    expect(toon(help)).toMatchObject({ usage: expect.any(String), commands: expect.any(Array) })
    expect(help.stdout).toContain("intent create")
    expect(help.stdout).not.toMatch(/^\s*(usage: )?setup(?:\s|$)/m)
    for (const args of [[], ["-h"], ["help"]]) expect(await agentCli(...args)).toEqual(help)
    const agentVersion = await agentCli("--version")
    expect(toon(agentVersion)).toEqual({ version })
    expect(await agentCli("-v")).toEqual(agentVersion)
    expect(toon(await agentCli("-v", "extra"), 2)).toMatchObject({ error: { code: 2 } })
    expect(toon(await agentCli("--project"), 2)).toMatchObject({ error: { code: 2 } })
    const subcommand = await agentCli("intent", "create", "--help")
    expect(toon(subcommand)).toMatchObject({ usage: expect.any(String) })
    expect(subcommand.stdout).toContain("--objective")
    expect(subcommand.stdout).not.toContain("--input")
    expect(await agentCli("intent", "create", "-h")).toEqual(subcommand)

    const missing = await agentCli("intent", "create")
    expect(toon(missing, 2)).toMatchObject({ error: { code: 2, message: expect.any(String) } })
    expect(missing.stdout).toContain("--objective")
    const agentSetup = await agentCli("setup")
    expect(toon(agentSetup, 2)).toMatchObject({ error: { code: 2 } })
    expect(
      toon(await agentCli("intent", "create", "--input", '{"objective":"old payload"}'), 2),
    ).toMatchObject({ error: { code: 2 } })
    expect(toon(await agentCli("intent", "create", "--objective", "   "), 2)).toMatchObject({
      error: { code: 2 },
    })
    expect(toon(await agentCli("intent", "close"), 2)).toMatchObject({ error: { code: 2 } })

    // Keep redirected stdin open so a regression that tries to read it cannot succeed via EOF.
    const pendingInput = Bun.spawn([...command("holyagent-cli"), "intent", "create"], {
      cwd: directory,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    try {
      expect(await pendingInput.exited).toBe(missing.code)
    } finally {
      await pendingInput.stdin.end()
    }
    expect(await new Response(pendingInput.stdout).text()).toBe(missing.stdout)
    expect(await new Response(pendingInput.stderr).text()).toBe("")

    if (!windows) {
      const tty = async (args: string[], expected: Result) => {
        const terminalClosed = Promise.withResolvers<void>()
        const decoder = new TextDecoder()
        let output = ""
        const child = Bun.spawn([...command("holyagent-cli"), ...args], {
          cwd: directory,
          env,
          timeout: 10_000,
          terminal: {
            data: (_terminal, data) => {
              output += decoder.decode(data, { stream: true })
            },
            exit: () => terminalClosed.resolve(),
          },
        })
        try {
          expect(await child.exited).toBe(expected.code)
          await terminalClosed.promise
          expect((output + decoder.decode()).replaceAll("\r\n", "\n")).toBe(expected.stdout)
        } finally {
          child.terminal?.close()
        }
      }
      await tty(["--help"], help)
      await tty(["--version"], agentVersion)
      await tty(["intent", "create"], missing)
      await tty(["setup"], agentSetup)
    }

    // Record written by the bundled CLI in the published 0.3.3 tarball.
    const previous = {
      id: "intent-0mwt5vylm-siz8",
      slug: "previous-install",
      objective: "Previous install",
      requirements: ["Carry this forward"],
      revision: 1,
      state: "Open",
      createdAt: "2026-11-23T11:07:33.227Z",
    }
    const file = join(
      directory,
      ".holyagent",
      "intents",
      `${previous.slug}-${previous.id}`,
      "intent.json",
    )
    await mkdir(dirname(file), { recursive: true })
    await Bun.write(file, `${JSON.stringify(previous, null, 2)}\n`)
    expect(
      toon(await agentCli("--project", directory, "intent", "show", previous.id)),
    ).toMatchObject({
      id: previous.id,
      objective: previous.objective,
      requirements: previous.requirements,
    })
    const updated = { ...previous, objective: "Leave the original path in place", revision: 2 }
    expect(
      toon(await agentCli("intent", "update", "--objective", updated.objective, "--material")),
    ).toMatchObject({ id: previous.id, objective: updated.objective, revision: 2 })
    expect(await Bun.file(file).json()).toEqual(updated)

    const corrupt = `${JSON.stringify({ ...updated, unrecognized: true }, null, 2)}\n`
    await Bun.write(file, corrupt)
    const invalid = await agentCli(
      "intent",
      "update",
      "--objective",
      "Cannot overwrite corrupt JSON",
    )
    expect(toon(invalid, 4)).toMatchObject({ error: { tag: "CorruptRecord", code: 4 } })
    expect(invalid.stdout).toContain("intent.json")
    expect(await Bun.file(file).text()).toBe(corrupt)
    await Bun.write(file, `${JSON.stringify(updated, null, 2)}\n`)

    const created = await agentCli(
      "intent",
      "create",
      "--objective",
      "New flags",
      "--requirement",
      "First",
      "--requirement",
      "Second",
    )
    expect(toon(created)).toMatchObject({
      objective: "New flags",
      requirements: ["First", "Second"],
    })
    const draft = await agentCli(
      "assignment",
      "create",
      "--role-task",
      "Reviewer.code",
      "--objective",
      "Review the artifact",
      "--criterion",
      "blocking:behavior:Find regressions",
      "--evidence",
      "checks",
    )
    const { id } = toon(draft) as { readonly id: string }
    expect(id).toMatch(/^assignment-/)
    const dispatched = await agentCli("assignment", "dispatch", "--id", id)
    expect(toon(dispatched)).toMatchObject({ id, state: "Running", prompt: expect.any(String) })
    const missingReport = await agentCli("assignment", "close", id, "--outcome", "success")
    expect(toon(missingReport, 2)).toMatchObject({ error: { code: 2 } })
    expect(missingReport.stdout).toContain("--report-file")
    expect(
      toon(await agentCli("assignment", "record", id, "--agent", "pi:local-fixture")),
    ).toMatchObject({ id, state: "Running" })
    const report = join(directory, "assignment report.md")
    await Bun.write(
      report,
      "result: Verified the artifact.\nevidence:\nFind regressions: The launcher behaved as specified.\nchecks: Installed from the candidate tarball.\n",
    )
    if (process.platform === "linux") {
      const scripts = join(directory, "prefix", "lib", "node_modules", "holyagent", "scripts")
      const redirected = Bun.spawnSync(
        [
          "bun",
          "--no-env-file",
          `--config=${join(scripts, "empty-bunfig.toml")}`,
          join(scripts, "holyagent-cli.js"),
          "assignment",
          "close",
          id,
          "--outcome",
          "success",
          "--report-file",
          "/dev/stdin",
        ],
        { cwd: directory, env, stdin: Bun.file(report), timeout: 10_000 },
      )
      expect(
        toon(
          {
            code: redirected.exitCode,
            stdout: redirected.stdout.toString(),
            stderr: redirected.stderr.toString(),
          },
          2,
        ),
      ).toMatchObject({ error: { code: 2 } })
    }
    expect(
      toon(
        await agentCli("assignment", "close", id, "--outcome", "success", "--report-file", report),
      ),
    ).toMatchObject({ id, state: "Succeeded", accepted: false })

    if (Bun.which("rg") !== null) {
      await Bun.write(join(directory, "search.txt"), "needle in the candidate\n")
      const found = await agentCli("rg", "--color=always", "needle", "search.txt")
      expect(toon(found)).toMatchObject({ exitCode: 0, stdout: expect.stringContaining("needle") })
      const notFound = await agentCli("rg", "absent", "search.txt")
      expect(toon(notFound, 1)).toMatchObject({ exitCode: 1, stdout: "", stderr: "" })
      expect(
        toon(await agentCli("rg", "--pre", "forbidden-preprocessor", "needle", "search.txt"), 2),
      ).toMatchObject({ error: { code: 2 } })
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5 })
  }
}, 60_000)
