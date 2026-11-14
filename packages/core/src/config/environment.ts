import { homedir } from "node:os"

/** A process environment. */
export type Env = Readonly<Record<string, string | undefined>>
/** The first set nonempty value. */
export const firstNonEmpty = (...values: ReadonlyArray<string | undefined>) =>
  values.find((value) => value !== undefined && value !== "")
/** The configured home directory, falling back to the OS answer. */
export const homeDirectory = (env: Env, fallback: () => string = homedir): string =>
  firstNonEmpty(env.HOME, env.USERPROFILE) ?? fallback()
