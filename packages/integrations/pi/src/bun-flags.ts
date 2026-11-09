/**
 * The Bun options that keep a project's `.env` and `bunfig.toml` from changing the bundled CLI: no
 * env file, and a config file that is empty. The one place that names them: the generated
 * `scripts/holyagent` wrapper and the extension's Bun arguments (`runtimeArgs`) both build their
 * flags from it, so a flag cannot be added to one and missed by the other. It imports nothing,
 * since the extension bundles it for Node.
 *
 * @param bunfig - The empty config file's path, written as the caller's syntax needs it (a shell
 *   word for the wrapper, a plain path for the extension)
 */
export const bunFlags = (bunfig: string): ReadonlyArray<string> => [
  "--no-env-file",
  `--config=${bunfig}`,
]
