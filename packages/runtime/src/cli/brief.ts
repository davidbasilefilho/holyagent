import { rm } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"

import { Effect } from "effect"

import type { Assignment } from "../domain/assignment.ts"
import type { AgentHost } from "../domain/host.ts"
import { firstPassPrompt } from "../prompts/index.ts"
import { io } from "../state/files.ts"
import { localFile } from "../state/layout.ts"
import { gitMaybe } from "../vcs/git.ts"
import { renderPrompt } from "./report.ts"
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

const pathIn = (call: Call, name: string, assignmentId: string) =>
  folderFor(call, name).pipe(Effect.map((folder) => join(folder, `${assignmentId}.md`)))

/**
 * Writes `text` to `<id>.md` in the named folder and returns the absolute path; a repeat replaces
 * it.
 */
const writeNamed = (call: Call, name: string, assignmentId: string, text: string) =>
  Effect.gen(function* () {
    const path = yield* pathIn(call, name, assignmentId)
    yield* io(path, () => Bun.write(path, `${text}\n`))
    return path
  })

/**
 * The text of an Assignment's brief file for a host. On Pi, the brief of `Reviewer.code` and
 * `Reviewer.security` starts with that review's first-pass prompt and then holds the Assignment,
 * which the prompt takes its range from: the brief is the task the dispatch prompt tells the
 * specialist to follow, so this is the start of the task. Every other brief, and every brief on
 * Claude (whose reviewers run the built-in reviews), is the Assignment alone ({@link
 * renderPrompt}).
 */
export const briefText = (assignment: Assignment, agent: string, host: AgentHost): string => {
  const assignmentText = renderPrompt(assignment, agent)
  const firstPass = host === "pi" ? firstPassPrompt(assignment.roleTask) : undefined
  return firstPass === undefined
    ? assignmentText
    : `${firstPass}\n\n## Assignment\n\n${assignmentText}`
}

/** The absolute path of the brief file of an Assignment, where {@link writeBrief} writes it. */
export const briefPath = (call: Call, assignmentId: string) => pathIn(call, "briefs", assignmentId)

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
 * Removes the brief and the report files of the given Assignments, once their Intent is closed and
 * nothing reads them again; the stored records keep their results. A missing file is fine. Returns
 * a line for each file that could not be removed, which the caller reports: the Intent already
 * closed, so a leftover file must not fail the command.
 */
export const removeFiles = (call: Call, assignmentIds: ReadonlyArray<string>) =>
  Effect.forEach(["briefs", "reports"], (name) => folderFor(call, name)).pipe(
    Effect.flatMap((folders) =>
      Effect.forEach(
        folders.flatMap((folder) => assignmentIds.map((id) => join(folder, `${id}.md`))),
        (path) =>
          io(path, () => rm(path, { force: true })).pipe(
            Effect.as(undefined),
            Effect.catch((error) => Effect.succeed(error.message)),
          ),
      ),
    ),
    Effect.map((lines) => lines.filter((line) => line !== undefined)),
  )
