import { join } from "node:path"

import solidPlugin from "@opentui/solid/bun-plugin"
import { Effect } from "effect"

import { bundleModule } from "../../bundle.ts"
import { TUI_SOURCE } from "./files.ts"

/**
 * The modules the interface bundle leaves as imports: OpenTUI's native renderer cannot be bundled,
 * and Solid and OpenTUI must be one instance each, so all three resolve from the folder setup
 * installs them in.
 */
export const TUI_EXTERNAL: ReadonlyArray<string> = [
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
].flatMap((name) => [name, `${name}/*`])

/**
 * Bundles the setup interface as its own Bun module, separate from the platform-neutral CLI bundle:
 * the Solid plugin turns its JSX into OpenTUI calls, and the packages above stay imports. `note`
 * names the source in the generated file.
 */
export const bundleSetupTui = (repository: string, note: string) =>
  bundleModule(join(repository, TUI_SOURCE), {
    target: "bun",
    note,
    external: TUI_EXTERNAL,
    plugins: [solidPlugin],
  }).pipe(Effect.orDie)
