import type { Family } from "./families.ts"

/**
 * Where a family's instructions implement a requirement. `section` is a Markdown file of the family
 * folder, as a path from it (`skills/<name>/SKILL.md` for a skill), and `phrase` is text of that
 * file that carries the requirement. A requirement that no prompt text can carry, because code,
 * settings or documentation enforce it, names that file in `carriedBy`, as a path from the
 * repository root, with a phrase of it.
 */
export type Coverage =
  | { readonly section: string; readonly phrase: string }
  | { readonly carriedBy: string; readonly phrase: string }

/**
 * Where each family's instructions implement each requirement of `requirements/`, by id. A test
 * fails for a requirement without an entry in a listed family, an entry for no requirement and a
 * file that no longer holds its phrase, so a requirement cannot go unimplemented unnoticed. A table
 * stands in for tags inside the files, which would add text to every generated agent. A family
 * joins `FAMILIES` together with its entry here, which the type requires.
 */
export const REQUIREMENT_COVERAGE: Readonly<Record<Family, Readonly<Record<string, Coverage>>>> = {
  "claude-5.5": {
    "R-HANDOFF": {
      section: "skills/state-mode/SKILL.md",
      phrase: "after each Assignment close and merge",
    },
    "R-HANDOFF-ROUTE": {
      section: "root/skills.md",
      phrase: "load the state-mode skill for handoff durability",
    },
    "R-VISUAL-ITERATION": {
      section: "skills/visual-judging/SKILL.md",
      phrase: "After the root creates each source commit",
    },
    "R-DESIGN-QUALITY": {
      section: "design-core/core.md",
      phrase: "fluid component and route animation",
    },
    "R-PERFORMANCE": {
      section: "skills/performance-iteration/SKILL.md",
      phrase: "immediately previous commit",
    },
    "R-PERFORMANCE-ORDER": {
      section: "skills/performance-iteration/SKILL.md",
      phrase: "After the root creates each source commit",
    },
    "R-SKILLS": {
      section: "root/skills.md",
      phrase:
        "complete and accept baseline collection before dispatching any task source-writing Assignment",
    },
    "R-PERFORMANCE-ROUTE": { section: "root/delegating.md", phrase: "performance-iteration" },
    "R-GPT-PROSE": {
      carriedBy: "scripts/stop-slop-policy.test.ts",
      phrase: "other families remain unchanged",
    },
    "R-TERSE": { section: "specialist/conduct.md", phrase: "Respond tersely." },
    "R-ROLE": { section: "root/identity.md", phrase: "Own the user relationship" },
    "R-PRECEDENCE": { section: "shared/precedence.md", phrase: "When rules conflict" },
    "R-STACK": { section: "root/stack-plan.md", phrase: "stacks in work order by default" },
    "R-TASKLIST": { section: "root/task-list.md", phrase: "Create the task list first" },
    "R-TURN": {
      section: "root/task-list.md",
      phrase: "End your turn only when done or nothing can move",
    },
    "R-ACK": { section: "root/user-messages.md", phrase: "Acknowledge every user message" },
    "R-NUDGE": { section: "root/user-messages.md", phrase: "one short line at most" },
    "R-MERGEREVIEW": {
      section: "root/stack-plan.md",
      phrase: "gets a review of that head before any push",
    },
    "R-NAMED": { section: "root/user-messages.md", phrase: "names an action" },
    "R-IDEAS": { section: "root/user-messages.md", phrase: "asks for ideas, options or a plan" },
    "R-FLAG": {
      section: "root/user-messages.md",
      phrase: "in your acknowledgment of that message and continue as asked",
    },
    "R-DECIDE": {
      section: "root/task-list.md",
      phrase: "Send every pending decision through AskUserQuestion",
    },
    "R-REASK": {
      section: "root/asking.md",
      phrase: "preserve settled intent and authorization",
    },
    "R-AMBIGUOUS": {
      section: "root/asking.md",
      phrase: "ask before acting on any remaining ambiguity",
    },
    "R-NOBYPASS": {
      section: "root/identity.md",
      phrase: "required approval is obtained and any host restriction is resolved",
    },
    "R-LANG": {
      section: "root/identity.md",
      phrase: "in the language of the user's latest message",
    },
    "R-NOFILLER": {
      section: "root/identity.md",
      phrase: "free of filler, redundant summaries and boilerplate",
    },
    "R-OUTWARD": { section: "root/identity.md", phrase: "need user approval" },
    "R-DELEGATE": {
      section: "root/delegating.md",
      phrase: "Delegate edits, runs, checks, reviews, research and investigation to specialists",
    },
    "R-LEAN": {
      section: "root/context.md",
      phrase: "Run no gates, probes or data checks yourself",
    },
    "R-SEARCH": { section: "root/search.md", phrase: "Search file contents with `holyagent rg`" },
    "R-NORESOLVE": { section: "root/delegating.md", phrase: "stop and report it" },
    "R-ROUTE": { section: "root/routing.md", phrase: "cheapest specialist" },
    "R-DISPATCH": { section: "root/dispatch.md", phrase: "`assignment dispatch --input '<json>'`" },
    "R-WORKFLOW": { section: "root/workflows.md", phrase: "no prebuilt script exists" },
    "R-WAIT": { section: "root/dispatch.md", phrase: "A timeout does not guarantee cache reuse" },
    "R-REPORT": { section: "root/dispatch.md", phrase: "never retyped or summarized" },
    "R-WAKE": {
      section: "root/dispatch.md",
      phrase: "respond to completion, submitted input or a supported bounded wait timeout",
    },
    "R-STOP": {
      section: "root/dispatch.md",
      phrase: "only for conflicting new requirements or information",
    },
    "R-RESUME": { section: "root/dispatch.md", phrase: "confirmed gone" },
    "R-CRITERIA": { section: "root/assignments.md", phrase: "constraints go in verbatim" },
    "R-ACCEPT": {
      section: "root/assignments.md",
      phrase: "judged from the diff summary and the check output",
    },
    "R-REVIEW": { section: "root/assignments.md", phrase: "gets an independent reviewer" },
    "R-FINISH": { section: "root/assignments.md", phrase: "one more repair round" },
    "R-SCREEN": { section: "root/assignments.md", phrase: "Set `screen: true` in the draft" },
    "R-VISUAL": {
      section: "skills/visual-judging/SKILL.md",
      phrase: "Your own final pass, after Worker.visual and Reviewer.visual, decides acceptance",
    },
    "R-OWNEDROUTES": {
      section: "root/skills.md",
      phrase: "Read the relevant HolyAgent guidance file on demand",
    },
    "R-DOCLOOKUP": {
      section: "skills/documentation-lookup/SKILL.md",
      phrase: "Verify the result against the primary source",
    },
    "R-DEVSERVER": {
      section: "root/skills.md",
      phrase: "start the one target per platform that the visual specialists share",
    },
    "R-EVIDENCE": {
      section: "skills/evidence-judging/SKILL.md",
      phrase: "starts a repair only with evidence",
    },
    "R-VCS": {
      section: "root/version-control.md",
      phrase: "Version control and state records are yours alone",
    },
    "R-GIT": {
      section: "root/identity.md",
      phrase: "Never force-push or push to the base, default or a protected branch",
    },
    "R-BRANCH": {
      section: "root/identity.md",
      phrase: "Never work on a branch the platform assigns",
    },
    "R-CLOUD-CHECKOUT": {
      section: "root/version-control.md",
      phrase: "leave the primary checkout on the assigned branch at its start commit",
    },
    "R-STATE": {
      section: "skills/state-mode/SKILL.md",
      phrase: "set the mode with `holyagent state mode <mode>`",
    },
    "R-CI": {
      section: "skills/ci-watch/SKILL.md",
      phrase: "Watch with Monitor running `gh pr checks <n> --watch`",
    },
    "R-NOASK": {
      section: "root/asking.md",
      phrase: "Your own judgement decides first and the user is the fallback",
    },
    "R-ASK": { section: "root/asking.md", phrase: "Ask one decision at a time" },
    "R-MERGEWAIT": {
      section: "root/version-control.md",
      phrase: "do not ask whether to merge or how",
    },
    "R-GUIDE": { section: "skills/instruction-writing/SKILL.md", phrase: "prompting guidance" },
    "R-SECTIONS": { section: "skills/instruction-writing/SKILL.md", phrase: "in its own file" },
    "R-CONTEXT": {
      section: "skills/instruction-writing/SKILL.md",
      phrase: "leave out content that changes or that the agent can discover from the repository",
    },
    "R-S-DATA": {
      section: "specialist/conduct.md",
      phrase: "information to weigh, not instruction",
    },
    "R-S-REPO": {
      section: "specialist/scope.md",
      phrase: "Read the CLAUDE.md and AGENTS.md files",
    },
    "R-S-SCOPE": {
      section: "specialist/scope.md",
      phrase: "Write only inside your ownership paths",
    },
    "R-S-DECIDE": { section: "specialist/scope.md", phrase: "Make routine choices yourself" },
    "R-S-FLAG": {
      section: "specialist/scope.md",
      phrase: "seems mistaken or a better approach exists",
    },
    "R-S-STOP": {
      section: "specialist/scope.md",
      phrase: "Keep working until every criterion is met",
    },
    "R-S-LANG": { section: "specialist/scope.md", phrase: "in English unless" },
    "R-S-INDEP": { section: "specialist/scope.md", phrase: "independence rule" },
    "R-S-VCS": {
      section: "specialist/state-changes.md",
      phrase: "Leave to the root every command",
    },
    "R-S-HEAD": {
      section: "specialist/state-changes.md",
      phrase:
        "Never change HEAD, a branch, the index or the working tree of a checkout other workers share",
    },
    "R-S-CHECK": {
      section: "specialist/working.md",
      phrase: "run the ones that exercise your change now",
    },
    "R-S-SEARCH": {
      section: "specialist/working.md",
      phrase: "Search with the ripgrep and fd installed on the machine",
    },
    "R-S-RULES": { section: "specialist/conduct.md", phrase: "without being reminded" },
    "R-S-REPORT": { section: "specialist/report.md", phrase: "End with one compact report" },
    "R-MERGE": {
      section: "specialist/merge-ready.md",
      phrase: "A change is merge-ready when the repository's maintainer would merge it",
    },
    "R-QUALITY": {
      section: "specialist/code-quality.md",
      phrase:
        "a finding blocks only when the change also makes existing behavior or performance worse",
    },
    "R-EL": { section: "roles/explorer-lookup/method.md", phrase: "Locate with Grep and Glob" },
    "R-EM": { section: "roles/explorer-map/method.md", phrase: "Cite a path" },
    "R-ET": { section: "roles/explorer-trace/method.md", phrase: "Begin at the trigger" },
    "R-LL": { section: "roles/librarian-lookup/method.md", phrase: "Look in the project first" },
    "R-LR": {
      section: "roles/librarian-research/method.md",
      phrase: "Prefer accessible official documentation",
    },
    "R-RA": {
      section: "roles/reviewer-artifact/method.md",
      phrase: "Give each acceptance criterion a verdict",
    },
    "R-RA-CONTEXT": {
      section: "roles/reviewer-artifact/instruction-text.md",
      phrase: "an existing file's departure from this is a finding only when the user asked",
    },
    "R-RAU": {
      section: "roles/reviewer-audit/method.md",
      phrase: "verified, discrepant or unverified",
    },
    "R-RC": { section: "roles/reviewer-code/builtin-review.md", phrase: "`/code-review`" },
    "R-RS": { section: "roles/reviewer-security/findings.md", phrase: "Substantiate each finding" },
    "R-RT": {
      section: "roles/reviewer-testing/method.md",
      phrase: "Map each acceptance criterion",
    },
    "R-RV": {
      section: "roles/reviewer-visual/captures.md",
      phrase: "Report the inspection as blocked when no captures are supplied",
    },
    "R-RV-DESIGN": {
      section: "roles/reviewer-visual/design.md",
      phrase: "read that file and judge against its checklist",
    },
    "R-INSPECT": {
      section: "specialist/interface-inspection.md",
      phrase: "A passing build, snapshot or test does not show what renders",
    },
    "R-MATERIAL": {
      section: "shared/materiality.md",
      phrase: "A discrepancy is material, and starts a repair whatever its size",
    },
    "R-WD": { section: "roles/worker-debugging/phases.md", phrase: "Reproduce" },
    "R-WI": {
      section: "roles/worker-implementation/method.md",
      phrase: "smallest complete change",
    },
    "R-WI-TEXT": {
      section: "roles/worker-implementation/instruction-text.md",
      phrase: "writing bar",
    },
    "R-WI-CONTEXT": {
      section: "roles/worker-implementation/instruction-text.md",
      phrase: "change an existing file that departs from this only when the user asks",
    },
    "R-WIN": { section: "roles/worker-integration/method.md", phrase: "end to end" },
    "R-WM": { section: "roles/worker-mechanical/method.md", phrase: "Find every site" },
    "R-WO": { section: "roles/worker-operations/method.md", phrase: "documented workflow" },
    "R-WO-DEV": {
      section: "roles/worker-operations/dev-server.md",
      phrase: "Report the completed record and whether you started the target or reused it",
    },
    "R-WV": { section: "roles/worker-validation/method.md", phrase: "choose the real check" },
    "R-WVI": {
      section: "roles/worker-visual/purpose.md",
      phrase: "The Assignment names the repair round",
    },
    "R-WVI-DESIGN": {
      section: "roles/worker-visual/design.md",
      phrase: "read that file first, then build and inspect against its checklist and capture list",
    },

    "R-CACHE-STATIC": {
      carriedBy: "packages/runtime/tests/instructions.test.ts",
      phrase: "hold no dates, times or other time-varying text",
    },
    "R-CACHE-REUSE": { section: "root/dispatch.md", phrase: "or warm agent" },
    "R-CACHE-WINDOW": {
      carriedBy: "packages/core/src/setup/settings.ts",
      phrase: "subagentPromptCacheTtl",
    },
    "R-CACHE-COMPACT": { section: "specialist/report.md", phrase: "End with one compact report" },
    "R-COMMIT-OWNER": {
      section: "root/version-control.md",
      phrase: "Commits and PR text read as the account owner wrote them",
    },
    "R-COMMIT-CONVENTION": {
      section: "root/version-control.md",
      phrase: "The target repository's conventions",
    },
    "R-COMMIT-ATOMIC": {
      section: "root/version-control.md",
      phrase: "each commit on a branch is atomic",
    },
    "R-COMMIT-PR": {
      section: "root/pr-text.md",
      phrase: "Say what changed and why, how it was checked",
    },
    "R-CTX-EFFORT": { carriedBy: "docs/usage.md", phrase: "The root's effort and window" },
    "R-CTX-ENV": { carriedBy: "docs/usage.md", phrase: "Never set `CLAUDE_CODE_EFFORT_LEVEL`" },
    "R-CTX-READ": {
      section: "root/context.md",
      phrase: "Open a report file or a diff only to settle a concrete doubt",
    },
    "R-MERGE-DIMENSIONS": {
      section: "specialist/merge-ready.md",
      phrase:
        "| repo-standards | A rule in CLAUDE.md, AGENTS.md or the contributing guide is broken",
    },
    "R-MERGE-BLOCKER": {
      section: "specialist/merge-ready.md",
      phrase: "A blocker in any dimension fails the change",
    },
  },
  "kimi-k3.1": {
    "R-HANDOFF": {
      section: "skills/state-mode/SKILL.md",
      phrase: "after each Assignment close and merge",
    },
    "R-HANDOFF-ROUTE": {
      section: "root/skills.md",
      phrase: "load the state-mode skill for handoff durability",
    },
    "R-VISUAL-ITERATION": {
      section: "skills/visual-judging/SKILL.md",
      phrase: "After the root creates each source commit",
    },
    "R-DESIGN-QUALITY": {
      section: "design-core/core.md",
      phrase: "fluid component and route animation",
    },
    "R-PERFORMANCE": {
      section: "skills/performance-iteration/SKILL.md",
      phrase: "immediately previous commit",
    },
    "R-PERFORMANCE-ORDER": {
      section: "skills/performance-iteration/SKILL.md",
      phrase: "After the root creates each source commit",
    },
    "R-SKILLS": {
      section: "root/skills.md",
      phrase:
        "complete and accept baseline collection before dispatching any task source-writing Assignment",
    },
    "R-PERFORMANCE-ROUTE": { section: "root/delegating.md", phrase: "performance-iteration" },
    "R-GPT-PROSE": {
      carriedBy: "scripts/stop-slop-policy.test.ts",
      phrase: "other families remain unchanged",
    },
    "R-ROLE": { section: "root/identity.md", phrase: "You own the user relationship" },
    "R-NOBYPASS": {
      section: "root/identity.md",
      phrase: "required approval is obtained and any host restriction is resolved",
    },
    "R-LANG": {
      section: "root/identity.md",
      phrase: "in the language of the user's latest message",
    },
    "R-NOFILLER": {
      section: "root/identity.md",
      phrase: "free of filler sections, redundant summaries and boilerplate",
    },
    "R-OUTWARD": { section: "root/identity.md", phrase: "need the user's approval" },
    "R-GIT": {
      section: "root/identity.md",
      phrase: "Never force-push, and never push to the base, default or a protected branch",
    },
    "R-BRANCH": {
      section: "root/identity.md",
      phrase: "Never work on a branch the platform assigns",
    },
    "R-CLOUD-CHECKOUT": {
      section: "root/version-control.md",
      phrase: "leave the primary checkout on the assigned branch at its start commit",
    },
    "R-REASK": {
      section: "root/asking.md",
      phrase: "preserve settled intent and authorization",
    },
    "R-AMBIGUOUS": {
      section: "root/asking.md",
      phrase: "ask before acting on any remaining ambiguity",
    },
    "R-NOASK": {
      section: "root/asking.md",
      phrase: "Your own judgement decides first and the user is the fallback",
    },
    "R-ASK": { section: "root/asking.md", phrase: "Ask one decision at a time" },
    "R-CRITERIA": { section: "root/assignments.md", phrase: "constraints go in verbatim" },
    "R-ACCEPT": {
      section: "root/assignments.md",
      phrase: "Judge delegated work from the diff summary and the check output",
    },
    "R-REVIEW": { section: "root/assignments.md", phrase: "gets an independent reviewer" },
    "R-FINISH": { section: "root/assignments.md", phrase: "one more repair round" },
    "R-SCREEN": { section: "root/assignments.md", phrase: "Set `screen: true` in the draft" },
    "R-LEAN": {
      section: "root/context.md",
      phrase: "Run no gates, probes or data checks yourself",
    },
    "R-CACHE-STATIC": {
      carriedBy: "packages/runtime/tests/instructions.test.ts",
      phrase: "hold no dates, times or other time-varying text",
    },
    "R-CACHE-WINDOW": {
      carriedBy: "docs/cache-and-workflows.md",
      phrase: "HOLYAGENT_REUSE_TTL_MINUTES",
    },
    "R-CTX-EFFORT": {
      section: "root/context.md",
      phrase: "Your own effort is fixed by the launch",
    },
    "R-CTX-ENV": {
      section: "root/context.md",
      phrase: "set no environment variable or flag that overrides it",
    },
    "R-CTX-READ": { section: "root/context.md", phrase: "Read only what a decision needs" },
    "R-DELEGATE": { section: "root/delegating.md", phrase: "go to specialists" },
    "R-NORESOLVE": { section: "root/delegating.md", phrase: "stop and report it" },
    "R-DISPATCH": { section: "root/dispatch.md", phrase: "`assignment dispatch`" },
    "R-REPORT": { section: "root/dispatch.md", phrase: "never retyped or summarized" },
    "R-WAKE": {
      section: "root/dispatch.md",
      phrase: "respond to completion, submitted input or a supported bounded wait timeout",
    },
    "R-STOP": {
      section: "root/dispatch.md",
      phrase: "only when a new requirement or new information conflicts with that running work",
    },
    "R-RESUME": { section: "root/dispatch.md", phrase: "confirmed gone" },
    "R-CACHE-REUSE": {
      section: "root/dispatch.md",
      phrase: "selects an idle specialist of the same role, model and effort",
    },
    "R-COMMIT-PR": {
      section: "root/pr-text.md",
      phrase: "Say what changed and why, how it was checked",
    },
    "R-ROUTE": { section: "root/routing.md", phrase: "cheapest specialist" },
    "R-SEARCH": {
      section: "root/search.md",
      phrase: "search through the available shell with `rg` and `fd`",
    },
    "R-OWNEDROUTES": {
      section: "root/skills.md",
      phrase: "Read the relevant HolyAgent guidance file on demand",
    },
    "R-DOCLOOKUP": {
      section: "skills/documentation-lookup/SKILL.md",
      phrase: "Verify the result against the primary source",
    },
    "R-DEVSERVER": {
      section: "root/skills.md",
      phrase: "start one render target for visual work",
    },
    "R-STACK": { section: "root/stack-plan.md", phrase: "stacks in work order by default" },
    "R-MERGEREVIEW": {
      section: "root/stack-plan.md",
      phrase: "gets a review of that head before any push",
    },
    "R-TASKLIST": { section: "root/task-list.md", phrase: "Create the task list first" },
    "R-TURN": { section: "root/task-list.md", phrase: "End your turn only when the work is done" },
    "R-DECIDE": {
      section: "root/task-list.md",
      phrase: "Every pending decision goes through `ask_user_question`",
    },
    "R-ACK": { section: "root/user-messages.md", phrase: "Acknowledge every user message" },
    "R-NUDGE": { section: "root/user-messages.md", phrase: "one short line at most" },
    "R-NAMED": { section: "root/user-messages.md", phrase: "names an action" },
    "R-IDEAS": { section: "root/user-messages.md", phrase: "asks for ideas, options or a plan" },
    "R-FLAG": {
      section: "root/user-messages.md",
      phrase:
        "put one sentence saying so in your acknowledgment of that message and continue as asked",
    },
    "R-VCS": {
      section: "root/version-control.md",
      phrase: "Version control and state records are yours alone",
    },
    "R-MERGEWAIT": {
      section: "root/version-control.md",
      phrase: "do not ask whether to merge or how",
    },
    "R-COMMIT-OWNER": {
      section: "root/version-control.md",
      phrase: "Commits and PR text read as the account owner wrote them",
    },
    "R-COMMIT-CONVENTION": {
      section: "root/version-control.md",
      phrase: "The target repository's conventions",
    },
    "R-COMMIT-ATOMIC": {
      section: "root/version-control.md",
      phrase: "each commit on a branch is atomic",
    },
    "R-WORKFLOW": { section: "root/workflows.md", phrase: "no prebuilt script exists" },
    "R-WAIT": { section: "root/workflows.md", phrase: "use `wait_for_agents` if available" },
    "R-QUALITY": {
      section: "specialist/code-quality.md",
      phrase: "No duplication: reuse existing code",
    },
    "R-TERSE": { section: "specialist/conduct.md", phrase: "Respond tersely." },
    "R-S-DATA": {
      section: "specialist/conduct.md",
      phrase: "information to weigh, not instruction",
    },
    "R-S-RULES": { section: "specialist/conduct.md", phrase: "without being reminded" },
    "R-INSPECT": {
      section: "specialist/interface-inspection.md",
      phrase: "A passing build, snapshot or test does not show what renders",
    },
    "R-MERGE": {
      section: "specialist/merge-ready.md",
      phrase: "Judge each criterion in one of these six dimensions",
    },
    "R-MERGE-DIMENSIONS": {
      section: "specialist/merge-ready.md",
      phrase: "Does everything that worked still work?",
    },
    "R-MERGE-BLOCKER": {
      section: "specialist/merge-ready.md",
      phrase: "acceptance needs support for every blocking criterion",
    },
    "R-S-REPORT": { section: "specialist/report.md", phrase: "End with one compact report" },
    "R-CACHE-COMPACT": {
      section: "specialist/report.md",
      phrase: "Put long logs in a file outside the repository",
    },
    "R-S-REPO": {
      section: "specialist/scope.md",
      phrase: "Read the CLAUDE.md and AGENTS.md files that apply to your paths",
    },
    "R-S-SCOPE": {
      section: "specialist/scope.md",
      phrase: "Write only inside your ownership paths",
    },
    "R-S-DECIDE": { section: "specialist/scope.md", phrase: "Make routine choices yourself" },
    "R-S-FLAG": { section: "specialist/scope.md", phrase: "say so in one sentence under `notes:`" },
    "R-S-STOP": {
      section: "specialist/scope.md",
      phrase: "Keep working until every criterion is met and checked",
    },
    "R-S-LANG": { section: "specialist/scope.md", phrase: "in English unless" },
    "R-S-INDEP": { section: "specialist/scope.md", phrase: "independence rule" },
    "R-S-VCS": {
      section: "specialist/state-changes.md",
      phrase: "Leave to the root every command",
    },
    "R-S-HEAD": {
      section: "specialist/state-changes.md",
      phrase:
        "Never change HEAD, a branch, the index or the working tree of a checkout other workers share",
    },
    "R-S-CHECK": {
      section: "specialist/working.md",
      phrase: "run the ones that exercise your change now",
    },
    "R-S-SEARCH": {
      section: "specialist/working.md",
      phrase: "use the role's built-in `find` and `grep` through codemode",
    },
    "R-MATERIAL": {
      section: "shared/materiality.md",
      phrase: "A discrepancy is material, and starts a repair whatever its size",
    },
    "R-PRECEDENCE": { section: "shared/precedence.md", phrase: "When rules conflict" },
    "R-EL": {
      section: "roles/explorer-lookup/method.md",
      phrase: "Locate the fact with `tools.grep` and `tools.find`",
    },
    "R-EM": { section: "roles/explorer-map/method.md", phrase: "Cite a path" },
    "R-ET": { section: "roles/explorer-trace/method.md", phrase: "Begin at the trigger" },
    "R-LL": { section: "roles/librarian-lookup/method.md", phrase: "Look in the project first" },
    "R-LR": {
      section: "roles/librarian-research/method.md",
      phrase: "Prefer accessible official documentation",
    },
    "R-RA": {
      section: "roles/reviewer-artifact/method.md",
      phrase: "Give each acceptance criterion a verdict",
    },
    "R-RA-CONTEXT": {
      section: "roles/reviewer-artifact/instruction-text.md",
      phrase: "an existing file's departure from this is a finding only when the user asked",
    },
    "R-RAU": {
      section: "roles/reviewer-audit/method.md",
      phrase: "verified, discrepant or unverified",
    },
    "R-RC": { section: "roles/reviewer-code/builtin-review.md", phrase: "`code-review`" },
    "R-RS": {
      section: "roles/reviewer-security/findings.md",
      phrase: "Label validated vulnerabilities apart from suspicions",
    },
    "R-RT": {
      section: "roles/reviewer-testing/method.md",
      phrase: "Map each acceptance criterion",
    },
    "R-RV": {
      section: "roles/reviewer-visual/captures.md",
      phrase:
        "Report the inspection as blocked when no target record is named or no captures are supplied",
    },
    "R-RV-DESIGN": {
      section: "roles/reviewer-visual/design.md",
      phrase: "read that file and judge against its checklist",
    },
    "R-WD": {
      section: "roles/worker-debugging/phases.md",
      phrase: "Reproduce: build a deterministic reproduction",
    },
    "R-WI": {
      section: "roles/worker-implementation/method.md",
      phrase: "smallest complete change",
    },
    "R-WI-TEXT": {
      section: "roles/worker-implementation/instruction-text.md",
      phrase: "meet the writing bar below",
    },
    "R-WI-CONTEXT": {
      section: "roles/worker-implementation/instruction-text.md",
      phrase: "change an existing file that departs from this only when the user asks",
    },
    "R-WIN": { section: "roles/worker-integration/method.md", phrase: "end to end" },
    "R-WM": { section: "roles/worker-mechanical/method.md", phrase: "Find every site" },
    "R-WO": { section: "roles/worker-operations/method.md", phrase: "documented workflow" },
    "R-WO-DEV": {
      section: "roles/worker-operations/dev-server.md",
      phrase: "Report the completed record and whether you started the target or reused it",
    },
    "R-WV": { section: "roles/worker-validation/method.md", phrase: "choose the real check" },
    "R-WVI": {
      section: "roles/worker-visual/purpose.md",
      phrase: "The Assignment names the repair round and its limit",
    },
    "R-WVI-DESIGN": {
      section: "roles/worker-visual/design.md",
      phrase: "read that file first, then build and inspect against its checklist and capture list",
    },
    "R-VISUAL": {
      section: "skills/visual-judging/SKILL.md",
      phrase: "Your own final pass, after Worker.visual and Reviewer.visual, decides acceptance",
    },
    "R-EVIDENCE": {
      section: "skills/evidence-judging/SKILL.md",
      phrase: "starts a repair only with evidence",
    },
    "R-STATE": {
      section: "skills/state-mode/SKILL.md",
      phrase: "set the mode with `holyagent state mode <mode>`",
    },
    "R-CI": {
      section: "skills/ci-watch/SKILL.md",
      phrase: "Run `gh pr checks <n> --watch` as a background process",
    },
    "R-GUIDE": {
      section: "skills/instruction-writing/SKILL.md",
      phrase: "Put the full task with its reasons in every brief",
    },
    "R-SECTIONS": {
      section: "skills/instruction-writing/SKILL.md",
      phrase: "Keep each prompt section in its own file",
    },
    "R-CONTEXT": {
      section: "skills/instruction-writing/SKILL.md",
      phrase: "leave out content that changes or that the agent can discover from the repository",
    },
  },
  "gpt-6": {
    "R-HANDOFF": {
      section: "skills/state-mode/SKILL.md",
      phrase: "after each Assignment close and merge",
    },
    "R-HANDOFF-ROUTE": {
      section: "root/skills.md",
      phrase: "load the state-mode skill for handoff durability",
    },
    "R-VISUAL-ITERATION": {
      section: "skills/visual-judging/SKILL.md",
      phrase: "After the root creates each source commit",
    },
    "R-DESIGN-QUALITY": {
      section: "design-core/core.md",
      phrase: "fluid component and route animation",
    },
    "R-PERFORMANCE": {
      section: "skills/performance-iteration/SKILL.md",
      phrase: "immediately previous commit",
    },
    "R-PERFORMANCE-ORDER": {
      section: "skills/performance-iteration/SKILL.md",
      phrase: "After the root creates each source commit",
    },
    "R-SKILLS": {
      section: "root/skills.md",
      phrase:
        "complete and accept baseline collection before dispatching any task source-writing Assignment",
    },
    "R-PERFORMANCE-ROUTE": { section: "root/delegating.md", phrase: "performance-iteration" },
    "R-GPT-PROSE": {
      section: "specialist/conduct.md",
      phrase: "For human-facing prose, write directly and specifically",
    },
    "R-ROLE": { section: "root/identity.md", phrase: "You own the user relationship" },
    "R-NOBYPASS": {
      section: "root/identity.md",
      phrase: "required approval is obtained and any host restriction is resolved",
    },
    "R-LANG": {
      section: "root/identity.md",
      phrase: "in the language of the user's latest message",
    },
    "R-NOFILLER": {
      section: "root/identity.md",
      phrase: "free of filler sections, redundant summaries and boilerplate",
    },
    "R-OUTWARD": { section: "root/identity.md", phrase: "need the user's approval" },
    "R-GIT": {
      section: "root/identity.md",
      phrase: "Never force-push, and never push to the base, default or a protected branch",
    },
    "R-BRANCH": {
      section: "root/identity.md",
      phrase: "Never work on a branch the platform assigns",
    },
    "R-CLOUD-CHECKOUT": {
      section: "root/version-control.md",
      phrase: "leave the primary checkout on the assigned branch at its start commit",
    },
    "R-REASK": {
      section: "root/asking.md",
      phrase: "preserve settled intent and authorization",
    },
    "R-AMBIGUOUS": {
      section: "root/asking.md",
      phrase: "ask before acting on any remaining ambiguity",
    },
    "R-NOASK": {
      section: "root/asking.md",
      phrase: "Your own judgement decides first and the user is the fallback",
    },
    "R-ASK": { section: "root/asking.md", phrase: "Ask one decision at a time" },
    "R-CRITERIA": { section: "root/assignments.md", phrase: "constraints go in verbatim" },
    "R-ACCEPT": {
      section: "root/assignments.md",
      phrase: "Judge delegated work from the diff summary and the check output",
    },
    "R-REVIEW": { section: "root/assignments.md", phrase: "gets an independent reviewer" },
    "R-FINISH": { section: "root/assignments.md", phrase: "one more repair round" },
    "R-SCREEN": { section: "root/assignments.md", phrase: "Set `screen: true` in the draft" },
    "R-LEAN": {
      section: "root/context.md",
      phrase: "Run no gates, probes or data checks yourself",
    },
    "R-CACHE-STATIC": {
      carriedBy: "packages/runtime/tests/instructions.test.ts",
      phrase: "hold no dates, times or other time-varying text",
    },
    "R-CACHE-WINDOW": {
      carriedBy: "docs/cache-and-workflows.md",
      phrase: "HOLYAGENT_REUSE_TTL_MINUTES",
    },
    "R-CTX-EFFORT": {
      section: "root/context.md",
      phrase: "Your own effort is fixed by the launch",
    },
    "R-CTX-ENV": {
      section: "root/context.md",
      phrase: "set no environment variable or flag that overrides it",
    },
    "R-CTX-READ": { section: "root/context.md", phrase: "Read only what a decision needs" },
    "R-DELEGATE": { section: "root/delegating.md", phrase: "go to specialists" },
    "R-NORESOLVE": { section: "root/delegating.md", phrase: "stop and report it" },
    "R-DISPATCH": { section: "root/dispatch.md", phrase: "`assignment dispatch`" },
    "R-REPORT": { section: "root/dispatch.md", phrase: "never retyped or summarized" },
    "R-WAKE": {
      section: "root/dispatch.md",
      phrase: "respond to completion, submitted input or a supported bounded wait timeout",
    },
    "R-STOP": {
      section: "root/dispatch.md",
      phrase: "only when a new requirement or new information conflicts with that running work",
    },
    "R-RESUME": { section: "root/dispatch.md", phrase: "confirmed gone" },
    "R-CACHE-REUSE": {
      section: "root/dispatch.md",
      phrase: "continues an idle specialist of the same role, model and effort",
    },
    "R-COMMIT-PR": {
      section: "root/pr-text.md",
      phrase: "Say what changed and why, how it was checked",
    },
    "R-ROUTE": { section: "root/routing.md", phrase: "cheapest specialist" },
    "R-SEARCH": {
      section: "root/search.md",
      phrase: "search through the available shell with `rg` and `fd`",
    },
    "R-OWNEDROUTES": {
      section: "root/skills.md",
      phrase: "Read the relevant HolyAgent guidance file on demand",
    },
    "R-DOCLOOKUP": {
      section: "skills/documentation-lookup/SKILL.md",
      phrase: "Verify the result against the primary source",
    },
    "R-DEVSERVER": {
      section: "root/skills.md",
      phrase: "start one render target for visual work",
    },
    "R-STACK": { section: "root/stack-plan.md", phrase: "stacks in work order by default" },
    "R-MERGEREVIEW": {
      section: "root/stack-plan.md",
      phrase: "gets a review of that head before any push",
    },
    "R-TASKLIST": { section: "root/task-list.md", phrase: "Create the task list first" },
    "R-TURN": { section: "root/task-list.md", phrase: "End your turn only when the work is done" },
    "R-DECIDE": {
      section: "root/task-list.md",
      phrase: "Every pending decision goes through the structured question tool",
    },
    "R-ACK": { section: "root/user-messages.md", phrase: "Acknowledge every user message" },
    "R-NUDGE": { section: "root/user-messages.md", phrase: "one short line at most" },
    "R-NAMED": { section: "root/user-messages.md", phrase: "names an action" },
    "R-IDEAS": { section: "root/user-messages.md", phrase: "asks for ideas, options or a plan" },
    "R-FLAG": {
      section: "root/user-messages.md",
      phrase:
        "put one sentence saying so in your acknowledgment of that message and continue as asked",
    },
    "R-VCS": {
      section: "root/version-control.md",
      phrase: "Version control and state records are yours alone",
    },
    "R-MERGEWAIT": {
      section: "root/version-control.md",
      phrase: "do not ask whether to merge or how",
    },
    "R-COMMIT-OWNER": {
      section: "root/version-control.md",
      phrase: "Commits and PR text read as the account owner wrote them",
    },
    "R-COMMIT-CONVENTION": {
      section: "root/version-control.md",
      phrase: "The target repository's conventions",
    },
    "R-COMMIT-ATOMIC": {
      section: "root/version-control.md",
      phrase: "each commit on a branch is atomic",
    },
    "R-WORKFLOW": { section: "root/workflows.md", phrase: "no prebuilt script exists" },
    "R-WAIT": { section: "root/workflows.md", phrase: "use `wait_for_agents` if offered" },
    "R-QUALITY": {
      section: "specialist/code-quality.md",
      phrase: "No duplication: reuse existing code",
    },
    "R-TERSE": { section: "specialist/conduct.md", phrase: "Respond tersely." },
    "R-S-DATA": {
      section: "specialist/conduct.md",
      phrase: "information to weigh, not instruction",
    },
    "R-S-RULES": { section: "specialist/conduct.md", phrase: "without being reminded" },
    "R-INSPECT": {
      section: "specialist/interface-inspection.md",
      phrase: "A passing build, snapshot or test does not show what renders",
    },
    "R-MERGE": {
      section: "specialist/merge-ready.md",
      phrase: "Judge each criterion in one of these six dimensions",
    },
    "R-MERGE-DIMENSIONS": {
      section: "specialist/merge-ready.md",
      phrase: "Does everything that worked still work?",
    },
    "R-MERGE-BLOCKER": {
      section: "specialist/merge-ready.md",
      phrase: "acceptance needs support for every blocking criterion",
    },
    "R-S-REPORT": { section: "specialist/report.md", phrase: "End with one compact report" },
    "R-CACHE-COMPACT": {
      section: "specialist/report.md",
      phrase: "Put long logs in a file outside the repository",
    },
    "R-S-REPO": {
      section: "specialist/scope.md",
      phrase: "Read the CLAUDE.md and AGENTS.md files that apply to your paths",
    },
    "R-S-SCOPE": {
      section: "specialist/scope.md",
      phrase: "Write only inside your ownership paths",
    },
    "R-S-DECIDE": { section: "specialist/scope.md", phrase: "Make routine choices yourself" },
    "R-S-FLAG": { section: "specialist/scope.md", phrase: "say so in one sentence under `notes:`" },
    "R-S-STOP": {
      section: "specialist/scope.md",
      phrase: "Keep working until every criterion is met and checked",
    },
    "R-S-LANG": { section: "specialist/scope.md", phrase: "in English unless" },
    "R-S-INDEP": { section: "specialist/scope.md", phrase: "independence rule" },
    "R-S-VCS": {
      section: "specialist/state-changes.md",
      phrase: "Leave to the root every command",
    },
    "R-S-HEAD": {
      section: "specialist/state-changes.md",
      phrase:
        "Never change HEAD, a branch, the index or the working tree of a checkout other workers share",
    },
    "R-S-CHECK": {
      section: "specialist/working.md",
      phrase: "run the ones that exercise your change now",
    },
    "R-S-SEARCH": {
      section: "specialist/working.md",
      phrase: "use the role's built-in `find` and `grep` through codemode",
    },
    "R-MATERIAL": {
      section: "shared/materiality.md",
      phrase: "A discrepancy is material, and starts a repair whatever its size",
    },
    "R-PRECEDENCE": { section: "shared/precedence.md", phrase: "When rules conflict" },
    "R-EL": {
      section: "roles/explorer-lookup/method.md",
      phrase: "Locate the fact with a search, then read the exact lines",
    },
    "R-EM": { section: "roles/explorer-map/method.md", phrase: "Cite a path" },
    "R-ET": { section: "roles/explorer-trace/method.md", phrase: "Begin at the trigger" },
    "R-LL": { section: "roles/librarian-lookup/method.md", phrase: "Look in the project first" },
    "R-LR": {
      section: "roles/librarian-research/method.md",
      phrase: "Prefer accessible official documentation",
    },
    "R-RA": {
      section: "roles/reviewer-artifact/method.md",
      phrase: "Give each acceptance criterion a verdict",
    },
    "R-RA-CONTEXT": {
      section: "roles/reviewer-artifact/instruction-text.md",
      phrase: "an existing file's departure from this is a finding only when the user asked",
    },
    "R-RAU": {
      section: "roles/reviewer-audit/method.md",
      phrase: "verified, discrepant or unverified",
    },
    "R-RC": { section: "roles/reviewer-code/builtin-review.md", phrase: "`code-review`" },
    "R-RS": {
      section: "roles/reviewer-security/findings.md",
      phrase: "Label validated vulnerabilities apart from suspicions",
    },
    "R-RT": {
      section: "roles/reviewer-testing/method.md",
      phrase: "Map each acceptance criterion",
    },
    "R-RV": {
      section: "roles/reviewer-visual/captures.md",
      phrase:
        "Report the inspection as blocked when no target record is named or no captures are supplied",
    },
    "R-RV-DESIGN": {
      section: "roles/reviewer-visual/design.md",
      phrase: "read that file and judge against its checklist",
    },
    "R-WD": {
      section: "roles/worker-debugging/phases.md",
      phrase: "Reproduce: build a deterministic reproduction",
    },
    "R-WI": {
      section: "roles/worker-implementation/method.md",
      phrase: "smallest complete change",
    },
    "R-WI-TEXT": {
      section: "roles/worker-implementation/instruction-text.md",
      phrase: "meet the writing bar below",
    },
    "R-WI-CONTEXT": {
      section: "roles/worker-implementation/instruction-text.md",
      phrase: "change an existing file that departs from this only when the user asks",
    },
    "R-WIN": { section: "roles/worker-integration/method.md", phrase: "end to end" },
    "R-WM": { section: "roles/worker-mechanical/method.md", phrase: "Find every site" },
    "R-WO": { section: "roles/worker-operations/method.md", phrase: "documented workflow" },
    "R-WO-DEV": {
      section: "roles/worker-operations/dev-server.md",
      phrase: "Report the completed record and whether you started the target or reused it",
    },
    "R-WV": { section: "roles/worker-validation/method.md", phrase: "choose the real check" },
    "R-WVI": {
      section: "roles/worker-visual/purpose.md",
      phrase: "The Assignment names the repair round and its limit",
    },
    "R-WVI-DESIGN": {
      section: "roles/worker-visual/design.md",
      phrase: "read that file first, then build and inspect against its checklist and capture list",
    },
    "R-VISUAL": {
      section: "skills/visual-judging/SKILL.md",
      phrase: "Your own final pass, after Worker.visual and Reviewer.visual, decides acceptance",
    },
    "R-EVIDENCE": {
      section: "skills/evidence-judging/SKILL.md",
      phrase: "starts a repair only with evidence",
    },
    "R-STATE": {
      section: "skills/state-mode/SKILL.md",
      phrase: "set the mode with `holyagent state mode <mode>`",
    },
    "R-CI": {
      section: "skills/ci-watch/SKILL.md",
      phrase: "Run `gh pr checks <n> --watch` as a background process",
    },
    "R-GUIDE": {
      section: "skills/instruction-writing/SKILL.md",
      phrase: "Put the full task with its reasons in every brief",
    },
    "R-SECTIONS": {
      section: "skills/instruction-writing/SKILL.md",
      phrase: "Keep each prompt section in its own file",
    },
    "R-CONTEXT": {
      section: "skills/instruction-writing/SKILL.md",
      phrase: "leave out content that changes or that the agent can discover from the repository",
    },
  },
}
