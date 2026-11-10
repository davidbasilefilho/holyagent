import { describe, expect, test } from "bun:test"

import { Effect } from "effect"

import { stableWaitAsync } from "../../src/pi/bash/atomics.ts"
import { runShell } from "../../src/pi/bash/shell.ts"

const cell = (value: number) => {
  const cells = new Int32Array(new SharedArrayBuffer(4))
  Atomics.store(cells, 0, value)
  return cells
}

type Wait = ReturnType<typeof Atomics.waitAsync>

/** The promise of a wait that did not end at once. */
const pending = (wait: Wait): Promise<string> => {
  if (!wait.async) throw new Error(`the wait ended at once: ${wait.value}`)
  return wait.value
}

/** Tells whether a wait has ended, after the engine has had its turns to settle it. */
const endedAfterTurns = async (wait: Wait) => {
  let ended = false
  void pending(wait).then(() => (ended = true))
  await Bun.sleep(25)
  return ended
}

describe("waiting on a shared cell, as just-bash's synchronous bridge does", () => {
  test("a notify that leaves the awaited value in place does not end the wait", async () => {
    const cells = cell(2)
    const wait = stableWaitAsync(Atomics.waitAsync.bind(Atomics))(cells, 0, 2)
    Atomics.notify(cells, 0)
    expect(await endedAfterTurns(wait)).toBe(false)
    Atomics.notify(cells, 0)
    expect(await endedAfterTurns(wait)).toBe(false)
    Atomics.store(cells, 0, 0)
    Atomics.notify(cells, 0)
    expect(await pending(wait)).toBe("ok")
  })

  test("a wait that finds another value, and a wait with a timeout, are the engine's own", async () => {
    const wait = stableWaitAsync(Atomics.waitAsync.bind(Atomics))
    expect(wait(cell(1), 0, 2)).toEqual({ async: false, value: "not-equal" })
    expect(await pending(wait(cell(2), 0, 2, 5))).toBe("timed-out")
  })

  test("a shell run makes every wait in the process ignore a notify that changed nothing", async () => {
    await Effect.runPromise(
      runShell({ command: "true", cwd: "/", env: { PATH: "/usr/bin" } }, { emit: () => {} }),
    )
    const cells = cell(2)
    const wait = Atomics.waitAsync(cells, 0, 2)
    Atomics.notify(cells, 0)
    expect(await endedAfterTurns(wait)).toBe(false)
    Atomics.store(cells, 0, 0)
    Atomics.notify(cells, 0)
    expect(await pending(wait)).toBe("ok")
  })
})
