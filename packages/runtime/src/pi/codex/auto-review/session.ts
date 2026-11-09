/** Denials in a row after which the breaker stops the turn (Codex's `MAX_CONSECUTIVE_...`). */
export const MAX_CONSECUTIVE_DENIALS = 3

/** Denials in one turn after which the breaker stops it, however they are spread. */
export const MAX_TOTAL_DENIALS = 10

/** How many denied actions `/approve` keeps to choose from. */
export const DENIED_KEPT = 10

/** What the breaker decides after a denial, with the counts of the turn. */
export interface BreakerResult {
  /** True when the turn is to be stopped; true once per turn. */
  readonly interrupt: boolean
  /** Denials in a row, this one included. */
  readonly consecutive: number
  /** Denials in the turn, this one included. */
  readonly total: number
}

/** A denied action the user can approve for one retry. */
export interface DeniedAction {
  /** The action's identity: its JSON. */
  readonly key: string
  /** A line that says what the action was. */
  readonly summary: string
  /** The reviewer's reason. */
  readonly rationale: string
}

/**
 * The state of auto-review in one Pi session: the denial breaker of the current turn, the denied
 * actions `/approve` can lift, the approvals waiting for a retry and the actions whose review has
 * timed out once.
 */
export interface ReviewSession {
  /** Starts a turn: the breaker's counts begin at zero. */
  readonly newTurn: () => void
  /**
   * Records a denial by the reviewer and remembers the action for `/approve`. After
   * {@link MAX_CONSECUTIVE_DENIALS} in a row or {@link MAX_TOTAL_DENIALS} in the turn the result
   * says to interrupt, once per turn.
   */
  readonly recordDenial: (action: DeniedAction) => BreakerResult
  /**
   * Remembers a denial that the breaker does not count, a review that could not complete (Codex
   * leaves it out too): the action can be approved, and the run of denials ends.
   */
  readonly recordFailure: (action: DeniedAction) => void
  /** Records a review that did not deny (an allow or a timeout): the run of denials ends. */
  readonly recordNonDenial: () => void
  /** The denied actions, newest first. */
  readonly denied: () => ReadonlyArray<DeniedAction>
  /** Approves the denied action at the index (0 is the newest) for one retry; `undefined` for none. */
  readonly approve: (index: number) => DeniedAction | undefined
  /** Whether the action has an approval waiting. */
  readonly isApproved: (key: string) => boolean
  /** Uses up the action's approval: it covers one retry. */
  readonly consumeApproval: (key: string) => void
  /**
   * Records a timeout of the action's review; true when it had already timed out once, so this was
   * the retry.
   */
  readonly recordTimeout: (key: string) => boolean
  /** Forgets that the action's review timed out (it was decided). */
  readonly forgetTimeout: (key: string) => void
  /** Forgets everything: a new session. */
  readonly reset: () => void
}

/** A fresh {@link ReviewSession}. */
export const createReviewSession = (): ReviewSession => {
  let consecutive = 0
  let total = 0
  let interrupted = false
  let denied: Array<DeniedAction> = []
  const approved = new Set<string>()
  const timedOut = new Set<string>()
  const remember = (action: DeniedAction) => {
    denied = [action, ...denied.filter((kept) => kept.key !== action.key)].slice(0, DENIED_KEPT)
    approved.delete(action.key)
  }
  return {
    newTurn: () => {
      consecutive = 0
      total = 0
      interrupted = false
    },
    recordDenial: (action) => {
      remember(action)
      consecutive++
      total++
      const interrupt =
        !interrupted && (consecutive >= MAX_CONSECUTIVE_DENIALS || total >= MAX_TOTAL_DENIALS)
      if (interrupt) interrupted = true
      return { interrupt, consecutive, total }
    },
    recordFailure: (action) => {
      remember(action)
      consecutive = 0
    },
    recordNonDenial: () => {
      consecutive = 0
    },
    denied: () => denied,
    approve: (index) => {
      const action = denied[index]
      if (action === undefined) return undefined
      denied = denied.filter((kept) => kept.key !== action.key)
      approved.add(action.key)
      return action
    },
    isApproved: (key) => approved.has(key),
    consumeApproval: (key) => void approved.delete(key),
    recordTimeout: (key) => {
      const again = timedOut.has(key)
      timedOut.add(key)
      return again
    },
    forgetTimeout: (key) => void timedOut.delete(key),
    reset: () => {
      consecutive = 0
      total = 0
      interrupted = false
      denied = []
      approved.clear()
      timedOut.clear()
    },
  }
}
