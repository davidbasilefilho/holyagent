# Tests

Complete files that enforce the range-format and single-version rules. Copy them unchanged into the project root, run `bun install`, then run `bun test` from the root (the peer-range exception reads installed packages). They run in a Bun workspace root and in a single-package project (with no `workspaces` field they check only the root manifest).

Layout:

```
tests/workspace-files.ts    shared helper, not a test file
tests/dep-ranges.test.ts    rule 1
tests/versions.test.ts      rule 3
scripts/sync-version.ts     propagates the root version, run as `bun run version:sync`
```

Add to the root `package.json` scripts: `"version:sync": "bun scripts/sync-version.ts"`, and make sure CI and the `check` script run `bun test`.

Adapt only when the layout differs:
- The helper takes the repository root as the parent of its own directory. If the tests live elsewhere, change `root`.
- Workspaces come from the root `workspaces` field (array form or `{ packages: [...] }`), including `!` exclusions, so new directories such as `apps/` or `tooling/` need no edit.
- If a root `bunfig.toml` limits the `[test]` section, make sure `tests/` is still discovered.

## Specifiers the range test skips

Not semver ranges, so not checked: `workspace:`, `file:`, `link:`, `git+`, `git:`, `github:` and `http(s):` tarball URLs. `catalog:` references are skipped, and the catalog entries they point to (root `catalog`, `catalogs`, and the same keys under `workspaces`) are checked instead. Override references such as `"react": "$react"` are skipped too, because they reuse the range of a direct dependency, which is checked. `npm:pkg@^1.0.0` aliases are checked on the range after the last `@`; an alias without a range fails. A union range such as the peer `^18.0.0 || ^19.0.0` passes when each side matches the format; one bad side fails the whole range. Checked fields: `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides`, `resolutions`. Tags (`latest`), `*`, `~`, `>=` and exact versions fail on purpose, with one exception.

