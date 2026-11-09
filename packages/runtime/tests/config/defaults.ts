import { Effect } from "effect"

import { defaultConfig } from "../../src/config/schema.ts"

/** The config with every setting at its default, resolved once for the tests that compare to it. */
export const DEFAULT_CONFIG = await Effect.runPromise(defaultConfig)
