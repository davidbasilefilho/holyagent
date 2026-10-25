#!/usr/bin/env bun
import { Effect } from "effect"

import { hasCode } from "../state/files.ts"
import { StdinMissing } from "./errors.ts"
import { run } from "./program.ts"

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

Effect.runFork(
  run(Bun.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdin,
    emit: (text) => write(process.stdout, text),
  }).pipe(
    Effect.tap((result) =>
      write(process.stdout, result.stdout).pipe(
        Effect.andThen(write(process.stderr, result.stderr)),
        Effect.andThen(Effect.sync(() => void (process.exitCode = result.code))),
      ),
    ),
  ),
)
