// The ADR-021 turn-end rules the Host applies to every reported end (driver `turn.ended` or
// `ObservedTurnEnded`). Pure: no I/O, no clock read (05 §2.2, R1); no provider id (R12): the
// session's capability is data handed in.
//
// - `announceable`: ADR-021 item 3 — the level-2 finished cue and the level-3 "finished the turn"
//   notification fire only for a reliable end the person did not cancel from the app, whatever its
//   kind. An inferred end only moves the status (OQ-36 A, ADR-032 item 5).
// - `downgrade`: ADR-021 item 2 — `turnEnd` is evaluated per session; a session whose capability is
//   not `reliable` (an UNVERIFIED source is `none`) cannot announce, so its ends are `inferred`
//   whatever their reporter claimed. An inferred end is never raised to reliable.
//
// The fact key `turn:<dwarfId>:<turnKey>` is the kernel's (`lifecycleFactKey`, 09 §5.6): one owner.
import type { TurnEnded } from '../../../kernel/domain/sharedContracts'

/** ADR-009 D2 `ProviderCapabilities.turnEnd` (referenced, not restated: a type test holds it equal). */
export type TurnEndCapability = 'reliable' | 'none'

/** ADR-021 item 3: may a consumer play the finished cue or raise "finished the turn" for this end? */
export function announceable(end: TurnEnded): boolean {
  return end.reliability === 'reliable' && !end.cancelledFromApp
}

/** ADR-021 item 2: the end as the session's `turnEnd` capability allows it to be reported. */
export function downgrade(end: TurnEnded, capability: TurnEndCapability): TurnEnded {
  if (capability === 'reliable' || end.reliability === 'inferred') return end
  return { ...end, reliability: 'inferred' }
}
