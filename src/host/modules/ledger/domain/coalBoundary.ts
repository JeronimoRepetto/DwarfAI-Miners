// The install-moment boundary of the coal backfill (09 §5.5; ADR-006 item 8; 06 INV-95). Pure: no
// I/O, no clock read (05 §2.2, R1).
//
// - A per-unit record (the provider's own accounted unit, the same `unitKey` as live accounting) is
//   coal when its provider time is strictly before `install_moment.at`; at or after it, the unit
//   belongs to live accounting (`decideCredit`), so a unit is paid by exactly one path.
// - A stream that only yields a lifetime total (a Codex rollout's running total, an OpenCode
//   session's `tokens_*` sum) is keyed `coal:<streamId>` and is coal only when its newest record is
//   strictly before the moment: a stream that straddles it pays nothing as coal and its
//   post-boundary units are paid live (the honest-floor rule, 09 §5.5).
import type { Instant } from '../../../kernel/domain/values'
import type { UnitKey } from './credit'

/** What the boundary reads of one historical record. */
export interface CoalCandidate {
  /** `'unit'`: one accounted unit; `'lifetime'`: a whole stream's running total. */
  span: 'unit' | 'lifetime'
  /** The unit's provider time, or the stream's newest record time for a lifetime total. */
  providerTime: Instant
}

/** Whether the record is history the backfill pays as coal (strictly before the moment). */
export function isCoal(record: CoalCandidate, installMomentAt: Instant): boolean {
  return record.providerTime < installMomentAt
}

/** The unit key of a lifetime-total stream (09 §5.5 `coal:<streamId>`). */
export function coalStreamKey(streamId: string): UnitKey {
  return `coal:${streamId}`
}