**Peer-range exception.** A tilde `~X.Y.Z` passes only for a package whose range another declared package narrows through its `peerDependencies`. The test reads `node_modules/<other>/package.json` for every declared package and accepts the tilde when that peer range has `X.Y.Z` as its exact lower bound (it rejects the version just below), admits every `X.Y.x`, rejects `X.(Y+1).0`, and is narrower than the zeroed caret (for `0.x` it must also reject the caret's floor `0.Y.0`). The package is looked up in the `node_modules` of each workspace that declares it, then in the root, because Bun's isolated installs link it only into the declaring workspace. Example: `@convex-dev/better-auth` requires `better-auth >=1.7.16 <1.8.0`, so `better-auth` is declared `~1.7.16`. A tilde nobody's peer range requires, one whose lower bound differs from the peer range's (`~1.7.20` against `>=1.7.16 <1.8.0`), or one whose constraining package is not installed fails. The check reads installed packages, so run `bun install` before `bun test`.

`^0.0.0` passes, as a degenerate `^0.0.X`. A prerelease suffix is allowed after any shape (`^0.21.0-beta`), because some packages publish only prereleases and a plain `^0.21.0` would not match them. The shapes are one regex in `dep-ranges.test.ts`; change it there if the user wants another variant.

## tests/workspace-files.ts

```ts
import { Glob } from "bun";
import { join } from "node:path";

/** Repository root, assuming this file lives in `<root>/tests/`. */
export const root = join(import.meta.dir, "..");

export interface Manifest {
  /** Path relative to the repository root. */
  file: string;
  json: Record<string, any>;
}

/** Reads the root manifest plus every workspace manifest the root `workspaces` globs match. */
export async function readManifests(): Promise<{ rootPkg: Manifest; workspaces: Manifest[] }> {
  const read = async (file: string): Promise<Manifest> => ({
    file,
    json: await Bun.file(join(root, file)).json(),
  });
  const rootPkg = await read("package.json");
  const ws = rootPkg.json.workspaces;
  const patterns: string[] = Array.isArray(ws) ? ws : (ws?.packages ?? []);
  const excluded = patterns.filter((p) => p.startsWith("!")).map((p) => new Glob(p.slice(1)));
  const files = new Set<string>();
  for (const pattern of patterns.filter((p) => !p.startsWith("!"))) {
    const glob = new Glob(`${pattern.replace(/\/$/, "")}/package.json`);
    for (const file of glob.scanSync({ cwd: root })) {
      if (file.includes("node_modules/")) continue;
      if (excluded.some((g) => g.match(file) || g.match(file.replace(/\/package\.json$/, "")))) continue;
      files.add(file);
    }
  }
  const workspaces = await Promise.all([...files].sort().map(read));
  return { rootPkg, workspaces };
}
```

## tests/dep-ranges.test.ts

```ts
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readManifests, root } from "./workspace-files";

// ^M.0.0 (M >= 1), ^0.m.0 (m >= 1) or ^0.0.p, each with an optional prerelease suffix such as
// -beta.1, for packages that only publish prereleases. ^0.0.0 is accepted as a degenerate ^0.0.p.
const RANGE = /^\^(?:[1-9]\d*\.0\.0|0\.[1-9]\d*\.0|0\.0\.\d+)(?:-[0-9A-Za-z.-]+)?$/;
const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
// Not semver ranges, so not checked: workspace:, file:, link:, git and github: URLs, tarball URLs.
// catalog: references are not checked either; the catalog entries they point to are.
// $name override references point at a direct dependency, whose own range is checked.
const SKIP = /^(workspace:|file:|link:|git\+|git:|github:|https?:|catalog:|\$)/;
const TILDE = /^~(\d+)\.(\d+)\.(\d+)$/;

// Peer-range exception: ~X.Y.Z passes for a package when another declared and installed package
// lists it in peerDependencies with a range whose lower bound is exactly X.Y.Z, that admits all of
// X.Y.x, rejects X.(Y+1).0, and is narrower than the zeroed caret (for 0.x that means it also
// rejects the caret's floor). `declared` maps each declared name to the directories of the
// manifests that declare it. Bun's isolated installs link a package only into the declaring
// workspace's node_modules, so look there first, then in the root.
// Reads node_modules, so run `bun install` before `bun test`.
function peerNarrows(name: string, spec: string, declared: Map<string, string[]>): boolean {
  const m = TILDE.exec(spec);
  if (!m) return false;
  const [x, y, z] = m.slice(1).map(Number);
  const floor = x > 0 ? `${x}.0.0` : y > 0 ? `0.${y}.0` : `0.0.${z}`;
  // The version just below X.Y.Z, which the peer range must reject so that X.Y.Z is its lower bound.
  const below = z > 0 ? `${x}.${y}.${z - 1}` : y > 0 ? `${x}.${y - 1}.999999` : x > 0 ? `${x - 1}.999999.999999` : null;
  for (const [other, dirs] of declared) {
    if (other === name) continue;
    const file = [...dirs, "."]
      .map((dir) => join(root, dir, "node_modules", other, "package.json"))
      .find((f) => existsSync(f));
    if (!file) continue;
    const peer = JSON.parse(readFileSync(file, "utf8")).peerDependencies?.[name];
    if (typeof peer !== "string") continue;
    const ok = (v: string) => Bun.semver.satisfies(v, peer);
    if (!ok(`${x}.${y}.${z}`) || !ok(`${x}.${y}.999999`) || ok(`${x}.${y + 1}.0`)) continue;
    if ((below !== null && ok(below)) || (x === 0 && ok(floor))) continue;
    return true;
  }
  return false;
}

function check(where: string, name: string, spec: unknown, bad: string[], declared: Map<string, string[]>) {
  if (typeof spec !== "string") return;
  if (SKIP.test(spec)) return;
  if (peerNarrows(name, spec, declared)) return;
  let range = spec;
  if (spec.startsWith("npm:")) {
    // npm:pkg@^1.0.0 or npm:@scope/pkg@^1.0.0 is checked on the range after the last "@".
    const rest = spec.slice(4);
    const at = rest.lastIndexOf("@");
    range = at > 0 ? rest.slice(at + 1) : "";
  }
  // A union such as ^18.0.0 || ^19.0.0 passes when every side matches.
  if (!range.split("||").every((side) => RANGE.test(side.trim()))) bad.push(`${where}: ${name}@${spec}`);
}

function checkMap(where: string, map: unknown, bad: string[], declared: Map<string, string[]>) {
  if (!map || typeof map !== "object") return;
  for (const [name, spec] of Object.entries(map)) {
    if (spec && typeof spec === "object") checkMap(where, spec, bad, declared); // nested overrides
    else check(where, name, spec, bad, declared);
  }
}

test("every declared dependency range is a zeroed caret", async () => {
  const { rootPkg, workspaces } = await readManifests();
  const declared = new Map<string, string[]>();
  for (const { file, json } of [rootPkg, ...workspaces]) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(json[field] ?? {})) declared.set(name, [...(declared.get(name) ?? []), dirname(file)]);
    }
  }
  const bad: string[] = [];
  for (const { file, json } of [rootPkg, ...workspaces]) {
    for (const field of FIELDS) checkMap(`${file}#${field}`, json[field], bad, declared);
    checkMap(`${file}#overrides`, json.overrides, bad, declared);
    checkMap(`${file}#resolutions`, json.resolutions, bad, declared);
    const ws = json.workspaces && !Array.isArray(json.workspaces) ? json.workspaces : {};
    checkMap(`${file}#catalog`, json.catalog ?? ws.catalog, bad, declared);
    for (const [name, catalog] of Object.entries<any>(json.catalogs ?? ws.catalogs ?? {})) {
      checkMap(`${file}#catalogs.${name}`, catalog, bad, declared);
    }
  }
  expect(bad).toEqual([]);
});
```

## tests/versions.test.ts

The root version must be a semver string, every workspace must carry the same version (a missing version fails, so private workspaces also get one), and any dependency on a sibling workspace must use `workspace:` so the version is never copied by hand.

```ts
import { expect, test } from "bun:test";
import { readManifests } from "./workspace-files";

const FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

test("the root package.json defines the version", async () => {
  const { rootPkg } = await readManifests();
  expect(rootPkg.json.version).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
});

test("every workspace version equals the root version", async () => {
  const { rootPkg, workspaces } = await readManifests();
  const bad = workspaces
    .filter(({ json }) => json.version !== rootPkg.json.version)
    .map(({ file, json }) => `${file}: ${json.version ?? "(missing)"} != ${rootPkg.json.version}`);
  expect(bad).toEqual([]);
});

test("sibling workspaces are referenced with workspace:, never a hard-coded version", async () => {
  const { rootPkg, workspaces } = await readManifests();
  const names = new Set(workspaces.map(({ json }) => json.name));
  const bad: string[] = [];
  for (const { file, json } of [rootPkg, ...workspaces]) {
    for (const field of FIELDS) {
      for (const [name, spec] of Object.entries<string>(json[field] ?? {})) {
        if (names.has(name) && !spec.startsWith("workspace:")) bad.push(`${file}#${field}: ${name}@${spec}`);
      }
    }
  }
  expect(bad).toEqual([]);
});
```

## scripts/sync-version.ts

Pass a version to bump the root and propagate it, or no argument to propagate the current root version. Run it, then `bun test`. Other places that print the version (a README badge, a manifest outside `package.json`, a generated file) must read it from the root or be added to `versions.test.ts`.

```ts
// Usage: bun run version:sync [x.y.z]
// Optionally sets the root version, then copies it into every workspace package.json.
import { join } from "node:path";
import { readManifests, root } from "../tests/workspace-files";

const next = Bun.argv[2];
if (next && !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(next)) throw new Error(`Not a version: ${next}`);

