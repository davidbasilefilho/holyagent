/**
 * What the fff capability decides about `@ff-labs/pi-fff`, read from the package at the pin of
 * `pi-packages.json` (0.11.0: `README.md`, `src/config.ts` and `src/index.ts` of the package, and
 * `dist/index.js` of its `@ff-labs/fff-node` dependency).
 */

/**
 * The keys of the package's `pi-fff.json` that setup writes: `mode: "override"` puts it in
 * `override` mode, where it registers its tools under the names of Pi's own `grep` and `find` (and
 * adds `multi_grep`), so they replace Pi's. The package's default, `tools-and-ui`, adds `fffind`,
 * `ffgrep` and `fff-multi-grep` beside Pi's tools.
 *
 * Setup leaves `followSymlinks` unset, so the package follows directory links by its own default
 * (for worktree and stow layouts): a link in a repository to a folder outside it becomes
 * searchable, which Pi's own `rg` and `fd` do not allow. A user's own value stays, and the
 * package's `--fff-follow-symlinks` flag and `FFF_FOLLOW_SYMLINKS` outrank the file.
 *
 * The file is read from Pi's agent directory only (`PI_CODING_AGENT_DIR` honored); a project file
 * is not read, and `--fff-mode` or `PI_FFF_MODE` outrank `mode`.
 */
export const FFF_OVERRIDE_SETTINGS = { mode: "override" } as const

/**
 * What an earlier setup wrote to `pi-fff.json` and no longer does (0.3.1 wrote `followSymlinks:
 * false`). Setup takes these keys back out by its record, only while they still hold the recorded
 * value, so a person's own value stays.
 */
export const FFF_RETIRED_SETTINGS = { followSymlinks: false } as const

/**
 * Every tool name `@ff-labs/pi-fff` registers at the pin of `pi-packages.json` (0.11.0,
 * `OVERRIDE_TOOL_NAMES` and `FFF_TOOL_NAMES` of `src/index.ts`); a pin move must recheck the list,
 * {@link FFF_OVERRIDE_SETTINGS} and {@link FFF_NATIVE_HOSTS} against the package. The root and
 * specialists use these through codemode. The root explicitly activates registered FFF tools, and
 * specialist allowlists include the extension tools as well as its builtin replacement names.
 * Override mode registers `grep`, `find` and `multi_grep`; the package's default mode, the
 * `--fff-mode` flag or `PI_FFF_MODE` over the file, and override mode with the working directory
 * opted out of indexing register `ffgrep`, `fffind` and `fff-multi-grep` instead, so both sets are
 * allowed, whichever mode ends up in force.
 */
export const FFF_TOOLS: ReadonlyArray<string> = [
  "grep",
  "find",
  "multi_grep",
  "ffgrep",
  "fffind",
  "fff-multi-grep",
]

/**
 * The hosts (`<process.platform>-<process.arch>`) that `@ff-labs/fff-node` ships a native library
 * for: its `TRIPLE_TO_NPM_PACKAGE` maps darwin (arm64, x64), linux (arm64, x64, each in a glibc and
 * a musl build, which the package tells apart at run time), win32 (arm64, x64) and android (arm64)
 * to `@ff-labs/fff-bin-*` packages. Anywhere else the package cannot load its library, so the
 * capability is not offered and Pi keeps its own `grep` and `find`.
 */
export const FFF_NATIVE_HOSTS: ReadonlyArray<string> = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
  "android-arm64",
]
