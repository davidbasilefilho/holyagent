import { Data } from "effect"

/** A request cannot be performed as given, with actionable usage guidance. */
export class Usage extends Data.TaggedError("Usage")<{
  readonly message: string
  readonly hint: string
}> {}
