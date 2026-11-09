import { closeSync, openSync, readSync } from "node:fs"
import { basename, extname } from "node:path"

import { Effect } from "effect"
import type { FsStat, IFileSystem } from "just-bash"

import { isRunnable } from "./hosts.ts"

/**
 * What runs a program that the shell was given by path (`./prog`, `node_modules/.bin/tsc`, a file
 * in a folder the call added to `PATH`): just-bash can only read such a file as a shell script, so
 * {@link withProgramLaunch} hands it a one-line script that calls this command, which starts the
 * file on the machine. The command is registered by the shell, with a stub below `/usr/bin` (the
 * only place just-bash finds a command), and the script names it by that absolute path so that a
 * `PATH` without `/usr/bin` does not hide it.
 */
export const RUNNER = "holyagent-run"

/** The path the one-line script calls {@link RUNNER} by. */
export const RUNNER_PATH = `/usr/bin/${RUNNER}`

// The interpreters whose scripts just-bash runs itself.
const SHELL_INTERPRETERS: ReadonlySet<string> = new Set(["sh", "bash", "dash", "ash"])

// Enough of a file to tell a script from a binary.
const HEAD_BYTES = 4096

const readHead = (path: string): Effect.Effect<Buffer | undefined> =>
  Effect.acquireUseRelease(
    Effect.try(() => openSync(path, "r")),
    (descriptor) =>
      Effect.try(() => {
        const head = Buffer.alloc(HEAD_BYTES)
        return head.subarray(0, readSync(descriptor, head, 0, HEAD_BYTES, 0))
      }),
    (descriptor) => Effect.sync(() => closeSync(descriptor)),
  ).pipe(Effect.orElseSucceed((): Buffer | undefined => undefined))

/**
 * The interpreter a `#!` line names (`bash` for `#!/bin/bash` and for `#!/usr/bin/env bash`), or
 * `undefined` for a file that does not start with one.
 */
export const interpreterOf = (head: Uint8Array): string | undefined => {
  if (head[0] !== 0x23 || head[1] !== 0x21) return undefined
  const [first = "", ...rest] = Buffer.from(head)
    .toString("latin1")
    .split("\n", 1)[0]!
    .slice(2)
    .trim()
    .split(/\s+/)
  const name = basename(first)
  return name === "env"
    ? basename(rest.find((word) => !word.startsWith("-") && !word.includes("=")) ?? "")
    : name
}

/**
 * What a runnable file is to the shell: `script` when just-bash can run it (a shell script, with or
 * without a `#!` line for `sh`, `bash`, `dash` or `ash`), `native` when only the machine can (a
 * binary, or a script for another interpreter such as `#!/usr/bin/env node`), `undefined` when the
 * path is not a file the user may run. On Windows a file with one of the `extensions` (`PATHEXT`)
 * is native whatever it holds.
 */
export const programKind = (
  path: string,
  platform: NodeJS.Platform,
  extensions: ReadonlyArray<string>,
): "native" | "script" | undefined => {
  const windows = platform === "win32"
  if (!isRunnable(path, windows)) return undefined
  if (windows && extensions.includes(extname(path).toLowerCase())) return "native"
  const head = Effect.runSync(readHead(path))
  if (head === undefined) return undefined
  const interpreter = interpreterOf(head)
  if (interpreter !== undefined) return SHELL_INTERPRETERS.has(interpreter) ? "script" : "native"
  return head.includes(0) ? "native" : "script"
}

/** The script that runs the machine's program at `path` with the script's own arguments. */
export const trampoline = (path: string): string =>
  `#!/bin/sh\n${RUNNER_PATH} '${path.replaceAll("'", "'\\''")}' "$@"\n`

/** What {@link withProgramLaunch} needs to know about the machine. */
export interface ProgramLaunchOptions {
  /** The machine's path for a path of the shell's file system (a drive folder on Windows). */
  readonly toHost: (path: string) => string
  /** The system whose files the shell sees. */
  readonly platform: NodeJS.Platform
  /** The extensions Windows runs as programs (`PATHEXT`, lowercase); not read elsewhere. */
  readonly extensions: ReadonlyArray<string>
}

/**
 * The file system with a program given by path made runnable. When just-bash runs a file as a
 * script it asks the file system three things in a row about the same path: `exists`, `stat` and
 * then `readFile`, and nothing else does (`cat`, `grep` and the rest read without the `exists`). On
 * that sequence, a file that is native to the machine (see {@link programKind}) is read as the
 * {@link trampoline} instead of its bytes, so the machine runs it; every other read, a shell script
 * included, is the file as it is. On Windows `stat` also reports the execute bit for a file with a
 * program extension, which the disk does not have and just-bash requires.
 */
export const withProgramLaunch = (fs: IFileSystem, options: ProgramLaunchOptions): IFileSystem => {
  const windows = options.platform === "win32"
  const recent: Array<readonly [string, string]> = []
  return new Proxy(fs, {
    get: (target, name) => {
      const member: unknown = Reflect.get(target, name, target)
      if (typeof member !== "function" || typeof name !== "string") return member
      return (...args: Array<unknown>) => {
        const path = typeof args[0] === "string" ? args[0] : ""
        const [first, second] = recent
        const asScript =
          name === "readFile" &&
          first?.[0] === "exists" &&
          second?.[0] === "stat" &&
          first[1] === path &&
          second[1] === path
        recent.push([name, path])
        if (recent.length > 2) recent.shift()
        if (
          asScript &&
          programKind(options.toHost(path), options.platform, options.extensions) === "native"
        )
          return Effect.runPromise(Effect.succeed(trampoline(options.toHost(path))))
        const result: unknown = Reflect.apply(member, target, args)
        if (
          !windows ||
          (name !== "stat" && name !== "lstat") ||
          !options.extensions.includes(extname(path).toLowerCase())
        )
          return result
        // A plain promise chain, so that a rejection (a missing file) reaches the caller unchanged.
        return (result as Promise<FsStat>).then((stat): FsStat => ({
          ...stat,
          mode: stat.mode | 0o111,
        }))
      }
    },
  })
}
