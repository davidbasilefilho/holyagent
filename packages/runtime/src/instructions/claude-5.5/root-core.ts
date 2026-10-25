import delegating from "./root/delegating.md" with { type: "text" }
import dispatch from "./root/dispatch.md" with { type: "text" }
import identity from "./root/identity.md" with { type: "text" }
import taskList from "./root/task-list.md" with { type: "text" }

/**
 * The files of `root/` that make up the core of the root rules, in the order they open the root
 * prompt. A session whose main thread is not the root gets these and nothing else of the prompt, so
 * they stay together and small.
 */
export const ROOT_CORE_FILES: ReadonlyArray<string> = [
  "identity.md",
  "delegating.md",
  "dispatch.md",
  "task-list.md",
]

/**
 * The core of the root rules: the text of {@link ROOT_CORE_FILES} joined as the root prompt joins
 * it.
 */
export const ROOT_CORE: string = [identity, delegating, dispatch, taskList]
  .map((text) => text.trim())
  .join("\n\n")
