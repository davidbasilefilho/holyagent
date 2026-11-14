import { Data } from "effect"

/**
 * A HolyAgent config file is not valid JSON, has a key the schema does not know, or has a value of
 * the wrong kind. `path` is a file that exists, and `reason` names the field.
 */
export class ConfigInvalid extends Data.TaggedError("ConfigInvalid")<{
  readonly path: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.path} is not a valid HolyAgent config: ${this.reason}`
  }
}
