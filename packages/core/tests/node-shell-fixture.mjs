import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { access, chmod, mkdir, symlink, writeFile } from "node:fs/promises"
import { delimiter, join } from "node:path"
import { pathToFileURL } from "node:url"

import { Effect, Option } from "effect"

const { findCommand, Shell, EMPTY_BUNFIG } = await import(pathToFileURL(process.argv[2]).href)
const root = process.argv[3]
const bun = process.argv[4]
assert.equal(typeof globalThis.Bun, "undefined")
assert.notEqual(spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"]).status, 0)
const host = join(root, "host")
const project = join(root, "project")
const machine = join(root, "machine")
const alias = join(root, "alias")
for (const dir of [host, project, machine, alias]) await mkdir(dir)
const marker = join(root, "ran")
process.chdir(host)
if (process.platform !== "win32") {
  const script = `#!/bin/sh\nprintf '%s' unsafe > '${marker}'\n`
  for (const dir of [host, project, machine]) {
    await writeFile(join(dir, "rg"), script)
    await chmod(join(dir, "rg"), 0o755)
  }
  await symlink(join(project, "rg"), join(alias, "rg"))
  const projectAlias = join(root, "project-alias")
  await symlink(project, projectAlias)
  const find = (PATH, options = {}) =>
    Option.getOrUndefined(
      findCommand({ HOME: root, PATH }, "rg", { strict: { cwd: project, ...options } }),
    )
  assert.equal(find("."), undefined)
  assert.equal(find(""), undefined)
  assert.equal(find("bin::."), undefined)
  assert.equal(find(machine, { which: () => "rg" }), undefined)
  assert.equal(find(project), undefined)
  assert.equal(find(alias), undefined)
  assert.equal(find([alias, machine].join(delimiter)), join(machine, "rg"))
  assert.equal(
    Option.getOrUndefined(
      findCommand({ HOME: root, PATH: project }, "rg", { strict: { cwd: projectAlias } }),
    ),
    undefined,
  )
  assert.equal(find(machine), join(machine, "rg"))
  assert.equal(
    await access(marker).then(
      () => true,
      () => false,
    ),
    false,
  )
}
const preload = join(project, "preload.ts")
await writeFile(preload, `await Bun.write(${JSON.stringify(marker)}, "loaded")`)
await writeFile(join(project, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`)
const result = await Effect.runPromise(
  Effect.gen(function* () {
    const shell = yield* Shell
    return yield* shell.run(
      bun,
      ["--no-env-file", `--config=${EMPTY_BUNFIG}`, "-e", "process.stdout.write('core-shell-ok')"],
      { cwd: project },
    )
  }).pipe(Effect.provide(Shell.live({ HOME: root, PATH: process.env.PATH }))),
)
assert.equal(result.exitCode, 0, result.stderr)
assert.equal(result.stdout, "core-shell-ok")
assert.equal(
  await access(marker).then(
    () => true,
    () => false,
  ),
  false,
)
console.log("Node Core strict lookup and Bun config passed")
