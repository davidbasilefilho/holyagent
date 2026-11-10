import { type ChildProcess, spawn } from "node:child_process"
import { join } from "node:path"

import {
  type BashOperations,
  createBashToolDefinition,
  createLocalBashOperations,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent"
import { Effect } from "effect"

import { BASH_GUIDELINES } from "../../../runtime/src/pi/bash/guidelines.ts"
import { parseFrame, requestLine, type ShellFrame } from "../../../runtime/src/pi/bash/protocol.ts"
import {
  afterCall,
  isDirectory,
  NO_STATE,
  type ShellState,
  startEnvironment,
  startFolder,
} from "../../../runtime/src/pi/bash/state.ts"

/** How to start the shell process: the program and its arguments, or why it cannot be started. */
export type ShellLaunch =
  | {
      readonly ok: true
      readonly program: string
      readonly args: ReadonlyArray<string>
      /** The folder the process starts in; the shell enters the call's folder itself. */
      readonly cwd: string
    }
  | { readonly ok: false; readonly reason: string }

/** What the bash module needs from the extension that hosts it. */
export interface BashHost {
  /** Whether the config runs the bash tool on just-bash now (`pi.features.justBash`). */
  readonly active: () => boolean
  /** How to start the shell process (Bun on the package's `scripts/just-bash.js`). */
  readonly launch: () => ShellLaunch
  /** Pi's own bash operations, used while {@link BashHost.active} is false; Pi's by default. */
  readonly local?: BashOperations
  /** The system the paths and the process tree are those of; the process's by default. */
  readonly platform?: NodeJS.Platform
}

// A shell process is killed with everything it started: the group on POSIX (it is started as a group
// leader), the tree by `taskkill` on Windows, which Pi's own bash tool does the same way.
const killTree = (pid: number, platform: NodeJS.Platform): void => {
  if (platform === "win32") {
    const taskkill = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "taskkill.exe")
    const killer = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    })
    killer.once("error", () => undefined)
    return
  }
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    // The group is gone already.
  }
}

// How long to wait for the output pipes to close after the process exited: a program the command
// started and left running can hold them open, and the call must not wait for it.
const PIPE_GRACE_MS = 1_000

// Lines of the shell process's output, as they arrive in chunks.
const lineReader = (onLine: (line: string) => void) => {
  let rest = ""
  return {
    push: (chunk: Buffer) => {
      rest += chunk.toString("utf8")
      for (let at = rest.indexOf("\n"); at >= 0; at = rest.indexOf("\n")) {
        onLine(rest.slice(0, at))
        rest = rest.slice(at + 1)
      }
    },
    end: () => {
      if (rest !== "") onLine(rest)
      rest = ""
    },
  }
}

const waitForExit = (
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> =>
  new Promise((resolve, reject) => {
    let exit: { code: number | null; signal: string | null } | undefined
    child.once("error", reject)
    child.once("close", (code, signal) => resolve({ code, signal }))
    child.once("exit", (code, signal) => {
      exit = { code, signal }
      setTimeout(() => resolve(exit ?? { code, signal }), PIPE_GRACE_MS).unref()
    })
  })

/**
 * Pi's bash operations on just-bash. Each call starts the shell process (`host.launch()`), sends it
 * the command, the folder and the environment, and relays its output as it arrives; the process
 * ends with the call, so a cancel, a timeout or a loop that never ends is a kill of its process
 * tree, which stops it wherever it is. The working folder and the variables a call leaves are kept
 * for the next one, as in a terminal, for as long as Pi passes the same folder. Pi's contract is
 * kept: an abort rejects with `aborted`, a timeout with `timeout:<seconds>`, a missing folder with
 * Pi's own message, and a command's exit code is the result. While the host is not
 * {@link BashHost.active}, the calls go to Pi's own operations.
 */
export const createJustBashOperations = (host: BashHost): BashOperations => {
  const platform = host.platform ?? process.platform
  const local = host.local ?? createLocalBashOperations()
  let state: ShellState = NO_STATE
  return {
    exec: async (command, cwd, options) => {
      if (!host.active()) return local.exec(command, cwd, options)
      const { onData, signal, timeout, env } = options
      if (signal?.aborted) throw new Error("aborted")
      const folder = startFolder(state, cwd)
      if (!isDirectory(folder))
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`)
      const launch = host.launch()
      if (!launch.ok) throw new Error(`The bash tool cannot start its shell: ${launch.reason}`)

      const child = spawn(launch.program, [...launch.args], {
        cwd: launch.cwd,
        detached: platform !== "win32",
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      let timedOut = false
      let ended: Extract<ShellFrame, { type: "end" }> | undefined
      let failure: string | undefined
      const diagnostics: Array<Buffer> = []
      const kill = () => {
        if (child.pid !== undefined) killTree(child.pid, platform)
      }
      const timer =
        timeout === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true
              kill()
            }, timeout * 1000)
      if (signal?.aborted) kill()
      else signal?.addEventListener("abort", kill, { once: true })

      const lines = lineReader((line) => {
        if (line === "") return
        const frame = Effect.runSync(
          parseFrame(line).pipe(Effect.orElseSucceed((): ShellFrame | undefined => undefined)),
        )
        if (frame === undefined) onData(Buffer.from(`${line}\n`))
        else if (frame.type === "data") onData(Buffer.from(frame.data, "base64"))
        else if (frame.type === "end") ended = frame
        else failure = frame.message
      })
      child.stdout?.on("data", (chunk: Buffer) => lines.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => diagnostics.push(chunk))
      child.stdin?.on("error", () => undefined)
      child.stdin?.end(
        requestLine({ command, cwd: folder, env: startEnvironment(env ?? process.env, state) }),
      )

      try {
        const exit = await waitForExit(child)
        lines.end()
        if (signal?.aborted) throw new Error("aborted")
        if (timedOut) throw new Error(`timeout:${timeout}`)
        if (failure !== undefined) throw new Error(failure)
        if (ended === undefined) {
          const said = Buffer.concat(diagnostics).toString("utf8").trim().slice(-500)
          throw new Error(
            `The bash tool's shell ended without a result (${exit.signal ?? `exit ${exit.code}`})${said === "" ? "" : `: ${said}`}`,
          )
        }
        state = afterCall(state, cwd, folder, ended.cwd, ended.changes)
        return { exitCode: ended.exitCode }
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener("abort", kill)
      }
    },
  }
}

/** The bash module of the extension. */
export interface BashModule {
  /**
   * Replaces Pi's bash tool with one on just-bash, once and from then on for the session. Called
   * after the config says the capability is on; until then, and when it is off, Pi's own tool is
   * untouched. `cwd` is the session's folder, for calls that carry none.
   */
  readonly enable: (cwd: string) => void
}

/**
 * Registers the bash tool on just-bash: Pi's own bash tool definition (its schema, description,
 * truncation and rendering) with the operations of {@link createJustBashOperations} and the model's
 * guidelines for the shell added. Registered by {@link BashModule.enable} and not at load, because
 * the capability is off in some configs and Pi's own tool, with its shell settings, must then
 * stay.
 */
export const createBash = (pi: ExtensionAPI, host: BashHost): BashModule => {
  let enabled = false
  return {
    enable: (cwd) => {
      if (enabled) return
      enabled = true
      const base = createBashToolDefinition(cwd, { operations: createJustBashOperations(host) })
      pi.registerTool({
        ...base,
        promptGuidelines: [...(base.promptGuidelines ?? []), ...BASH_GUIDELINES],
      })
    },
  }
}
