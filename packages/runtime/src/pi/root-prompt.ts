import asking from "../instructions/kimi-k3.1/root/asking.md" with { type: "text" }
import assignments from "../instructions/kimi-k3.1/root/assignments.md" with { type: "text" }
import context from "../instructions/kimi-k3.1/root/context.md" with { type: "text" }
import delegating from "../instructions/kimi-k3.1/root/delegating.md" with { type: "text" }
import dispatch from "../instructions/kimi-k3.1/root/dispatch.md" with { type: "text" }
import identity from "../instructions/kimi-k3.1/root/identity.md" with { type: "text" }
import instructionGuidelines from "../instructions/kimi-k3.1/root/instruction-guidelines.md" with { type: "text" }
import prText from "../instructions/kimi-k3.1/root/pr-text.md" with { type: "text" }
import routing from "../instructions/kimi-k3.1/root/routing.md" with { type: "text" }
import search from "../instructions/kimi-k3.1/root/search.md" with { type: "text" }
import skills from "../instructions/kimi-k3.1/root/skills.md" with { type: "text" }
import stackPlan from "../instructions/kimi-k3.1/root/stack-plan.md" with { type: "text" }
import taskList from "../instructions/kimi-k3.1/root/task-list.md" with { type: "text" }
import userMessages from "../instructions/kimi-k3.1/root/user-messages.md" with { type: "text" }
import versionControl from "../instructions/kimi-k3.1/root/version-control.md" with { type: "text" }
import workflows from "../instructions/kimi-k3.1/root/workflows.md" with { type: "text" }
import historyRules from "../instructions/kimi-k3.1/shared/history-rules.md" with { type: "text" }
import precedence from "../instructions/kimi-k3.1/shared/precedence.md" with { type: "text" }
import { stripCitations } from "../instructions/skills.ts"

/**
 * The sections of the root prompt as files of the Kimi family's `root/` folder, in prompt order:
 * the same files in the same order as the Claude root agent (`ROOT_SECTIONS`), which a test
 * compares. The history rules continue the bullet list of the version-control rules, so they join
 * with a single newline.
 */
export const PI_ROOT_SECTIONS: ReadonlyArray<string> = [
  "identity.md",
  "../shared/precedence.md",
  "delegating.md",
  "dispatch.md",
  "task-list.md",
  "user-messages.md",
  "routing.md",
  "context.md",
  "workflows.md",
  "search.md",
  "assignments.md",
  "instruction-guidelines.md",
  "version-control.md",
  "../shared/history-rules.md",
  "stack-plan.md",
  "pr-text.md",
  "asking.md",
  "skills.md",
]

const TEXTS: Readonly<Record<string, string>> = {
  "identity.md": identity,
  "../shared/precedence.md": precedence,
  "delegating.md": delegating,
  "dispatch.md": dispatch,
  "task-list.md": taskList,
  "user-messages.md": userMessages,
  "routing.md": routing,
  "context.md": context,
  "workflows.md": workflows,
  "search.md": search,
  "assignments.md": assignments,
  "instruction-guidelines.md": instructionGuidelines,
  "version-control.md": versionControl,
  "../shared/history-rules.md": historyRules,
  "stack-plan.md": stackPlan,
  "pr-text.md": prText,
  "asking.md": asking,
  "skills.md": skills,
}

/**
 * The root prompt for the Kimi family, with the `${HOLYAGENT_PI_ROOT}` placeholder
 * ({@link PI_ROOT_PLACEHOLDER}) unfilled, which the extension fills with the package folder: the
 * text of {@link PI_ROOT_SECTIONS} with the maintainers' notes removed, joined as the Claude root
 * agent joins them.
 */
export const PI_ROOT_PROMPT: string = PI_ROOT_SECTIONS.map((file) =>
  stripCitations(TEXTS[file] ?? "").trim(),
).reduce(
  (text, section, at) =>
    at === 0
      ? section
      : `${text}${PI_ROOT_SECTIONS[at] === "../shared/history-rules.md" ? "\n" : "\n\n"}${section}`,
  "",
)
