import { Effect } from "effect"

type WaitAsync = typeof Atomics.waitAsync
type Cells = Int32Array | BigInt64Array
// `Atomics.waitAsync` is overloaded by the array type, which a union of both cannot call.
type LooseWaitAsync = (
  typedArray: Cells,
  index: number,
  value: number | bigint,
  timeout?: number,
) => ReturnType<WaitAsync>

// The cast only picks an overload: `Atomics.load` reads either kind of array at run time.
const current = (cells: Cells, index: number): number | bigint =>
  Atomics.load(cells as Int32Array, index)

const STABLE = Symbol.for("holyagent.stableWaitAsync")

/**
 * Wraps `Atomics.waitAsync` so that a wait without a timeout ends only once the cell no longer
 * holds the awaited value. A notify wakes a waiter without saying that the value changed: the
 * thread that stores and then notifies can be descheduled between the two, so its notify arrives
 * after the waiter of the next step has registered. A caller that reads the wake as "the value
 * changed" then acts on a stale state. A wait with a timeout, and a wait that finds the value
 * already different, are left as the engine gives them.
 */
export const stableWaitAsync = (waitAsync: WaitAsync): WaitAsync => {
  const native = waitAsync as LooseWaitAsync
  const stable: LooseWaitAsync = (typedArray, index, value, timeout) => {
    if (timeout !== undefined) return native(typedArray, index, value, timeout)
    const first = native(typedArray, index, value)
    if (!first.async) return first
    const changed = (pending: Promise<"ok" | "timed-out">): Effect.Effect<"ok"> =>
      Effect.promise(() => pending).pipe(
        Effect.flatMap(() => {
          if (current(typedArray, index) !== value) return Effect.succeed("ok" as const)
          const next = native(typedArray, index, value)
          return next.async ? changed(next.value) : Effect.succeed("ok" as const)
        }),
      )
    return { async: true, value: Effect.runPromise(changed(first.value)) }
  }
  return stable
}

/**
 * Replaces `Atomics.waitAsync` with {@link stableWaitAsync}, once per process. just-bash's
 * JavaScript runtime (`js-exec`) hands each synchronous call of the guest to the host through a
 * shared cell and waits for the guest's next write with `Atomics.waitAsync`. It treats a wake that
 * leaves the cell in the state the host just wrote as a protocol error and ends the run with
 * "Synchronous bridge entered an invalid request state" after the program's output, which happens
 * when the guest's notify for an earlier write arrives late (see `runSyncBridgeLoop` in `run`
 * 2.1.3, `dist/runtime/manager.js`). Nothing in the shell waits on a cell that way except that
 * runtime, and a wait that ignores a notify that changed nothing is what the call means. An engine
 * without `Atomics.waitAsync` is left as it is.
 */
export const installStableWaitAsync = (): void => {
  const atomics: { waitAsync?: WaitAsync; [STABLE]?: true } = Atomics
  if (atomics.waitAsync === undefined || atomics[STABLE] === true) return
  atomics.waitAsync = stableWaitAsync(Atomics.waitAsync.bind(Atomics))
  atomics[STABLE] = true
}
