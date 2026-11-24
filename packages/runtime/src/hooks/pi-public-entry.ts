#!/usr/bin/env bun
import { basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { main } from "../cli/entry.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const installedPackageRoot =
  basename(packageRoot) === "holyagent" && basename(dirname(packageRoot)) === "node_modules"
    ? packageRoot
    : undefined

await main(true, "public", installedPackageRoot)
