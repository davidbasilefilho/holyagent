import { sep } from "node:path"

import { fakeGitHub, vcs } from "../vcs-fixtures.ts"

// Model the older Windows Bun failure only in this child process and only for state-copy targets.
Bun.write = new Proxy(Bun.write, {
  apply(target, receiver, args: unknown[]) {
    const path = args[0]
    if (
      typeof path === "string" &&
      path.length > 260 &&
      path.includes(`${sep}notes${sep}`) &&
      path.endsWith(".tmp")
    ) {
      throw Object.assign(new Error("legacy Bun.write cannot open a long path"), { code: "ENOENT" })
    }
    return Reflect.apply(target, receiver, args) as unknown
  },
})

const cwd = process.argv[2]
if (cwd === undefined) throw new Error("missing worktree")
const result = await vcs(cwd, ["intent", "list"], fakeGitHub({}).layer)
if (result.code !== 0) throw new Error(result.stderr)
