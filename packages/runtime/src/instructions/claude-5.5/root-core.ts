import delegating from "./root/delegating.md" with { type: "text" }
import dispatch from "./root/dispatch.md" with { type: "text" }
import identity from "./root/identity.md" with { type: "text" }
import taskList from "./root/task-list.md" with { type: "text" }
import precedence from "./shared/precedence.md" with { type: "text" }

/**
 * The file of `shared/` that holds the order of precedence, as a path relative to `root/` and to
 * `specialist/`. The root core and the specialist text both embed it, so the rule has one source.
 */
export const PRECEDENCE_FILE = "../shared/precedence.md"

/**
 * The files that make up the core of the root rules, in the order they open the root prompt, as
 * paths relative to `root/`. A session whose main thread is not the root gets these and nothing
 * else of the prompt, so they stay together.
 */
export const ROOT_CORE_FILES: ReadonlyArray<string> = [
  "identity.md",
  PRECEDENCE_FILE,
  "delegating.md",
  "dispatch.md",
  "task-list.md",
]

/**
 * The core of the root rules: the text of {@link ROOT_CORE_FILES} joined as the root prompt joins
 * it.
 */
export const ROOT_CORE: string = [identity, precedence, delegating, dispatch, taskList]
  .map((text) => text.trim())
  .join("\n\n")
