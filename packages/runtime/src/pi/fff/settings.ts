/**
 * What the fff capability decides about `@ff-labs/pi-fff`, read from the package at the pin of
 * `pi-packages.json` (0.11.0: `README.md`, `src/config.ts` and `src/index.ts` of the package, and
 * `dist/index.js` of its `@ff-labs/fff-node` dependency).
 */

/**
 * The keys of the package's `pi-fff.json` that put it in `override` mode: it then registers its
 * tools under the names of Pi's own `grep` and `find` (and adds `multi_grep`), so they replace
 * Pi's. The package's default, `tools-and-ui`, adds `fffind`, `ffgrep` and `fff-multi-grep` beside
 * Pi's tools. The file is read from Pi's agent directory only (`PI_CODING_AGENT_DIR` honored); a
 * project file is not read, and `--fff-mode` or `PI_FFF_MODE` outrank it.
 */
export const FFF_OVERRIDE_SETTINGS = { mode: "override" } as const

/**
 * The tools that `override` mode registers, which the root does not use: its search rule names
 * `holyagent rg` and `holyagent fd`. Pi's default selection leaves `grep` and `find` out of the
 * root's active tools, but the package activates every tool it registers, so the root excludes them
 * to keep what it had.
 */
export const FFF_OVERRIDE_TOOLS: ReadonlyArray<string> = ["grep", "find", "multi_grep"]

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