const { rootPkg, workspaces } = await readManifests();
if (next) rootPkg.json.version = next;
if (typeof rootPkg.json.version !== "string") throw new Error("Set a version in the root package.json first.");

const write = (file: string, json: unknown) =>
  Bun.write(join(root, file), `${JSON.stringify(json, null, 2)}\n`);
if (next) await write(rootPkg.file, rootPkg.json);
for (const { file, json } of workspaces) {
  if (json.version === rootPkg.json.version) continue;
  json.version = rootPkg.json.version;
  await write(file, json);
}
console.log(`Version ${rootPkg.json.version} synced to ${workspaces.length} workspaces.`);
```

## How these were verified

The files were run with Bun 1.4.4 in a throwaway workspace root with `workspaces: ["apps/*", "packages/*", "!packages/ignored"]`, a root catalog, an `npm:` alias, `file:`, `github:`, `catalog:` and `workspace:` specifiers.
- Passing fixture: `bun test` exited 0 with 4 tests passing, including a prerelease-only dependency declared as `^0.21.0-ts7.1.0-beta`. The excluded workspace, with a wrong version and a `~` range, was correctly ignored.
- Failing fixture: `bun test` exited 1 with 3 of 4 failing, reporting a catalog entry `^4.1.0`, an alias `^3.1.0`, `~1.0.0`, `latest`, a peer `^19.2.1`, a prerelease with a nonzero patch `^0.21.1-beta`, a hard-coded sibling `^1.2.3`, a workspace version `1.2.4` against root `1.2.3` and a workspace with no version.
- Union and override cases: `^18.0.0 || ^19.0.0` and `"react-dom": "$react"` passed; `^18.0.0 || ~19.0.0`, `^18.0.0 ||`, `>=18 || ^19.0.0` and `^18.1.0 || ^19.0.0` failed.
- Peer-range exception, in a second throwaway workspace with hand-written `node_modules/<pkg>/package.json` files for the constraining packages (`peerDependencies` of `better-auth: ">=1.7.16 <1.8.0"` and `floor-pkg: ">=0.5.3 <0.6.0"`):
  - Passing: `better-auth` declared `~1.7.16` in the root and in a workspace, and `floor-pkg` declared `~0.5.3`, passed (4 tests, exit 0).
  - Failing: `better-auth` as `~1.6.15` (differs from the peer range), `~1.2.3` and `~2.0.0` that no peer requires, `~1.0.0` against a plain `^1.0.0` peer (not narrower than the caret), and `~0.5.0` below a `0.x` peer floor all failed with the existing bad cases.
  - Passing `~1.7.16` failed (exit 1) once the constraining package was removed from `node_modules`.
- Peer-range lookup and exact lower bound, in a third throwaway workspace:
  - Isolated installs: `bun install` (Bun 1.4.4) on a workspace root whose `apps/web` declares `react` and `react-dom` left the root `node_modules` with only `.bun`, and linked both packages into `apps/web/node_modules`. A root-only lookup therefore misses a package declared only in a workspace.
  - Passing (exit 0, 4 tests): `better-auth` declared `~1.7.16` in `apps/web`, with the constraining package present only in `apps/web/node_modules`; `floor-pkg` declared `~0.5.3` in `apps/api`, with its constraining package in the root `node_modules`.
  - Failing (exit 1, only the intended entries reported): `~1.7.20` against `>=1.7.16 <1.8.0`, `~1.7.10` against `>=1.7.16 <1.8.0`, `~1.0.0` against `^1.0.0`, `~1.2.3` that no peer requires, `~1.7.16` whose constraining package is not installed, and `~0.5.0` against `>=0.5.0 <0.6.0`. `~1.7.10` against `>=1.7.10 <1.8.0` passed.
  - Before the change, the same passing fixture failed and `~1.7.20` passed.
- Sync script: `bun scripts/sync-version.ts 2.0.0` rewrote the root and every non-excluded workspace and left the excluded one alone.

Re-run them after any edit, with one passing and one failing fixture.
