import { rm } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import { Effect } from "effect"

import { io } from "../state/files.ts"
import { localFile } from "../state/layout.ts"
import { gitMaybe } from "../vcs/git.ts"
import type { Call } from "./types.ts"

/**
 * A folder for files of Assignments that stay out of the state: `holyagent/<name>` in the git
 * common directory, which no work tree tracks and the state branch never carries, and which every
 * work tree of the clone shares. Outside a repository it is `local/<name>` of the state folder.
 */
const folderFor = (call: Call, name: string) =>
  gitMaybe(["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.provide(call.vcs),
    Effect.map((common) =>
      common !== undefined && isAbsolute(common)
        ? join(resolve(common), "holyagent", name)
        : localFile(call.directory, name),
    ),
  )

/**
 * Writes `text` to `<id>.md` in the named folder and returns the absolute path; a repeat replaces
 * it.
 */
const writeNamed = (call: Call, name: string, assignmentId: string, text: string) =>
  Effect.gen(function* () {
    const path = join(yield* folderFor(call, name), `${assignmentId}.md`)
    yield* io(path, () => Bun.write(path, `${text}\n`))
    return path
  })

/**
 * Writes the brief of an Assignment to its file and returns the absolute path, for the dispatch
 * prompt to name. The file is the Assignment's id with `.md`, so a repeated write replaces it.
 */
export const writeBrief = (call: Call, assignmentId: string, brief: string) =>
  writeNamed(call, "briefs", assignmentId, brief)

/**
 * Writes the report of an Assignment, as a workflow's journal holds it, to `<id>.md` in the
 * `reports` folder next to the briefs, and returns the absolute path.
 */
export const writeReport = (call: Call, assignmentId: string, report: string) =>
  writeNamed(call, "reports", assignmentId, report)

/**
 * Removes the brief and the report files of an Assignment, once it is accepted and nothing reads
 * them again; the stored record keeps its result. A file that is missing or cannot be removed is
 * left, since the cleanup must not fail a transition that already committed.
 */
export const removeFiles = (call: Call, assignmentId: string) =>
  Effect.forEach(
    ["briefs", "reports"],
    (name) =>
      folderFor(call, name).pipe(
        Effect.flatMap((folder) => {
          const path = join(folder, `${assignmentId}.md`)
          return io(path, () => rm(path, { force: true }))
        }),
      ),
    { discard: true },
  ).pipe(Effect.ignore)
