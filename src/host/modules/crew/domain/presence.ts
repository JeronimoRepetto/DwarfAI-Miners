// Machine 2, dwarf presence (07 §2; ADR-032 item 2; 06 §5.1). Whether a dwarf exists in its mine,
// independent of its status. Pure: no I/O, no clock read (R1); every instant is passed in.
//
// Host-side only: `arriving` (the walk-in, S2.02, S2.03) and the end of the walk-out (S2.17) are
// renderer animations, and `gone` is the derived fact `departedAt !== null` (`isGone`).
import type { Instant, Result } from '../../../kernel/domain/values'

/** ADR-032 item 2: `resuming` is drawn exactly as `present` (INV-32). */
export type DwarfPresence = 'present' | 'resuming' | 'walking-out'

/**
 * 06 §5.1: `running` → `closed`; `running` → `unrecovered` only in the Host recovery pass;
 * `unrecovered` → `running` (Retry succeeded) or `closed` (Retry failed, Dismiss). `closed` is
 * terminal (INV-26).
 */
export type DwarfProcessState = 'running' | 'unrecovered' | 'closed'

/** 06 §5.1 `DepartureCause`: the `sessionClosed` causes (05 §3.2) plus the two recovery ones (OQ-43). */
export type DepartureCause =
  | 'stopped'
  | 'mine-removed'
  | 'closed-elsewhere'
  | 'crashed'
  | 'recovery-dismissed'
  | 'recovery-failed'

/** 06 §0 `EndReason` = ADR-014 item 1 `why`: why the Host asked a session to end. */
export type EndReason =
  'stop-dwarf' | 'remove-mine' | 'stop-all' | 'host-recovery' | 'delegation-done'

/** The `Dwarf` fields machine 2 owns (07 §0.1 row 2). */
export interface PresenceState {
  presence: DwarfPresence
  processState: DwarfProcessState
  /** Set together with `departureCause` when the dwarf leaves (BR-11). */
  departedAt: Instant | null
  departureCause: DepartureCause | null
}

/** What machine 2 reacts to in the Host (07 §2 transitions). */
export type PresenceEvent =
  /** The single departure path (`CrewCommands.sessionClosed`): S2.04–S2.07, S2.12–S2.14, S2.18, S2.19. */
  | { type: 'session-closed'; cause: DepartureCause; at: Instant }
  /** S2.08: the boot classification resumes or re-adopts the dwarf's owned session. */
  | { type: 'resume-pending' }
  /** S2.09: that resume or adoption succeeded. */
  | { type: 'resumed' }
  /** S2.10 (`CrewCommands.markUnrecovered`): listed in the `HostRecoveryReport`. */
  | { type: 'listed-unrecovered' }
  /** S2.11: a Retry resumed the same provider session. */
  | { type: 'retry-succeeded' }
  /** S2.15: the end of a "Stop dwarf…", Remove mine or stop-all failed. */
  | { type: 'stop-failed' }
  /** S2.16: never a departure (PO #8, #63, #98; BR-11; ADR-002 D7, D9). */
  | {
      type: 'quiet'
      what: 'silence' | 'window-closed' | 'app-quit' | 'ui-reconnecting' | 'inferred-turn-end'
    }

/** Why machine 2 takes no transition for an event; the caller then publishes nothing. */
export type PresenceRefusal =
  | 'already-departed'
  | 'process-not-closed'
  | 'session-running'
  | 'not-resuming'
  | 'not-unrecovered'
  | 'not-running'

/** S2.01: a dwarf is present the moment it arrives, with its process running. */
export function arrivedPresence(): PresenceState {
  return { presence: 'present', processState: 'running', departedAt: null, departureCause: null }
}

/** The derived `gone` (07 §2): out of `Mine.crew` from `DwarfDeparted` on, whatever the renderer shows. */
export function isGone(s: PresenceState): boolean {
  return s.departedAt !== null
}

/** The process closed: `closed` is terminal and comes before any departure (INV-26). */
export function closeProcess(s: PresenceState): PresenceState {
  return { ...s, processState: 'closed' }
}

/** INV-26: a dwarf walks out only once, and only after its `processState` is `closed`. */
export function depart(
  s: PresenceState,
  cause: DepartureCause,
  at: Instant
): Result<PresenceState, PresenceRefusal> {
  if (isGone(s)) return refuse('already-departed')
  if (s.processState !== 'closed') return refuse('process-not-closed')
  return {
    ok: true,
    value: { ...s, presence: 'walking-out', departedAt: at, departureCause: cause }
  }
}

/** One transition of machine 2; a refusal means no transition and no event. */
export function nextPresence(
  s: PresenceState,
  e: PresenceEvent
): Result<PresenceState, PresenceRefusal> {
  if (e.type === 'quiet' || e.type === 'stop-failed') return { ok: true, value: s }
  if (isGone(s)) return refuse('already-departed')
  switch (e.type) {
    case 'session-closed':
      return sessionClosed(s, e.cause, e.at)
    case 'resume-pending':
      if (s.presence === 'resuming') return { ok: true, value: s }
      return s.processState === 'running'
        ? { ok: true, value: { ...s, presence: 'resuming' } }
        : refuse('not-running')
    case 'resumed':
      return s.presence === 'resuming'
        ? { ok: true, value: { ...s, presence: 'present' } }
        : refuse('not-resuming')
    case 'listed-unrecovered':
      return { ok: true, value: { ...s, presence: 'present', processState: 'unrecovered' } }
    case 'retry-succeeded':
      return s.processState === 'unrecovered'
        ? { ok: true, value: { ...s, processState: 'running' } }
        : refuse('not-unrecovered')
  }
}

/**
 * S2.04–S2.07, S2.12–S2.14, S2.18: close the process, then depart. A recovery cause departs only
 * a dwarf still `unrecovered` (S2.13 guard); one whose session runs stays (S2.19).
 */
function sessionClosed(
  s: PresenceState,
  cause: DepartureCause,
  at: Instant
): Result<PresenceState, PresenceRefusal> {
  const recoveryCause = cause === 'recovery-dismissed' || cause === 'recovery-failed'
  if (recoveryCause && s.processState !== 'unrecovered') return refuse('session-running')
  return depart(closeProcess(s), cause, at)
}

/**
 * The cause of an exit (05 §4; 06 §5.1): the dwarf's pending end when the Host asked for one,
 * else `crashed` for an owned session nobody stopped and `closed-elsewhere` for an observed one.
 * `host-recovery` departs nobody (ADR-014 item 1): null means "no `sessionClosed` call".
 * `owned` comes from launching (a live `LaunchRecord`), never from a `Dwarf` field (INV-30).
 */
export function departureCause(
  pendingWhy: EndReason | null,
  owned: boolean
): DepartureCause | null {
  switch (pendingWhy) {
    case 'stop-dwarf':
    case 'stop-all':
    case 'delegation-done':
      return 'stopped'
    case 'remove-mine':
      return 'mine-removed'
    case 'host-recovery':
      return null
    case null:
      return owned ? 'crashed' : 'closed-elsewhere'
  }
}

function refuse(error: PresenceRefusal): { ok: false; error: PresenceRefusal } {
  return { ok: false, error }
}
