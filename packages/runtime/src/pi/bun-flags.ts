import { sep } from "node:path"

import { toPosix } from "../domain/paths.ts"

/** Placeholder for the installed Pi package path in model-facing guidance. */
export const PI_ROOT_PLACEHOLDER = "${HOLYAGENT_PI_ROOT}"

/** The Bun flags that keep a project's environment file and config out of the CLI. */
export const bunFlags = (bunfig: string): ReadonlyArray<string> => [
  "--no-env-file",
  `--config=${bunfig}`,
]

/** Routes model-facing agent commands to the isolated bundled CLI for the installed package. */
export const fillPackageRoot = (
  prompt: string,
  packageRoot: string,
  platformPath: { readonly sep: string } = { sep },
): string => {
  const root = toPosix(packageRoot, platformPath.sep)
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  const command = [
    "bun",
    ...bunFlags(quote(root + "/scripts/empty-bunfig.toml")),
    quote(root + "/scripts/holyagent-cli.js"),
  ].join(" ")
  return prompt
    .replaceAll(/`holyagent-cli (?=[^`])/g, () => "`" + command + " ")
    .replaceAll(PI_ROOT_PLACEHOLDER + "/scripts/holyagent-cli.js", () => command)
    .replaceAll(PI_ROOT_PLACEHOLDER, () => root)
}
