/**
 * The leading flag that names the project: `--project <directory> <command>...` runs the command
 * with that directory as the working directory. The Pi extension starts the wrapper in the
 * package's own folder, where no program of the project is found by name, and names the project
 * here instead.
 */
export const PI_PROJECT_FLAG = "--project"

/**
 * Splits the leading {@link PI_PROJECT_FLAG} and its directory off a command line. A command line
 * without them, or with the flag and no directory, comes back unchanged with no directory.
 */
export const projectOf = (
  args: ReadonlyArray<string>,
): { readonly directory: string | undefined; readonly rest: ReadonlyArray<string> } =>
  args[0] === PI_PROJECT_FLAG && args[1] !== undefined
    ? { directory: args[1], rest: args.slice(2) }
    : { directory: undefined, rest: args }
