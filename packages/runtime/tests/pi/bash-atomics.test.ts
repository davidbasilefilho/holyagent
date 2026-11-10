import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createContext, runInContext } from "node:vm"

import { Effect } from "effect"

import { stableWaitAsync } from "../../src/pi/bash/atomics.ts"
import { runShell } from "../../src/pi/bash/shell.ts"

// A host program directory that exists on every system the tests run on: the Bun that runs them.
const HOST_DIR = dirname(process.execPath)
const STABLE = Symbol.for("holyagent.stableWaitAsync")
const atomics: { waitAsync: typeof Atomics.waitAsync; [STABLE]?: true } = Atomics

// The engine's own function, from a realm of its own: an earlier test file in the same process may
// already have made `Atomics.waitAsync` the wrapper. The realm stays referenced for the whole run:
// JavaScriptCore collects a realm nothing refers to, and a wait made through its function never
// settles after that, which hung these tests when a collection ran mid-test.
const realm = createContext({})
const nativeWaitAsync = runInContext("Atomics.waitAsync", realm) as typeof Atomics.waitAsync
const installed = { waitAsync: atomics.waitAsync, stable: atomics[STABLE] }
let work: string

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "holyagent-atomics-"))
})

afterAll(async () => {
  atomics.waitAsync = installed.waitAsync
  if (installed.stable === undefined) delete atomics[STABLE]
  else atomics[STABLE] = installed.stable
  await rm(work, { recursive: true, force: true })
})

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
    const wait = stableWaitAsync(nativeWaitAsync)(cells, 0, 2)
    Atomics.notify(cells, 0)
    expect(await endedAfterTurns(wait)).toBe(false)
    Atomics.notify(cells, 0)
    expect(await endedAfterTurns(wait)).toBe(false)
    Atomics.store(cells, 0, 0)
    Atomics.notify(cells, 0)
    expect(await pending(wait)).toBe("ok")
  })

  test("a wait that finds another value, and a wait with a timeout, are the engine's own", async () => {
    const wait = stableWaitAsync(nativeWaitAsync)
    expect(wait(cell(1), 0, 2)).toEqual({ async: false, value: "not-equal" })
    expect(await pending(wait(cell(2), 0, 2, 5))).toBe("timed-out")
  })

  test("a shell run makes every wait in the process ignore a notify that changed nothing", async () => {
    atomics.waitAsync = nativeWaitAsync
    delete atomics[STABLE]
    await Effect.runPromise(
      runShell(
        { command: "true", cwd: work, env: { PATH: HOST_DIR, HOME: work } },
        { emit: () => {} },
      ),
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
