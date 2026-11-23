import { readlinkSync } from "node:fs"
import { join } from "node:path"

import { $ } from "bun"

// The dedicated Linux validation step launches this smoke inside an isolated network namespace.
const hostNamespace = process.env["HOLYAGENT_HOST_NETNS"]
if (
  process.platform !== "linux" ||
  hostNamespace === undefined ||
  !/^net:\[\d+\]$/.test(hostNamespace) ||
  readlinkSync("/proc/self/ns/net") === hostNamespace
) {
  console.error("The plugin validator requires its dedicated offline Linux CI step.")
  process.exit(1)
}

const root = join(import.meta.dir, "..")
const claude = join(root, "node_modules", ".bin", "claude")
for (const directory of [join(root, "packages", "integrations", "claude", "dist"), root]) {
  const result = await $`${claude} plugin validate --strict ${directory}`.quiet().nothrow()
  const text = `${result.stdout.toString()}${result.stderr.toString()}`
  // Anthropic's catalog listing checks (README, license, icon) are not validation diagnostics.
  const diagnostics = text.replace(
    /Plugin directory checks for[\s\S]*?The directory also runs[^\n]*\n/,
    "",
  )
  if (
    result.exitCode !== 0 ||
    !diagnostics.includes("Validation passed") ||
    /×|Found \d+ (?:error|warning)/.test(diagnostics)
  ) {
    console.error(`Strict validation failed for ${directory}:\n${text}`)
    process.exit(1)
  }
  console.log(`Strict validation passed for ${directory}`)
}
