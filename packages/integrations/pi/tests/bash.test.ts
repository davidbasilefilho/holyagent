import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, parse } from "node:path"

import type { BashOperations, ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { BASH_GUIDELINES } from "../../../runtime/src/pi/bash/guidelines.ts"
import { toVirtualPath } from "../../../runtime/src/pi/bash/paths.ts"
import { afterCall, NO_STATE, startFolder } from "../../../runtime/src/pi/bash/state.ts"
import { PROCESS_TIMEOUT_MS } from "../../../runtime/tests/fixtures.ts"
import {
  type BashHost,
  createBash,
  createJustBashOperations,
  type ShellLaunch,
} from "../src/bash.ts"

const ENTRY = join(import.meta.dir, "../../../runtime/src/pi/bash/entry.ts")
const HOST_DIR = dirname(process.execPath)
const HOST = parse(process.execPath).name

let work: string

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "holyagent-bash-ops-"))
})

afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

// The shell process as the extension starts it, from source: the Bun that runs the tests.
const launchShell = (): ShellLaunch => ({
  ok: true,
  program: process.execPath,
  args: ["--no-env-file", ENTRY],
  cwd: work,
})

const host = (overrides: Partial<BashHost> = {}): BashHost => ({
  active: () => true,
  launch: launchShell,
  ...overrides,
})

// What `pwd` prints for a host folder: inside the shell every path is the shell's own, so `C:\\x` is
// `/c/x` on Windows. What goes back to Pi and into the next call is the host's path (see below).
const inShell = (path: string): string => toVirtualPath(path)

const environment = (): NodeJS.ProcessEnv => ({ PATH: HOST_DIR, HOME: work })

