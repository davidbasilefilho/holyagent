import { $ } from "bun"

/**
 * The longest tracked path, in characters. A Windows install clones the repository under
 * `%USERPROFILE%\.claude\plugins\marketplaces\<owner>-<repo>..clone\`, so a long tracked path
 * pushes the checkout past MAX_PATH (260) there.
 */
export const MAX_PATH_LENGTH = 120

/** Intent state lives on the `holyagent/state` branch, so no tracked path may sit under it. */
export const STATE_DIR = ".holyagent/"

/** Lists the paths git tracks in `cwd`, one entry per path with no quoting (`-z`). */
export const trackedPaths = async (cwd: string): Promise<string[]> => {
  const result = await $`git ls-files -z`.cwd(cwd).quiet()
  return result.stdout.toString().split("\0").filter(Boolean)
}

/** Names each path that breaks a rule: too long, or under the state directory. */
export const violations = (paths: readonly string[]): string[] =>
  paths.flatMap((path) => [
    ...(path.length > MAX_PATH_LENGTH
      ? [`${path} is ${path.length} characters; the limit is ${MAX_PATH_LENGTH}`]
      : []),
    ...(path.startsWith(STATE_DIR)
      ? [`${path} is under ${STATE_DIR}, which belongs on the holyagent/state branch`]
      : []),
  ])
