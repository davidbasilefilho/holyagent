import { delimiter, join, posix, win32 } from "node:path"

import { $ } from "bun"
import { Context, Effect, Layer, Option } from "effect"

import { definedEnv, type Env, homeDirectory } from "./environment.ts"

/** The outcome of a finished command; a command that cannot start has exit code 127. */
export interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * The name the search path has in an environment. Windows keeps it as `Path` and matches names
 * without regard to case, so `insensitive` finds it however it is spelled (an exact `PATH` wins);
 * elsewhere names are exact. A missing variable is `PATH`.
 */
export const pathKey = (env: Env, insensitive: boolean = process.platform === "win32"): string => {
  if (!insensitive || env.PATH !== undefined) return "PATH"
  return Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
}

/**
 * The search path with Bun's global bin directory appended: the variable's name, so a Windows
 * `Path` is extended in place instead of gaining a second `PATH`, and its value. The directory is
 * `$BUN_INSTALL/bin`, else `bin` in `.bun` of the home directory, joined with the platform's
 * separator, and the entries are joined with its list delimiter (`;` on Windows).
 */
export const pathWithBunBin = (
  env: Env,
  options: {
    readonly home: string
    readonly bunInstall?: string | undefined
    readonly delimiter?: string
    readonly insensitive?: boolean
  },
): { readonly key: string; readonly value: string; readonly bunBin: string } => {
  const key = pathKey(env, options.insensitive)
  const root = options.bunInstall ? options.bunInstall : join(options.home, ".bun")
  const bunBin = join(root, "bin")
  return { key, value: `${env[key] ?? ""}${options.delimiter ?? delimiter}${bunBin}`, bunBin }
}

/**
 * How a lookup trusts PATH for a program that runs with arguments the model controls: only absolute
 * entries count, so a relative or empty entry (`.`, `bin`, `::`) cannot make a repository's own
 * program the answer; nothing inside the working directory is found; and on Windows only an `.exe`
 * is, since a `.cmd` or `.bat` shim would hand those arguments to `cmd.exe`.
 */
export interface StrictLookup {
  /** The working directory of the call. */
  readonly cwd: string
  /** The platform whose path rules apply; the running one when absent. For tests. */
  readonly platform?: NodeJS.Platform
  /** The lookup in a search path; `Bun.which` when absent. For tests. */
  readonly which?: (command: string, options: { readonly PATH: string }) => string | null
}

/** What a lookup of a command can ask for beyond the search path of the environment. */
export interface WhichOptions {
  /** Also search Bun's global bin directory. */
  readonly includeBunBin?: boolean
  /** Trust only what {@link StrictLookup} allows. */
  readonly strict?: StrictLookup
}

/** Whether `path` is `parent` or below it, by the path rules of `api`. */
const isInside = (api: typeof posix, parent: string, path: string): boolean => {
  const relative = api.relative(parent, path)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  )
}

const strictWhich = (command: string, path: string, strict: StrictLookup): string | null => {
  const windows = (strict.platform ?? process.platform) === "win32"
  const api = windows ? win32 : posix
  const trusted = path
    .split(windows ? ";" : ":")
    .filter((entry) => api.isAbsolute(entry) && !isInside(api, strict.cwd, entry))
  const found = (strict.which ?? Bun.which)(command, { PATH: trusted.join(windows ? ";" : ":") })
  if (found === null || isInside(api, strict.cwd, found)) return null
  return windows && !found.toLowerCase().endsWith(".exe") ? null : found
}

/**
 * Finds a command on the search path of an environment, plus Bun's global bin directory when
 * `includeBunBin` is set, and with `strict` only where {@link StrictLookup} trusts. A lookup only:
 * nothing is spawned.
 */
export const findCommand = (
  env: Env,
  command: string,
  options?: WhichOptions,
): Option.Option<string> => {
  const bunBin = pathWithBunBin(
    { ...env },
    { home: homeDirectory(env), bunInstall: env.BUN_INSTALL },
  )
  const path = options?.includeBunBin ? bunBin.value : (env[bunBin.key] ?? "")
  return Option.fromNullishOr(
    options?.strict === undefined
      ? Bun.which(command, { PATH: path })
      : strictWhich(command, path, options.strict),
  )
}

/**
 * The empty Bun config the plugin ships beside the CLI script (`scripts/empty-bunfig.toml`), found
 * in the folder of the running bundle. `bun add -g` takes it as `--config`, so no bunfig.toml of a
 * project can change an install.
 */
export const EMPTY_BUNFIG: string = join(import.meta.dir, "empty-bunfig.toml")

/**
 * The external commands setup drives (`bun`, `claude`, `ctx7`). Commands see Bun's global bin
 * directory on PATH, because a `bun add -g` in the same run puts new commands there.
 */
export class Shell extends Context.Service<
  Shell,
  {
    /** Finds a command on PATH, plus Bun's global bin directory when `includeBunBin` is set. */
    readonly which: (
      command: string,
      options?: WhichOptions,
    ) => Effect.Effect<Option.Option<string>>
    /**
     * Runs a command to completion without a terminal; stdout and stderr are captured. The command
     * runs in `cwd`. Setup passes the home directory for global work, because the process directory
     * is the user's project, whose .npmrc, bunfig.toml and .env must not steer an install. The one
     * exception is the project-scope `pi install -l`, which runs in the project directory on
     * purpose: Pi reads that project's .npmrc and .pi/settings.json there, so it is run only for a
     * project the user chose and trusts.
     */
    readonly run: (
      command: string,
      args: ReadonlyArray<string>,
      options: { readonly cwd: string },
    ) => Effect.Effect<ShellResult>
  }
>()("holyagent/Shell") {
  /** The real implementation, backed by the Bun Shell, for the environment of the process. */
  static readonly live = (env: Env) => {
    // A plain copy of the names and values, because Windows hands out `process.env` with
    // case-insensitive names that a spread flattens to the real one (`Path`).
    const bunBin = pathWithBunBin(
      { ...env },
      { home: homeDirectory(env), bunInstall: env.BUN_INSTALL },
    )
    return Layer.succeed(
      Shell,
      Shell.of({
        which: (command, options) => Effect.sync(() => findCommand(env, command, options)),
        run: (command, args, options) =>
          Effect.tryPromise({
            try: () =>
              $`${command} ${args}`
                .cwd(options.cwd)
                .env(definedEnv({ ...env, [bunBin.key]: bunBin.value }))
                .quiet()
                .nothrow()
                .then((result) => ({
                  exitCode: result.exitCode,
                  stdout: result.stdout.toString(),
                  stderr: result.stderr.toString(),
                })),
            catch: (error) => String(error),
          }).pipe(
            Effect.catch((message) =>
              Effect.succeed({ exitCode: 127, stdout: "", stderr: message }),
            ),
          ),
      }),
    )
  }
}
