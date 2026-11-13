import { isAbsolute, join, resolve } from "node:path"

import { Effect } from "effect"

import { localFile } from "../state/layout.ts"
import { spawn } from "../state/process.ts"
import { gitEnvironment } from "../state/tree.ts"
import type { Context } from "./context.ts"

/** Locates a local untracked artifact for a validated Assignment id. */
export const artifactFile = (
  context: Context,
  root: string,
  directory: string,
  kind: "briefs" | "reports",
  id: string,
) =>
  spawn("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd: root,
    env: gitEnvironment(context.env),
  }).pipe(
    Effect.catchDefect(() => Effect.succeed({ code: -1, stdout: new Uint8Array(), stderr: "" })),
    Effect.map(({ code, stdout }) => {
      const common = new TextDecoder().decode(stdout).trim()
      return code === 0 && isAbsolute(common)
        ? join(resolve(common), "holyagent", kind, `${id}.md`)
        : localFile(directory, `${kind}/${id}.md`)
    }),
  )
