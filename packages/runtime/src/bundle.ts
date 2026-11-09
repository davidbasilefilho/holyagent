import { Data, Effect } from "effect"

import { MODULE_COMMENT } from "./instructions/generated.ts"

/** Bun could not bundle an entrypoint, or the bundle is not in the shape the note needs. */
export class BundleFailed extends Data.TaggedError("BundleFailed")<{
  readonly entrypoint: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `could not bundle ${this.entrypoint}: ${this.reason}`
  }
}

// Bun throws when a build fails: an AggregateError with one error per build message for errors in
// the sources (an unresolved import), a plain Error for a failure before any (a missing entrypoint).
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const messagesOf = (cause: unknown): string =>
  cause instanceof AggregateError && cause.errors.length > 0
    ? cause.errors.map(describe).join("\n")
    : describe(cause)

/** What {@link bundleModule} builds for. */
export interface BundleOptions {
  /** The runtime that loads the bundle: `bun` for the CLI, `node` for a Pi extension. */
  readonly target: "bun" | "node"
  /** The note that names the bundle's source, without the leading `// `. */
  readonly note: string
  /** Modules that stay imports, as the host supplies them. */
  readonly external?: ReadonlyArray<string>
  /** Bun build plugins, for sources that need a transform (the setup interface's Solid JSX). */
  readonly plugins?: ReadonlyArray<Bun.BunPlugin>
}

/**
 * Bundles an entrypoint to one ES module that is the same on every machine: Bun's comment above
 * each module names its path in `node_modules`, which depends on how dependencies were installed,
 * so those comments go. The note follows Bun's `// @bun` pragma for a `bun` bundle, which keeps the
 * pragma first after the shebang, and leads a `node` bundle. The Claude plugin's CLI and the Pi
 * package's runtime and extension are all built here.
 */
export const bundleModule = (
  entrypoint: string,
  { target, note, external = [], plugins = [] }: BundleOptions,
): Effect.Effect<string, BundleFailed> => {
  const failed = (reason: string) => new BundleFailed({ entrypoint, reason })
  return Effect.tryPromise({
    try: () =>
      Bun.build({
        entrypoints: [entrypoint],
        target,
        format: "esm",
        external: [...external],
        plugins: [...plugins],
      }),
    catch: (cause) => failed(messagesOf(cause)),
  }).pipe(
    Effect.flatMap((result) => {
      const output = result.outputs[0]
      return !result.success || output === undefined
        ? Effect.fail(failed(result.logs.map((log) => log.message).join("\n")))
        : Effect.tryPromise({ try: () => output.text(), catch: (cause) => failed(String(cause)) })
    }),
    Effect.flatMap((text) => {
      const stripped = text.replace(MODULE_COMMENT, "")
      if (target === "node") return Effect.succeed(`// ${note}\n${stripped}`)
      const lines = stripped.split("\n")
      const pragma = lines.indexOf("// @bun")
      if (pragma === -1)
        return Effect.fail(failed("the bundle has no // @bun pragma line to put the note after"))
      lines.splice(pragma + 1, 0, `// ${note}`)
      return Effect.succeed(lines.join("\n"))
    }),
  )
}
