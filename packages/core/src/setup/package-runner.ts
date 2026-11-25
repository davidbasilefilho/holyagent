import { join } from "node:path"

import { type Env, homeDirectory } from "./environment.ts"

/** Recognized package layouts for the running public CLI. */
export type PackageRunner = "bunx" | "npm" | "mise" | "unknown"

const portable = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "")

/** Bunx places its resolved package in a temporary directory named after the package request. */
export const isBunxPackageRoot = (root: string): boolean =>
  /(?:^|\/)bunx-\d+-holyagent(?:@[^/]+)?\/node_modules\/holyagent$/i.test(portable(root))

/** Identify a runner only from its recorded package layout, not from programs on PATH. */
export const packageRunner = (root: string, env: Env): PackageRunner => {
  const path = portable(root)
  if (isBunxPackageRoot(root)) return "bunx"
  if (/\/installs\/npm-holyagent\/[^/]+\/(?:lib\/)?node_modules\/holyagent$/i.test(path))
    return "mise"
  const bun = portable(env.BUN_INSTALL ?? join(homeDirectory(env), ".bun"))
  if (path === `${bun}/install/global/node_modules/holyagent`) return "bunx"
  if (/\/_npx\/[^/]+\/node_modules\/holyagent$/i.test(path)) return "npm"
  const prefix = env.npm_config_prefix ?? env.NPM_CONFIG_PREFIX
  if (
    prefix !== undefined &&
    ["/lib/node_modules/holyagent", "/node_modules/holyagent"].some(
      (suffix) => path === portable(prefix) + suffix,
    )
  )
    return "npm"
  if (/^(?:\/usr(?:\/local)?\/lib|.*\/AppData\/Roaming\/npm)\/node_modules\/holyagent$/i.test(path))
    return "npm"
  return "unknown"
}
