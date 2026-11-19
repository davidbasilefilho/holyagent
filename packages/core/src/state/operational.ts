import { lstat, realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path"

import { Effect } from "effect"

import type { OperationalResource } from "../domain/assignment.ts"
import { InvalidDraft } from "../domain/errors.ts"
import { hasCode, io } from "./files.ts"

/** Resolves a target through existing symlinks and its closest existing parent. */
const canonical = (path: string): Effect.Effect<string, InvalidDraft> =>
  io(path, () => realpath(path)).pipe(
    Effect.catch((error) => {
      if (!hasCode(error.cause, "ENOENT"))
        return Effect.fail(
          new InvalidDraft({
            message: `Cannot resolve operational target ${path}: ${error.message}`,
          }),
        )
      return io(path, () => lstat(path)).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new InvalidDraft({
              message: `Cannot resolve operational target ${path}: dangling symlink or inaccessible path`,
            }),
          ),
        ),
        Effect.catch((problem) => {
          if (problem instanceof InvalidDraft) return Effect.fail(problem)
          if (!hasCode(problem.cause, "ENOENT") || dirname(path) === path)
            return Effect.fail(
              new InvalidDraft({
                message: `Cannot inspect operational target ${path}: ${problem.message}`,
              }),
            )
          return canonical(dirname(path)).pipe(Effect.map((parent) => join(parent, basename(path))))
        }),
      )
    }),
  )

const comparable = (path: string) => resolve(path).split(sep).join("/").toLowerCase()
const contains = (parent: string, child: string) =>
  child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`)
const overlaps = (a: string, b: string) => contains(a, b) || contains(b, a)

/** Validates local targets against the known worktrees; this does not grant file permissions. */
export const validateOperationalResources = (
  resources: ReadonlyArray<OperationalResource>,
  worktrees: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    if (resources.length === 0) return
    const roots = yield* Effect.forEach(worktrees, (root) => canonical(root))
    for (const resource of resources) {
      const { target } = resource
      if (
        !isAbsolute(target) ||
        target.split(/[\\/]/).some((part) => part === "." || part === "..")
      )
        return yield* new InvalidDraft({
          message: `Operational target must be an absolute path without . or .. segments: ${target}`,
        })
      const resolved = yield* canonical(target)
      if (
        worktrees.some(
          (root, index) =>
            overlaps(comparable(root), comparable(target)) ||
            overlaps(comparable(roots[index] ?? root), comparable(resolved)),
        )
      )
        return yield* new InvalidDraft({
          message: `Operational target overlaps a repository worktree: ${target}`,
        })
    }
  })
