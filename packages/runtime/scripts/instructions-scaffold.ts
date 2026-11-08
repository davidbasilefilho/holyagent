import { Effect } from "effect"

import { main } from "../src/instructions/scaffold.ts"

// The entry of `mise run instructions:scaffold`; the logic lives in the runtime so tests cover it.
await Effect.runPromise(main)
