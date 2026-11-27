import { dirname, join } from "node:path"

import { Effect, Schema } from "effect"

import {
  readJsonObjectSnapshot,
  writeJsonObjectIfUnchanged,
} from "../../../core/src/setup/json-file.ts"
import { userConfigFile } from "../config/load.ts"
import type { Env } from "./environment.ts"
import { SetupFailure } from "./errors.ts"

const Selection = Schema.Struct({
  browsers: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,99}$/))),
})

/** Read the saved browser ids, distinguishing an absent preference from a saved empty list. */
export const readBrowserPreference = Effect.fn("readBrowserPreference")(function* (env: Env) {
  const file = join(dirname(userConfigFile(env)), "browse-selection.json")
  const { value, text } = yield* readJsonObjectSnapshot(file)
  if (text === undefined) return { file, text, browsers: undefined }
  if (!Schema.is(Selection)(value) || new Set(value.browsers).size !== value.browsers.length)
    return yield* new SetupFailure({ message: "Invalid HolyAgent browser selection record" })
  return { file, text, browsers: value.browsers }
})

/** Save a reviewed selection without overwriting changes made after its snapshot was read. */
export const writeBrowserPreference = (
  preference: { readonly file: string; readonly text: string | undefined },
  browsers: ReadonlyArray<string>,
) =>
  writeJsonObjectIfUnchanged(preference.file, { browsers }, preference.text, { mode: 0o600 }).pipe(
    Effect.flatMap((written) =>
      written
        ? Effect.void
        : Effect.fail(new SetupFailure({ message: "Browser selection changed since it was read" })),
    ),
  )
