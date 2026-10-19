// Machine 4B, the observed session (07 §4B, S4.30…S4.41): its states and the transitions 07 lists,
// as data. A trigger 07 does not list for a state is rejected, never guessed. The derived state
// is never stored (07 N-02): an observed session is `closed` once its `closedAt` is set.
// Pure: no I/O, no clock read (05 §2.2, R1).
import type { Result } from '../../../kernel/domain/values'

/** 07 §4B states; `[*]` is a session the observer has not seen yet. */
export type ObservedSessionState = '[*]' | 'active' | 'ending' | 'unobserved' | 'closed'

/** What can happen to an observed session (07 §4B "Trigger"). */
export type ObservedTrigger =
  /** `SessionObserved` of an identity new and not ended (S4.30). */
  | { type: 'observed' }
  /** `SessionObserved` whose identity is an owned session's (S4.31). */
  | { type: 'observed-owned' }
  /** The person resumed or forked it elsewhere and the provider minted a new id (S4.41). */
  | { type: 'resumed-elsewhere' }
  /** Transcript entries, activity, usage, asks, turn ends, subagents (S4.32, S4.40). */
  | { type: 'records' }
  /** `SessionClosedObserved` (S4.33). */
  | { type: 'closed-elsewhere' }
  /** `crew.stop` / `crew.endAllIn` (S4.34). */
  | { type: 'stop' }
  /** `EndOutcome.ended` (S4.35) or `.failed` (S4.36). */
  | { type: 'end-outcome'; ended: boolean }
  /** The Host exits or crashes (S4.37). */
  | { type: 'host-exit' }
  /** Boot catch-up finds it alive (S4.38) or ended meanwhile (S4.39). */
  | { type: 'catch-up'; alive: boolean }

export type ObservedTransitionId =
  | 'S4.30'
  | 'S4.31'
  | 'S4.32'
  | 'S4.33'
  | 'S4.34'
  | 'S4.35'
  | 'S4.36'
  | 'S4.37'
  | 'S4.38'
  | 'S4.39'
  | 'S4.40'
  | 'S4.41'

export interface ObservedStep {
  id: ObservedTransitionId
  to: ObservedSessionState
  /** S4.31: the owned session's dwarf, no new one; S4.41: a new dwarf. */
  dwarf?: 'new' | 'same'
}

/** The step 07 §4B lists for `trigger` in `state`, or `not-a-transition`. */
export function observedTransition(
  state: ObservedSessionState,
  trigger: ObservedTrigger
): Result<ObservedStep, 'not-a-transition'> {
  const step = stepOf(state, trigger)
  return step === null ? { ok: false, error: 'not-a-transition' } : { ok: true, value: step }
}

function stepOf(state: ObservedSessionState, trigger: ObservedTrigger): ObservedStep | null {
  switch (state) {
    case '[*]':
      if (trigger.type === 'observed') return { id: 'S4.30', to: 'active', dwarf: 'new' }
      if (trigger.type === 'observed-owned') return { id: 'S4.31', to: 'active', dwarf: 'same' }
      if (trigger.type === 'resumed-elsewhere') return { id: 'S4.41', to: 'active', dwarf: 'new' }
      return null
    case 'active':
      if (trigger.type === 'records') return { id: 'S4.32', to: 'active' }
      if (trigger.type === 'closed-elsewhere') return { id: 'S4.33', to: 'closed' }
      if (trigger.type === 'stop') return { id: 'S4.34', to: 'ending' }
      if (trigger.type === 'host-exit') return { id: 'S4.37', to: 'unobserved' }
      return null
    case 'ending':
      if (trigger.type === 'end-outcome') {
        return trigger.ended ? { id: 'S4.35', to: 'closed' } : { id: 'S4.36', to: 'active' }
      }
      return null
    case 'unobserved':
      if (trigger.type === 'catch-up') {
        return trigger.alive ? { id: 'S4.38', to: 'active' } : { id: 'S4.39', to: 'closed' }
      }
      return null
    case 'closed':
      // S4.40: a late write is no transition (anti-ghost): the state stays `closed`.
      if (trigger.type === 'records') return { id: 'S4.40', to: 'closed' }
      return null
  }
}
