import { Data } from "effect"

/** Reading or writing a state file failed. */
export class StateIo extends Data.TaggedError("StateIo")<{
  readonly path: string
  readonly cause: unknown
}> {
  /** The description shown to the user. */
  override get message() {
    return `State I/O failed for ${this.path}: ${String(this.cause)}`
  }
}

/** A state file is not valid JSON for its schema, or disagrees with where it lives. */
export class CorruptRecord extends Data.TaggedError("CorruptRecord")<{
  readonly path: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.path} is not a valid state file: ${this.reason}`
  }
}

/** Another process holds the state lock and did not release it in time. */
export class StateLocked extends Data.TaggedError("StateLocked")<{
  readonly lockFile: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `State is locked by another process. If none is running, delete ${this.lockFile}`
  }
}

/** The state mode cannot change now: the records would be left where the new mode does not look. */
export class StateModeRefused extends Data.TaggedError("StateModeRefused")<{
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `The state mode stays as it is: ${this.reason}`
  }
}
