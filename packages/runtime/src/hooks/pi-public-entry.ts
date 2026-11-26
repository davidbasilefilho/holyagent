#!/usr/bin/env bun
import { basename, dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { main } from "../cli/entry.ts"
import { publicOutput } from "../cli/public-output.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))
const installedPackageRoot =
  basename(packageRoot) === "holyagent" && basename(dirname(packageRoot)) === "node_modules"
    ? packageRoot
    : undefined

const output = publicOutput(Bun.argv.slice(2), process.env, {
  stdin: Boolean(process.stdin.isTTY),
  stdout: Boolean(process.stdout.isTTY),
})

await main(true, "public", installedPackageRoot, output)
