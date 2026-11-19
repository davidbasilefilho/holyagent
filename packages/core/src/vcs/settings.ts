import { Effect } from "effect"

import type { Env } from "../config/environment.ts"
import { loadConfig } from "../config/load.ts"

export { VcsSettings } from "../config/schema.ts"

/**
 * Reads the `vcs` section of the HolyAgent config: the project's `.holyagent/config.json` in the
 * first of the folders that has one, over the user-level file. A missing file or section reads as
 * the defaults, and a mistake in either file is reported with that file's path.
 */
export const readSettings = (directories: ReadonlyArray<string>, env: Env = process.env) =>
  loadConfig({ projectDirectories: directories, env }).pipe(Effect.map((config) => config.vcs))
