import { Effect } from "effect"

import type { SetupResult } from "../setup/tui/result-file.ts"
import { hasCode } from "../state/files.ts"
import { StdinMissing } from "./errors.ts"
import { run } from "./program.ts"
import type { CliSurface } from "./types.ts"

/** The `holyagent` entry point: runs the command line of the process and sets its exit code. */
const stdin = Effect.suspend(() =>
  process.stdin.isTTY
    ? Effect.fail(new StdinMissing({ reason: "stdin is a terminal" }))
    : Effect.tryPromise({
        try: () => Bun.stdin.text(),
        catch: (cause) => new StdinMissing({ reason: String(cause) }),
      }),
)

// A reader that exits early (`holyagent plan | head -1`) closes the pipe; nobody is left to read
// the rest, so the run ends quietly instead of printing the stack of the failed write.
const brokenPipe = (cause: unknown) => hasCode(cause, "EPIPE")
for (const stream of [process.stdout, process.stderr])
  stream.on("error", (error) => {
    if (brokenPipe(error)) process.exit(0)
    throw error
  })

const write = (stream: NodeJS.WriteStream, text: string) =>
  Effect.try({ try: () => void stream.write(text), catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      brokenPipe(cause) ? Effect.sync(() => process.exit(0)) : Effect.die(cause),
    ),
  )

/** The optional public boundary that presents the text written to each output stream. */
export type OutputPresentation = (
  text: string,
  kind: "stdout" | "stderr" | "progress",
  targetIsTty: boolean,
  summary?: SetupResult,
) => Effect.Effect<string>

const plainOutput: OutputPresentation = (text) => Effect.succeed(text)

/** Runs one CLI entry. Only the public entry can display the interactive setup screen. */
export const main = (
  interactiveSetup = false,
  surface: CliSurface = "host",
  installedPackageRoot?: string,
  present: OutputPresentation = plainOutput,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const argv = Bun.argv.slice(2)
      const terminal = {
        stdin: Boolean(process.stdin.isTTY),
        stdout: Boolean(process.stdout.isTTY),
      }
      const emit = (text: string) =>
        present(text, "progress", terminal.stdout).pipe(
          Effect.flatMap((output) => write(process.stdout, output)),
        )
      const result = yield* run(
        argv,
        {
          cwd: process.cwd(),
          env: process.env,
          stdin:
            surface === "agent"
              ? Effect.fail(new StdinMissing({ reason: "stdin is unavailable" }))
              : stdin,
          ...(surface === "agent" ? {} : { emit }),
          ...(surface === "public" && installedPackageRoot !== undefined
            ? { installedPackageRoot }
            : {}),
          ...(surface === "host"
            ? {}
            : { packageManifest: new URL("../package.json", import.meta.url) }),
          ...(interactiveSetup
            ? {
                t3Workflow: true,
                terminal,
              }
            : {}),
        },
        surface,
      )
      const stdout = yield* present(result.stdout, "stdout", terminal.stdout, result.setupResult)
      const stderr = yield* present(result.stderr, "stderr", Boolean(process.stderr.isTTY))
      yield* write(process.stdout, stdout)
      yield* write(process.stderr, stderr)
      process.exitCode = result.code
    }),
  )
