# Type check and scripts

Sourced from the tsrs repository docs and npm page, the Bun `run` docs and the Bun v1.3.9 release notes, read on 2026-11-04, and checked by running tsrs 0.21.0-ts7.1.0-beta and `@tsrs/wasm` under Bun 1.4.4 on Linux x64. tsrs is experimental and moving fast: check its current README and COMPATIBILITY docs with web search or fetch first.

## tsrs

- A Rust port of the TypeScript 7 compiler, incubated in the Oxc project (https://github.com/oxc-project/tsrs, npm `tsrs`). The version suffix is the TypeScript version it ports. The README says it is not production-ready, so tell the user.
- Install: `bun add -D tsrs`. The package publishes only prerelease versions, so its range keeps the prerelease suffix (`^0.21.0-ts7.1.0-beta`); see `bun-prefs` tests.
- Run: `bunx tsrs --noEmit --fast`, or `tsrs -p <dir> --noEmit`. `--fast` can also be set with `TSRS_FAST=1`. Type errors exited 2 when tried. `--init` and `--showConfig` are unsupported.
- **Native** prebuilt binaries cover macOS arm64 and Linux x64 and arm64 (glibc and musl). There are no Windows or Intel macOS binaries. `tsrs` is a launcher that installs the matching optional dependency `@tsrs/<platform>`; verify the platform package names before documenting them. `TSRS_BINARY=/path` overrides the binary.
- **Wasm**: `@tsrs/wasm` (target `wasm32-wasip1`, single-threaded, 4 GiB memory, no watch, no LSP, exit code 5 on a panic or trap). `bunx @tsrs/wasm --noEmit -p .` ran and reported type errors with exit 2.
- No documented automatic fallback from native to wasm was found, so the script below selects by platform.
- **Dependencies that use other type checkers are left alone.** Do not replace the type checker of a dependency, a vendored package or a workspace that is built by another checker (for example a package that must build with `tsc` or a framework's own checker). Run tsrs on the project's own code only and scope it with `-p <dir>` per tsconfig.
- If the project's tsconfig uses options tsrs does not support, tell the user instead of changing the config silently.

`scripts/typecheck.ts`, run as `"typecheck": "bun scripts/typecheck.ts"` (both branches verified on Linux x64 by forcing each):

```ts
// Runs tsrs natively where a prebuilt binary exists, and the wasm build elsewhere.
const NATIVE = new Set(["darwin-arm64", "linux-x64", "linux-arm64"]);
const native = NATIVE.has(`${process.platform}-${process.arch}`);
const cmd = native
  ? ["bunx", "tsrs", "--noEmit", "--fast", ...Bun.argv.slice(2)]
  : ["bunx", "@tsrs/wasm", "--noEmit", "-p", ".", ...Bun.argv.slice(2)];
const { exited } = Bun.spawn(cmd, { stdio: ["inherit", "inherit", "inherit"] });
process.exit(await exited);
```

Keep the `NATIVE` set in line with the current COMPATIBILITY doc. The `@tsrs/wasm` `--noEmit` flag worked when tried; the docs do not state it explicitly.

## Scripts

Every task is a `package.json` script run with `bun run`. A starting set:

```json
{
  "scripts": {
    "build": "bun build ./src/index.ts --outdir dist",
    "check": "bun run --parallel lint format:check typecheck test",
    "dev": "bun --watch run src/index.ts",
    "format": "oxfmt",
    "format:check": "oxfmt --check",
    "lint": "oxlint",
    "lint:fix": "oxlint --fix",
    "start": "bun run src/index.ts",
    "test": "bun test",
    "typecheck": "bun scripts/typecheck.ts",
    "verify": "bun run --sequential format lint test",
    "version:sync": "bun scripts/sync-version.ts"
  }
}
```

- `build` and `start` are placeholders: use the project's real entry points and build tool. `oxlint --fix` is listed in `oxlint --help` for the installed version. The `check` script was not run as a whole here, so run it in the project. `verify` shows `--sequential` for steps that must run in order; it stopped at the first failing step with that step's exit code when tried.
- `dev` uses Bun's watch mode for hot watching. Bun flags go right after `bun` (`bun --watch run dev`); a flag after the script name is passed to the script. Check current Bun docs for `--watch` versus `--hot` before choosing.
- `bun run --parallel a b` runs scripts at once, `bun run --sequential a b` one after the other, and both accept globs such as `"build:*"`. They combine with `--filter '*'` and `--workspaces` (add `--if-present` when some workspaces lack the script). Both ran under Bun 1.4.4 with output prefixed `script | `; they were introduced in Bun v1.3.9, so verify the project's Bun version supports them.
- By default a failure kills the remaining scripts; `--no-exit-on-error` keeps them running. Per the v1.3.9 notes `--filter` respects dependency order while `--parallel` and `--sequential` do not: use `--parallel` for independent or long-lived scripts (checks, several dev servers) and `--sequential` when order matters, and plain `--filter` for dependency-ordered builds. Verify this against current docs.
- In a monorepo, run package scripts through `bun run --filter` or `--workspaces` from the root (see `bun-prefs` for workspaces).
