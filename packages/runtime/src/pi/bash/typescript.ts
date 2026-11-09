import { Effect } from "effect"

/** The language a piece of code ran as: TypeScript with its types removed, or JavaScript as written. */
export type CodeLanguage = "typescript" | "javascript"

/** Code ready for `js-exec`, and the language it was read as. */
export interface PreparedCode {
  readonly code: string
  readonly language: CodeLanguage
}

let transpiler: Bun.Transpiler | undefined

/**
 * Reads code as TypeScript first, JavaScript second. The code is run through Bun's TypeScript
 * transpiler, which removes types and compiles what only TypeScript has (enums, parameter
 * properties); the result is what `js-exec` runs. Code the TypeScript reading rejects (JavaScript
 * that TypeScript's grammar does not allow, such as repeated parameter names) is run as written, so
 * a program is never refused for being JavaScript.
 */
export const typeScriptFirst = (code: string): Effect.Effect<PreparedCode> =>
  Effect.try(() => {
    transpiler ??= new Bun.Transpiler({ loader: "ts" })
    return transpiler.transformSync(code)
  }).pipe(
    Effect.map((stripped): PreparedCode => ({ code: stripped, language: "typescript" })),
    Effect.orElseSucceed((): PreparedCode => ({ code, language: "javascript" })),
  )
