#!/usr/bin/env bun
import { Effect } from "effect"

import { StdinMissing } from "./errors.ts"
import { run } from "./program.ts"

/** The `holyagent-runtime` entry point: runs the command line of the process and sets its exit code. */
const stdin = Effect.suspend(() =>
  process.stdin.isTTY
    ? Effect.fail(new StdinMissing({ reason: "stdin is a terminal" }))
    : Effect.tryPromise({
        try: () => Bun.stdin.text(),
        catch: (cause) => new StdinMissing({ reason: String(cause) }),
      }),
)

Effect.runFork(
  run(Bun.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    stdin,
    emit: (text) => Effect.sync(() => void process.stdout.write(text)),
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        process.stdout.write(result.stdout)
        process.stderr.write(result.stderr)
        process.exitCode = result.code
      }),
    ),
  ),
)
