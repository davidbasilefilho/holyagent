import { Effect, Schema } from "effect"

import { InvalidDraft } from "./errors.ts"

/**
 * Decodes the input of a transition, failing on excess properties. A mismatch is an InvalidDraft
 * that says what is wrong, so a transition refuses bad input before it changes anything.
 */
export const decodeInput = <S extends Schema.Decoder<unknown>>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError((error) => new InvalidDraft({ message: error.message })),
  )
