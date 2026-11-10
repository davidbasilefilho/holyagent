#!/usr/bin/env bun
import { Effect } from "effect"

import { frameLine, parseRequest, type ShellFrame } from "./protocol.ts"
import { runShell } from "./shell.ts"

/**
 * Reads one request from standard input and runs it, writing frames to standard output: the whole
 * life of the shell process the Pi extension starts for each bash call. It exits when the run ends,
 * with 0 once an `end` or `failure` frame has been written (the exit code of the command is in the
 * frame, not here), so the extension never waits on a handle the shell left open.
 */
export const main = (): Effect.Effect<void> => {
  const write = (frame: ShellFrame) => void process.stdout.write(frameLine(frame))
  return Effect.tryPromise({ try: () => Bun.stdin.text(), catch: String }).pipe(
    Effect.flatMap(parseRequest),
    Effect.flatMap((request) => runShell(request, { emit: write })),
    Effect.catch((error) =>
      Effect.sync(() =>
        write({ type: "failure", message: typeof error === "string" ? error : error.message }),
      ),
    ),
  )
}

// Importing the module (the tests do) runs nothing. The process exits through the stream's callback
// so the last frame is flushed first.
if (import.meta.main) {
  await Effect.runPromise(main())
  process.stdout.write("", () => process.exit(0))
}
