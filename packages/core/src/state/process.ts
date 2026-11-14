import { spawn as spawnChild } from "node:child_process"

import { Effect } from "effect"

/** Runs a subprocess without a shell; interrupting it kills the detached process group. */
export const spawn = (
  program: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
    readonly stdin?: string | undefined
    readonly discard?: boolean
  },
) =>
  Effect.callback<{ readonly code: number; readonly stdout: Uint8Array; readonly stderr: string }>(
    (resume) => {
      const child = spawnChild(program, args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: options.discard === true ? ["ignore", "ignore", "ignore"] : ["pipe", "pipe", "pipe"],
        windowsHide: true,
      })
      const stdout: Array<Buffer> = []
      const stderr: Array<Buffer> = []
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))
      child.stdin?.on("error", () => {})
      child.once("error", (cause) => resume(Effect.die(cause)))
      child.once(options.discard === true ? "exit" : "close", (code) =>
        resume(
          Effect.succeed({
            code: code ?? -1,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr).toString("utf8"),
          }),
        ),
      )
      child.stdin?.end(options.stdin)
      return Effect.suspend(() => {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined)
          return Effect.void
        const killed =
          process.platform === "win32"
            ? Effect.callback<void>((done) => {
                const killer = spawnChild("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
                  stdio: "ignore",
                  windowsHide: true,
                })
                killer.once("error", () => {
                  child.kill("SIGKILL")
                  done(Effect.void)
                })
                killer.once("close", () => done(Effect.void))
              })
            : Effect.sync(() => {
                try {
                  if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
                } catch {
                  child.kill("SIGKILL")
                }
              })
        const exited = Effect.callback<void>((done) => {
          const finish = () => done(Effect.void)
          child.once("exit", finish)
          if (child.exitCode !== null || child.signalCode !== null) finish()
          return Effect.sync(() => {
            child.removeListener("exit", finish)
          })
        })
        return killed.pipe(Effect.andThen(exited), Effect.timeoutOption(2_000), Effect.asVoid)
      })
    },
  )
