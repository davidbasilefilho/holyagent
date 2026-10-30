import { Data } from "effect"

/**
 * A setup or doctor step could not start or finish, such as a settings file that is not a JSON
 * object. The message names the file and the cause; the step turns it into a `!` report line, so
 * the steps after it still run.
 */
export class SetupFailure extends Data.TaggedError("SetupFailure")<{
  readonly message: string
}> {}
