import { ROUTES } from "../../../runtime/src/domain/route.ts"

/**
 * The names of the 18 specialists as `@tintinweb/pi-subagents` knows them: the file name and the
 * `name:` of each agent file, which is the `subagent_type` of the package's `Agent` tool and the
 * start of a child's session name. Kept apart from the generator so the extension, which runs on
 * Node inside Pi, can import it without the build's file access.
 */
export const SPECIALIST_NAMES: ReadonlyArray<string> = ROUTES.map((route) => route.agent)
