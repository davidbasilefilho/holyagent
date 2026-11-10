import { agentFor, ROUTES } from "../../../runtime/src/domain/route.ts"

/**
 * The names of the 18 specialists as `@tintinweb/pi-subagents` knows them: the file name and the
 * `name:` of each agent file, which is the `subagent_type` of the package's `Agent` tool and the
 * start of a child's session name. Kept apart from the generator so the extension, which runs on
 * Node inside Pi, can import it without the build's file access.
 */
export const SPECIALIST_NAMES: ReadonlyArray<string> = ROUTES.map((route) => route.agent)

/**
 * The names of the same 18 specialists as launched for an Assignment that carries the screen
 * capability, in both forms of the machine (`worker-implementation-screen`, and
 * `worker-implementation-headless-screen` on a headless one): each has an agent file of its own,
 * with the screen tools of the form added to the role's.
 */
export const SCREEN_SPECIALIST_NAMES: ReadonlyArray<string> = ROUTES.flatMap((route) => [
  agentFor(route, true, "normal"),
  agentFor(route, true, "headless"),
])

/** Every agent type a launch may name: the 18 specialists, each with and without the screen tools. */
export const AGENT_TYPES: ReadonlyArray<string> = [...SPECIALIST_NAMES, ...SCREEN_SPECIALIST_NAMES]
