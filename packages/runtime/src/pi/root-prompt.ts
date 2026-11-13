import type { PiFamily } from "../instructions/families.ts"
import gptAsking from "../instructions/gpt-6/root/asking.md" with { type: "text" }
import gptAssignments from "../instructions/gpt-6/root/assignments.md" with { type: "text" }
import gptContext from "../instructions/gpt-6/root/context.md" with { type: "text" }
import gptDelegating from "../instructions/gpt-6/root/delegating.md" with { type: "text" }
import gptDispatch from "../instructions/gpt-6/root/dispatch.md" with { type: "text" }
import gptIdentity from "../instructions/gpt-6/root/identity.md" with { type: "text" }
import gptInstructionGuidelines from "../instructions/gpt-6/root/instruction-guidelines.md" with { type: "text" }
import gptPrText from "../instructions/gpt-6/root/pr-text.md" with { type: "text" }
import gptRouting from "../instructions/gpt-6/root/routing.md" with { type: "text" }
import gptSearch from "../instructions/gpt-6/root/search.md" with { type: "text" }
import gptSkills from "../instructions/gpt-6/root/skills.md" with { type: "text" }
import gptStackPlan from "../instructions/gpt-6/root/stack-plan.md" with { type: "text" }
import gptTaskList from "../instructions/gpt-6/root/task-list.md" with { type: "text" }
import gptUserMessages from "../instructions/gpt-6/root/user-messages.md" with { type: "text" }
import gptVersionControl from "../instructions/gpt-6/root/version-control.md" with { type: "text" }
import gptWorkflows from "../instructions/gpt-6/root/workflows.md" with { type: "text" }
import gptHistoryRules from "../instructions/gpt-6/shared/history-rules.md" with { type: "text" }
import gptPrecedence from "../instructions/gpt-6/shared/precedence.md" with { type: "text" }
import kimiAsking from "../instructions/kimi-k3.1/root/asking.md" with { type: "text" }
import kimiAssignments from "../instructions/kimi-k3.1/root/assignments.md" with { type: "text" }
import kimiContext from "../instructions/kimi-k3.1/root/context.md" with { type: "text" }
import kimiDelegating from "../instructions/kimi-k3.1/root/delegating.md" with { type: "text" }
import kimiDispatch from "../instructions/kimi-k3.1/root/dispatch.md" with { type: "text" }
import kimiIdentity from "../instructions/kimi-k3.1/root/identity.md" with { type: "text" }
import kimiInstructionGuidelines from "../instructions/kimi-k3.1/root/instruction-guidelines.md" with { type: "text" }
import kimiPrText from "../instructions/kimi-k3.1/root/pr-text.md" with { type: "text" }
import kimiRouting from "../instructions/kimi-k3.1/root/routing.md" with { type: "text" }
import kimiSearch from "../instructions/kimi-k3.1/root/search.md" with { type: "text" }
import kimiSkills from "../instructions/kimi-k3.1/root/skills.md" with { type: "text" }
import kimiStackPlan from "../instructions/kimi-k3.1/root/stack-plan.md" with { type: "text" }
import kimiTaskList from "../instructions/kimi-k3.1/root/task-list.md" with { type: "text" }
import kimiUserMessages from "../instructions/kimi-k3.1/root/user-messages.md" with { type: "text" }
import kimiVersionControl from "../instructions/kimi-k3.1/root/version-control.md" with { type: "text" }
import kimiWorkflows from "../instructions/kimi-k3.1/root/workflows.md" with { type: "text" }
import kimiHistoryRules from "../instructions/kimi-k3.1/shared/history-rules.md" with { type: "text" }
import kimiPrecedence from "../instructions/kimi-k3.1/shared/precedence.md" with { type: "text" }
import { GUIDANCE_MARKER, guidanceRouter, stripCitations } from "../instructions/skills.ts"

/**
 * The sections of the root prompt as files of a family's `root/` folder, in prompt order: the same
 * files in the same order as the Claude root agent (`ROOT_SECTIONS`), which a test compares. The
 * history rules continue the bullet list of the version-control rules, so they join with a single
 * newline.
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

const TEXTS: Readonly<Record<PiFamily, Readonly<Record<string, string>>>> = {
  "kimi-k3.1": {
    "asking.md": kimiAsking,
    "assignments.md": kimiAssignments,
    "context.md": kimiContext,
    "delegating.md": kimiDelegating,
    "dispatch.md": kimiDispatch,
    "identity.md": kimiIdentity,
    "instruction-guidelines.md": kimiInstructionGuidelines,
    "pr-text.md": kimiPrText,
    "routing.md": kimiRouting,
    "search.md": kimiSearch,
    "skills.md": kimiSkills,
    "stack-plan.md": kimiStackPlan,
    "task-list.md": kimiTaskList,
    "user-messages.md": kimiUserMessages,
    "version-control.md": kimiVersionControl,
    "workflows.md": kimiWorkflows,
    "../shared/precedence.md": kimiPrecedence,
    "../shared/history-rules.md": kimiHistoryRules,
  },
  "gpt-6": {
    "asking.md": gptAsking,
    "assignments.md": gptAssignments,
    "context.md": gptContext,
    "delegating.md": gptDelegating,
    "dispatch.md": gptDispatch,
    "identity.md": gptIdentity,
    "instruction-guidelines.md": gptInstructionGuidelines,
    "pr-text.md": gptPrText,
    "routing.md": gptRouting,
    "search.md": gptSearch,
    "skills.md": gptSkills,
    "stack-plan.md": gptStackPlan,
    "task-list.md": gptTaskList,
    "user-messages.md": gptUserMessages,
    "version-control.md": gptVersionControl,
    "workflows.md": gptWorkflows,
    "../shared/precedence.md": gptPrecedence,
    "../shared/history-rules.md": gptHistoryRules,
  },
}

const promptOf = (family: PiFamily): string =>
  PI_ROOT_SECTIONS.map((file) =>
    stripCitations(TEXTS[family][file] ?? "")
      .replace(GUIDANCE_MARKER, guidanceRouter("root", family, "${HOLYAGENT_PI_ROOT}"))
      .trim(),
  ).reduce(
    (text, section, at) =>
      at === 0
        ? section
        : `${text}${PI_ROOT_SECTIONS[at] === "../shared/history-rules.md" ? "\n" : "\n\n"}${section}`,
    "",
  )

/**
 * The root prompt of each family, with the `${HOLYAGENT_PI_ROOT}` placeholder
 * ({@link PI_ROOT_PLACEHOLDER}) unfilled, which the extension fills with the package folder: the
 * text of {@link PI_ROOT_SECTIONS} with the maintainers' notes removed, joined as the Claude root
 * agent joins them.
 */
export const PI_ROOT_PROMPTS: Readonly<Record<PiFamily, string>> = {
  "kimi-k3.1": promptOf("kimi-k3.1"),
  "gpt-6": promptOf("gpt-6"),
}

/** The root prompt for the Kimi family, the Pi package's default family. */
export const PI_ROOT_PROMPT: string = PI_ROOT_PROMPTS["kimi-k3.1"]
