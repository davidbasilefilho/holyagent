import { Layer } from "effect"

import { gitLive } from "./git.ts"
import { githubLive } from "./github.ts"
import type { Env } from "./process.ts"

/** Git and GitHub as they are on this machine, working in the project root. */
export const vcsLive = (root: string, env: Env) =>
  Layer.merge(gitLive(root, env), githubLive(root, env))
