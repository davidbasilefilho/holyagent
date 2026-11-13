import { readFileSync } from "node:fs"
import nodePath from "node:path"

import { Effect } from "effect"

import { toPosix } from "../../../runtime/src/domain/paths.ts"
import type { PiFamily } from "../../../runtime/src/instructions/families.ts"

/**
 * The family the package's own `agents/` folder holds, which every provider but Codex runs on. A
 * provider that runs another family finds that family's copies under {@link FAMILIES_FOLDER}.
 */
export const DEFAULT_PI_FAMILY: PiFamily = "kimi-k3.1"

/** The families the package carries besides {@link DEFAULT_PI_FAMILY}, built next to it. */
export const EXTRA_PI_FAMILIES: ReadonlyArray<PiFamily> = ["gpt-6"]

/** The folder of the package that holds other families' agent copies. */
export const FAMILIES_FOLDER = "families"

/** The folder of a family's specialist prompts, relative to the package root. */
export const familyAgents = (family: PiFamily): string => `${FAMILIES_FOLDER}/${family}/agents`

/** The folder of a family's skills, relative to the package root. */
export const familySkills = (family: PiFamily): string => `guidance/${family}`

/** The text of an agent file below its frontmatter, trimmed: the prompt the specialist runs on. */
export const promptBody = (file: string): string =>
  file.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()

const readBody = (packageRoot: string, folder: string, agent: string): string =>
  promptBody(readFileSync(nodePath.join(packageRoot, folder, `${agent}.md`), "utf8"))

/**
 * A specialist's prompt on another family: the package's own prompt for the agent, where the
 * session holds it, is replaced by the family's prompt for the same agent, so whatever Pi adds
 * around it stays. Returns the prompt unchanged for the default family, for a prompt that does not
 * contain the package's text (a user's own agent file outranks it), and when a file cannot be
 * read.
 */
export const familyAgentPrompt = (
  prompt: string,
  agent: string,
  family: PiFamily,
  packageRoot: string,
): string =>
  family === DEFAULT_PI_FAMILY
    ? prompt
    : Effect.runSync(
        Effect.try(() => {
          const own = readBody(packageRoot, "agents", agent)
          return own !== "" && prompt.includes(own)
            ? prompt.replace(own, () => readBody(packageRoot, familyAgents(family), agent))
            : prompt
        }).pipe(Effect.orElseSucceed(() => prompt)),
      )

/**
 * Rewrite legacy package skill paths to the selected family's private guidance paths. Paths outside
 * the package are untouched. Returns the prompt unchanged for the default family.
 */
export const familySkillPaths = (
  prompt: string,
  family: PiFamily,
  packageRoot: string,
  platformPath: Pick<typeof nodePath, "sep"> = nodePath,
): string => {
  if (family === DEFAULT_PI_FAMILY) return prompt
  const native = [packageRoot, "skills", ""].join(platformPath.sep)
  const rewritten = (separator: string) =>
    [packageRoot, ...familySkills(family).split("/"), ""].join(separator)
  const posix = [toPosix(packageRoot, platformPath.sep), "skills", ""].join("/")
  return prompt
    .replaceAll(native, () => rewritten(platformPath.sep))
    .replaceAll(posix, () => toPosix(rewritten(platformPath.sep), platformPath.sep))
}
