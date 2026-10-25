import { Data } from "effect"

/** A referenced Intent or Assignment does not exist. */
export class UnknownRecord extends Data.TaggedError("UnknownRecord")<{
  readonly kind: "intent" | "assignment"
  readonly id: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Unknown ${this.kind} ${this.id}`
  }
}

/** A record with this id already exists, so a create would overwrite it. */
export class DuplicateRecord extends Data.TaggedError("DuplicateRecord")<{
  readonly kind: "intent" | "assignment"
  readonly id: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `A ${this.kind} with id ${this.id} already exists`
  }
}

/** An ownership path is absolute, climbs out of the project or is not portable. */
export class InvalidPath extends Data.TaggedError("InvalidPath")<{
  readonly path: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Invalid path "${this.path}": ${this.reason}`
  }
}

/** An input does not match its schema, or breaks a rule that the schema cannot express. */
export class InvalidDraft extends Data.TaggedError("InvalidDraft")<{
  readonly message: string
}> {}

/** An Assignment of a writing route owns no path, so nothing bounds what it may change. */
export class MissingOwnership extends Data.TaggedError("MissingOwnership")<{
  readonly roleTask: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.roleTask} writes, so it needs at least one ownership path`
  }
}

/** The Intent changed materially since the revision the Assignment was written against. */
export class StaleRevision extends Data.TaggedError("StaleRevision")<{
  readonly given: number
  readonly live: number
}> {
  /** The description shown to the user. */
  override get message() {
    return `Stale intent revision ${this.given}; the live revision is ${this.live}`
  }
}

/** The Intent is closed, so it authorizes no new work. */
export class IntentClosed extends Data.TaggedError("IntentClosed")<{
  readonly intentId: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Intent ${this.intentId} is closed; reopen it first`
  }
}

/** The Intent cannot close while Assignments of it are Running or wait for acceptance. */
export class IntentHasOpenWork extends Data.TaggedError("IntentHasOpenWork")<{
  readonly intentId: string
  readonly running: ReadonlyArray<string>
  readonly unaccepted: ReadonlyArray<string>
}> {
  /** The description shown to the user. */
  override get message() {
    return `Intent ${this.intentId} has Running (${this.running.join(", ")}) or unaccepted (${this.unaccepted.join(", ")}) Assignments; settle them or give a reason to drop them`
  }
}

/** The operation does not apply to the record's current state. */
export class InvalidTransition extends Data.TaggedError("InvalidTransition")<{
  readonly id: string
  readonly state: string
  readonly action: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Cannot ${this.action} ${this.id} while it is ${this.state}`
  }
}

/** A Running writer already owns paths that overlap the ones this writer would own. */
export class OwnershipConflict extends Data.TaggedError("OwnershipConflict")<{
  readonly id: string
  readonly runningId: string
  readonly path: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.id} cannot start: ${this.runningId} is Running and owns an overlapping path (${this.path})`
  }
}

/** A dependency is not Succeeded and accepted at the Assignment's Intent revision. */
export class DependencyNotAccepted extends Data.TaggedError("DependencyNotAccepted")<{
  readonly id: string
  readonly dependency: string
  readonly reason: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.id} cannot start: dependency ${this.dependency} ${this.reason}`
  }
}

/** An acceptance does not support every blocking criterion and required evidence label. */
export class InsufficientAcceptance extends Data.TaggedError("InsufficientAcceptance")<{
  readonly id: string
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Acceptance of ${this.id} rejected: ${this.detail}`
  }
}

/** The specialist that is being bound disagrees with the Assignment or its own registry entry. */
export class SpecialistMismatch extends Data.TaggedError("SpecialistMismatch")<{
  readonly agentId: string
  readonly detail: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `Specialist ${this.agentId}: ${this.detail}`
  }
}

/** A Running Assignment cannot succeed before a specialist is recorded for it. */
export class SpecialistNotRecorded extends Data.TaggedError("SpecialistNotRecorded")<{
  readonly id: string
}> {
  /** The description shown to the user. */
  override get message() {
    return `${this.id} has no recorded specialist, so it cannot be closed as Succeeded`
  }
}