/** Runs a command through the operations and returns what Pi would receive. */
const call = async (
  operations: BashOperations,
  command: string,
  options: {
    cwd?: string
    signal?: AbortSignal
    timeout?: number
    env?: NodeJS.ProcessEnv
  } = {},
) => {
  const chunks: Array<Buffer> = []
  const result = await operations.exec(command, options.cwd ?? work, {
    onData: (data) => void chunks.push(data),
    env: options.env ?? environment(),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  })
  return { ...result, text: Buffer.concat(chunks).toString("utf8") }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitFor = async (until: () => boolean | Promise<boolean>, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (!(await until())) {
    if (Date.now() > deadline) throw new Error("timed out waiting")
    await Bun.sleep(50)
  }
}

describe("the bash tool's operations on just-bash", () => {
  test(
    "run a command in just-bash, with a host program beside the built-ins",
    async () => {
      const operations = createJustBashOperations(host())
      const piped = await call(operations, "echo hi | tr a-z A-Z")
      expect(piped).toMatchObject({ exitCode: 0, text: "HI\n" })
      const external = await call(operations, `${HOST} --version`)
      expect(external.text.trim()).toBe(Bun.version)
      expect((await call(operations, `${HOST} -e "process.exit(5)"`)).exitCode).toBe(5)
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "keep the folder and the variables from one call to the next, as a terminal does",
    async () => {
      await mkdir(join(work, "kept"), { recursive: true })
      const operations = createJustBashOperations(host())
      await call(operations, "cd kept && export KEPT=yes && X=local")
      const next = await call(operations, 'pwd; echo "$KEPT:$X"')
      // Variables a call sets stay set, exported or not (just-bash reports the shell's variables).
      expect(next.text).toBe(`${inShell(join(work, "kept"))}\nyes:local\n`)
      await call(operations, "unset KEPT")
      expect((await call(operations, 'echo "[$KEPT]"')).text).toBe("[]\n")
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "keep the folder and the variables of a call that ends with exit",
    async () => {
      await mkdir(join(work, "exited"), { recursive: true })
      const operations = createJustBashOperations(host())
      expect((await call(operations, "cd exited && export EXITED=yes && exit 2")).exitCode).toBe(2)
      expect((await call(operations, 'pwd; echo "$EXITED"')).text).toBe(
        `${inShell(join(work, "exited"))}\nyes\n`,
      )
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "overlapping calls each keep what they changed, and a call that stayed put does not undo another's cd",
    async () => {
      await mkdir(join(work, "overlap"), { recursive: true })
      const operations = createJustBashOperations(host())
      // The slow call starts first and ends last, without leaving the folder it started in.
      const slow = call(operations, "sleep 1; export SLOW=1")
      await Bun.sleep(150)
      await call(operations, "cd overlap && export FAST=1")
      await slow
      expect((await call(operations, 'pwd; echo "$FAST $SLOW"')).text).toBe(
        `${inShell(join(work, "overlap"))}\n1 1\n`,
      )
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "start again from Pi's folder when Pi passes another",
    async () => {
      await mkdir(join(work, "moved"), { recursive: true })
      const operations = createJustBashOperations(host())
      await call(operations, "cd moved")
      const other = await call(operations, "pwd", { cwd: dirname(work) })
      expect(other.text).toBe(`${inShell(dirname(work))}\n`)
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "give the call the environment Pi passes",
    async () => {
      const operations = createJustBashOperations(host())
      const out = await call(operations, 'echo "$PI_SESSION_ID"', {
        env: { ...environment(), PI_SESSION_ID: "abc" },
      })
      expect(out.text).toBe("abc\n")
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "an abort ends a loop that never leaves the shell, with Pi's message",
    async () => {
      const operations = createJustBashOperations(host())
      const controller = new AbortController()
      const started = Date.now()
      setTimeout(() => controller.abort(), 500)
      await expect(
        call(operations, "while true; do :; done", { signal: controller.signal }),
      ).rejects.toThrow("aborted")
      expect(Date.now() - started).toBeLessThan(PROCESS_TIMEOUT_MS)
    },
    PROCESS_TIMEOUT_MS,
  )

  test("an abort that came before the call starts nothing", async () => {
    const operations = createJustBashOperations(
      host({
        launch: () => {
          throw new Error("started a process")
        },
      }),
    )
    const controller = new AbortController()
    controller.abort()
    await expect(call(operations, "echo hi", { signal: controller.signal })).rejects.toThrow(
      "aborted",
    )
  })

  test(
    "a timeout ends the call with Pi's message, in seconds",
    async () => {
      const operations = createJustBashOperations(host())
      const started = Date.now()
      await expect(call(operations, "while true; do :; done", { timeout: 1 })).rejects.toThrow(
        "timeout:1",
      )
      expect(Date.now() - started).toBeLessThan(PROCESS_TIMEOUT_MS)
    },
    PROCESS_TIMEOUT_MS,
  )

  test(
    "a cancel takes the programs the command started with it",
    async () => {
      const marker = join(work, "grandchild.pid")
      const script = join(work, "grandchild.ts")
      await writeFile(
        script,
        "await Bun.write(process.argv[2], String(process.pid))\nawait Bun.sleep(60000)\n",
      )
      const operations = createJustBashOperations(host())
      const controller = new AbortController()
      const running = call(operations, `${HOST} '${script}' '${marker}'`, {
        signal: controller.signal,
      })
      await waitFor(
        async () => (await Bun.file(marker).exists()) && (await Bun.file(marker).text()) !== "",
      )
      const pid = Number(await Bun.file(marker).text())
      expect(alive(pid)).toBe(true)
      controller.abort()
      await expect(running).rejects.toThrow("aborted")
      await waitFor(() => !alive(pid))
    },
    PROCESS_TIMEOUT_MS,
  )

  test("a folder that is not there is Pi's own error", async () => {
    const operations = createJustBashOperations(host())
    await expect(call(operations, "pwd", { cwd: join(work, "missing") })).rejects.toThrow(
      `Working directory does not exist: ${join(work, "missing")}`,
    )
  })

  test("a shell that cannot be started is said, and a shell that dies without a result is too", async () => {
    const missing = createJustBashOperations(
      host({ launch: () => ({ ok: false, reason: "Bun was not found" }) }),
    )
    await expect(call(missing, "echo hi")).rejects.toThrow(
      "The bash tool cannot start its shell: Bun was not found",
    )
    const dying = createJustBashOperations(
      host({
        launch: () => ({ ...launchShell(), args: ["--no-env-file", "-e", "process.exit(3)"] }),
      }),
    )
    await expect(call(dying, "echo hi")).rejects.toThrow("ended without a result (exit 3)")
  })

  test("while the capability is off the calls go to Pi's own operations", async () => {
    const seen: Array<string> = []
    const local: BashOperations = {
      exec: (command, cwd) => {
        seen.push(`${command} @ ${cwd}`)
        return Promise.resolve({ exitCode: 9 })
      },
    }
    let active = false
    const operations = createJustBashOperations(
      host({
        active: () => active,
        local,
        launch: () => {
          throw new Error("started the shell while off")
        },
      }),
    )
    expect((await call(operations, "echo off")).exitCode).toBe(9)
    expect(seen).toEqual([`echo off @ ${work}`])
    active = true
    await expect(call(operations, "echo on")).rejects.toThrow("started the shell while off")
  })
})

describe("the state after a call", () => {
  const none = { set: {}, unset: [] }

  test("adds what the call changed to the state at the end of the call", () => {
    const first = afterCall(NO_STATE, "/p", "/p", "/p/a", { set: { A: "1" }, unset: [] })
    expect(first).toEqual({ cwd: "/p/a", from: "/p", delta: { A: "1" } })
    // Another call changed B meanwhile; this one sets A again and unsets C.
    const second = afterCall(
      { ...first, delta: { ...first.delta, B: "2" } },
      "/p",
      "/p/a",
      "/p/a",
      {
        set: { A: "3" },
        unset: ["C"],
      },
    )
    expect(second.delta).toEqual({ A: "3", B: "2", C: null })
  })

  test("a call that did not change folder keeps the folder another call moved to", () => {
    const moved = { cwd: "/p/other", from: "/p", delta: {} }
    expect(afterCall(moved, "/p", "/p", "/p", none)).toEqual(moved)
    // One that did move wins, and so does one that follows another folder Pi passed.
    expect(afterCall(moved, "/p", "/p", "/p/new", none).cwd).toBe("/p/new")
    expect(afterCall(moved, "/q", "/q", "/q", none)).toEqual({ cwd: "/q", from: "/q", delta: {} })
  })
})

describe("the state after a call, on Windows", () => {
  test("the folder carried is the host's path, and is used again only while Pi passes the same one", () => {
    // The shell reports `C:\\proj\\src` (the host's spelling, as `runShell` ends a call), not `/c/proj/src`.
    const after = afterCall(NO_STATE, "C:\\proj", "C:\\proj", "C:\\proj\\src", {
      set: {},
      unset: [],
    })
    expect(after.cwd).toBe("C:\\proj\\src")
    const exists = (path: string) => path === "C:\\proj\\src"
    expect(startFolder(after, "C:\\proj", exists)).toBe("C:\\proj\\src")
    expect(startFolder(after, "D:\\other", exists)).toBe("D:\\other")
    expect(startFolder(after, "C:\\proj", () => false)).toBe("C:\\proj")
    // What the shell is then asked to start in is the same folder in the shell's spelling.
    expect(toVirtualPath(startFolder(after, "C:\\proj", exists), "win32")).toBe("/c/proj/src")
  })
})

describe("the bash module", () => {
  const fakePi = () => {
    const registered: Array<{ name: string; promptGuidelines?: ReadonlyArray<string> }> = []
    const api = {
      registerTool: (tool: { name: string; promptGuidelines?: ReadonlyArray<string> }) =>
        void registered.push(tool),
    } as unknown as ExtensionAPI
    return { api, registered }
  }

  test("leaves Pi's own bash tool alone until the capability is enabled", () => {
    const { api, registered } = fakePi()
    createBash(api, host())
    expect(registered).toEqual([])
  })

  test("registers Pi's bash tool under its own name, once, with the guidelines for the shell", () => {
    const { api, registered } = fakePi()
    const module = createBash(api, host())
    module.enable(work)
    module.enable(work)
    expect(registered).toHaveLength(1)
    const [tool] = registered
    expect(tool?.name).toBe("bash")
    for (const line of BASH_GUIDELINES) expect(tool?.promptGuidelines).toContain(line)
    expect(BASH_GUIDELINES.join(" ")).toContain("js-exec runs TypeScript first")
  })
})
