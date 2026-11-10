/**
 * What the shell's one-file bundle (`scripts/just-bash.js`) leaves out, so that the file is the
 * same on every machine and needs nothing installed beside it. Three of just-bash's dependencies
 * are not part of it:
 *
 * - `sql.js` serves the `sqlite3` command, which also needs a worker file that a one-file bundle does
 *   not have, so the command is not registered (`UNAVAILABLE_BUILTINS`) and `sql.js` is replaced by
 *   a stub that fails when called. Left in, Bun writes the absolute path of the folder it was
 *   installed in into the bundle.
 * - `node-liblzma` and `@mongodb-js/zstd` are optional native add-ons for `xz` and `zstd` archives,
 *   which just-bash loads on first use and reports as missing when it cannot. They stay imports.
 */
export const SHELL_EXTERNAL: ReadonlyArray<string> = ["node-liblzma", "@mongodb-js/zstd"]

const SQLITE_STUB = `export default function initSqlJs() {
  throw new Error("sqlite3 is not available in the HolyAgent shell; use the host's sqlite3 program")
}
`

/** The Bun build plugin that swaps `sql.js` for {@link SQLITE_STUB}. */
export const withoutSqlite: Bun.BunPlugin = {
  name: "holyagent-shell-without-sqlite",
  setup(build) {
    build.onResolve({ filter: /^sql\.js$/ }, () => ({ path: "sql.js", namespace: "no-sqlite" }))
    build.onLoad({ filter: /.*/, namespace: "no-sqlite" }, () => ({
      contents: SQLITE_STUB,
      loader: "js",
    }))
  },
}
