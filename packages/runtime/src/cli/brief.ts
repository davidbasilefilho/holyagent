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
 * Writes the brief of an Assignment to its file and returns the absolute path, for the dispatch
 * prompt to name. The file is the Assignment's id with `.md`, so a repeated write replaces it.
 */
export const writeBrief = (call: Call, assignmentId: string, brief: string) =>
  Effect.gen(function* () {
    const path = join(yield* folderFor(call, "briefs"), `${assignmentId}.md`)
    yield* io(path, () => Bun.write(path, `${brief}\n`))
    return path
  })

/**
 * Writes the report of an Assignment, as a workflow's journal holds it, to `<id>.md` in the
 * `reports` folder next to the briefs, and returns the absolute path.
 */
export const writeReport = (call: Call, assignmentId: string, report: string) =>
  Effect.gen(function* () {
    const path = join(yield* folderFor(call, "reports"), `${assignmentId}.md`)
    yield* io(path, () => Bun.write(path, `${report}\n`))
    return path
  })
