import { statSync } from "node:fs"

import { Effect } from "effect"

import type { EnvChanges } from "./protocol.ts"

/**
 * What the shell keeps from one call to the next, as a person's terminal does: the working folder
 * and the variables the earlier calls changed. Pi starts each call with its own folder and
 * environment, so this is the difference carried on top of them.
 */
export interface ShellState {
  /** The folder the last call ended in, valid while Pi still passes `from` as its own. */
  readonly cwd: string | undefined
  /** The folder Pi passed on the call that ended in `cwd`. */
  readonly from: string | undefined
  /** The variables the calls changed: a value, or `null` for one they unset. */
  readonly delta: Readonly<Record<string, string | null>>
}

/** The state before any call. */
export const NO_STATE: ShellState = { cwd: undefined, from: undefined, delta: {} }

/**
 * The folder a call runs in: the one the last call ended in while Pi passes the same folder and
 * that folder still exists, else the folder Pi passes, which also ends any carried state that no
 * longer fits (Pi moved to another project, or the folder was removed).
 */
export const startFolder = (
  state: ShellState,
  passed: string,
  isFolder: (path: string) => boolean = isDirectory,
): string =>
  state.cwd !== undefined && state.from === passed && isFolder(state.cwd) ? state.cwd : passed

/** Whether a path is an existing folder. */
export const isDirectory = (path: string): boolean =>
  Effect.runSync(
    Effect.try(() => statSync(path).isDirectory()).pipe(Effect.orElseSucceed(() => false)),
  )

/** The environment a call runs with: Pi's, with the carried changes applied. */
export const startEnvironment = (
  passed: Readonly<Record<string, string | undefined>>,
  state: ShellState,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(passed)) if (value !== undefined) env[name] = value
  for (const [name, value] of Object.entries(state.delta))
    if (value === null) delete env[name]
    else env[name] = value
  return env
}

/**
 * The state after a call that started in `started`, ended in `cwd` with `changes`, given the folder
 * Pi passed. Calls can overlap, so `state` is the state when this call ends, and a call adds only
 * what it changed: a variable set again overrides an earlier one and drops its unset mark, and a
 * call that did not leave `started` keeps the folder another call moved to meanwhile.
 */
export const afterCall = (
  state: ShellState,
  passed: string,
  started: string,
  cwd: string,
  changes: EnvChanges,
): ShellState => {
  const delta: Record<string, string | null> = { ...state.delta }
  for (const [name, value] of Object.entries(changes.set)) delta[name] = value
  for (const name of changes.unset) delta[name] = null
  const kept = cwd === started && state.from === passed && state.cwd !== undefined
  return kept ? { ...state, delta } : { cwd, from: passed, delta }
}
