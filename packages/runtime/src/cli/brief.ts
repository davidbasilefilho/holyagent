import { briefText as sharedBriefText } from "@holyagent/core/api/report.ts"

import type { Assignment } from "../domain/assignment.ts"
import type { AgentHost } from "../domain/host.ts"
import { firstPassPrompt } from "../prompts/index.ts"

/** Builds the host brief using the shared prompt and the installed first-pass asset. */
export const briefText = (assignment: Assignment, agent: string, host: AgentHost): string =>
  sharedBriefText(
    assignment,
    agent,
    host,
    host === "pi" ? firstPassPrompt(assignment.roleTask) : undefined,
  )
