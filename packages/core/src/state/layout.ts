import { join } from "node:path"

import { type RoleTask, routeFor } from "../domain/route.ts"
import { recordName } from "../domain/slug.ts"

/** The versioned state folder at the project root. */
export const STATE_DIRECTORY = ".holyagent"

/** The project's settings in the state folder: not state, so tracking them says nothing about it. */
export const CONFIG_FILE = "config.json"

/**
 * Pathspec of the state folder without the project's settings: what git tracking makes
 * `.holyagent/` tracked state. Pass it after `--` to `git ls-files` or `git status`, without
 * literal pathspecs.
 */
export const TRACKED_STATE_PATHSPEC: ReadonlyArray<string> = [
  STATE_DIRECTORY,
  `:(exclude)${STATE_DIRECTORY}/${CONFIG_FILE}`,
]

/** The state folder of a project. */
export const stateDirectory = (root: string): string => join(root, STATE_DIRECTORY)

/** The folder of an Intent: `intents/<slug>-<id>`. */
export const intentFolder = (
  directory: string,
  intent: { readonly slug: string; readonly id: string },
): string => join(directory, "intents", recordName(intent.slug, intent.id))

/** The file of an Intent: `intent.json` in its folder. */
export const intentFile = (
  directory: string,
  intent: { readonly slug: string; readonly id: string },
): string => join(intentFolder(directory, intent), "intent.json")

/**
 * The file of an Assignment: `assignments/<role-task>-<slug>-<id>.json` in the folder of its
 * Intent, where the role task is the agent name, as in `worker-implementation`.
 */
export const assignmentFile = (
  intentFolderPath: string,
  assignment: { readonly roleTask: RoleTask; readonly slug: string; readonly id: string },
): string =>
  join(
    intentFolderPath,
    "assignments",
    `${routeFor(assignment.roleTask).agent}-${recordName(assignment.slug, assignment.id)}.json`,
  )

/** The file of a branch record: `branches/<id>.json` in the folder of its Intent. */
export const branchFile = (intentFolderPath: string, record: { readonly id: string }): string =>
  join(intentFolderPath, "branches", `${record.id}.json`)

/** The file of a pull request record: `pulls/<id>.json` in the folder of its Intent. */
export const pullFile = (intentFolderPath: string, record: { readonly id: string }): string =>
  join(intentFolderPath, "pulls", `${record.id}.json`)

/** A per-clone file. Everything under `local/` stays out of version control. */
export const localFile = (directory: string, name: string): string => join(directory, "local", name)
