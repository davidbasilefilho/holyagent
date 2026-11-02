import { isAbsolute, join, resolve } from "node:path"

import { Effect } from "effect"

import { io } from "../state/files.ts"
import { localFile } from "../state/layout.ts"
import { gitMaybe } from "../vcs/git.ts"
import type { Call } from "./types.ts"

/**
 * The folder the brief files of Assignments live in: `holyagent/briefs` in the git common
 * directory, which no work tree tracks and the state branch never carries, and which every work
 * tree of the clone shares. Outside a repository it is `local/briefs` of the state folder.
 */
const briefFolder = (call: Call) =>
  gitMaybe(["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
    Effect.provide(call.vcs),
    Effect.map((common) =>
      common !== undefined && isAbsolute(common)
        ? join(resolve(common), "holyagent", "briefs")
        : localFile(call.directory, "briefs"),
    ),
  )

/**
 * Writes the brief of an Assignment to its file and returns the absolute path, for the dispatch
 * prompt to name. The file is the Assignment's id with `.md`, so a repeated write replaces it.
 */
export const writeBrief = (call: Call, assignmentId: string, brief: string) =>
  Effect.gen(function* () {
    const path = join(yield* briefFolder(call), `${assignmentId}.md`)
    yield* io(path, () => Bun.write(path, `${brief}\n`))
    return path
  })
