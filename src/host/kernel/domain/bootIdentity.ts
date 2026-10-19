// How the previous Host epoch ended (ADR-015 item 4 "Reboot detection"; 09 §8.4 step 2; OQ-55).
// Pure: no I/O, no clock read (05 §2.2, R1).
import type { HostEpoch, Instant } from './values'

/**
 * The clean-shutdown marker reasons (ADR-002 D7): the values of `host.closing.reason` (14 B-F05)
 * without `'idle'`, which AMENDMENT-5 retired and which is never written or sent (OQ-63).
 */
export type CleanShutdownReason = 'stop-all' | 'upgrade' | 'os-session-end'

/** The OS boot identity (16 §3 `currentBootIdentity`, AMENDMENT-3): each field `'unknown'` when unreadable. */
export interface BootIdentity {
  bootId: string | 'unknown'
  bootTimeMs: number | 'unknown'
  logonSessionId: string | 'unknown'
}

/** The previous epoch's facts as `app_meta` holds them, read before they are replaced. */
export interface PreviousEpoch {
  epoch: HostEpoch
  startedAt: Instant
  bootIdentity: BootIdentity
  marker: { reason: CleanShutdownReason; at: Instant } | null
}

export type PreviousEpochEndKind = 'rebooted' | 'logged-out' | 'crashed' | 'clean'

export type PreviousEpochEndRule =
  'boot-id' | 'logon-session' | 'boot-time' | 'os-session-end' | 'none'

export interface PreviousEpochEnd {
  kind: PreviousEpochEndKind
  rule: PreviousEpochEndRule
  cleanReason?: CleanShutdownReason
  degraded?: true
}

/** Rule 3's margin (ADR-015 item 4). */
export const BOOT_TIME_TOLERANCE_MS = 60_000

/** Both readings are values (neither `'unknown'`) and they differ. */
function readableAndDifferent<T extends string | number>(
  a: T | 'unknown',
  b: T | 'unknown'
): boolean {
  return a !== 'unknown' && b !== 'unknown' && a !== b
}

/**
 * The first match of ADR-015 item 4 rules 1–4 decides; `'unknown'` never compares equal, so a rule
 * whose values cannot both be read falls through. The reboot rules take precedence over the
 * marker (the "ended while the app was closed" row precedes every other row): an upgrade drain
 * followed by a reboot is a reboot. When no reboot rule matches, the previous epoch's marker
 * decides `clean` with its reason, and none decides `crashed` (rule 4). A marker `os-session-end`
 * carries its own rule, which the recovery reads as the same evidence once the session's process
 * identity is gone. `degraded` says rule 3 was needed but the OS boot time could not be read, so
 * a reboot could not be told from a crash (logged, ADR-015 item 4; 19 §9.1).
 */
export function decidePreviousEpochEnd(
  previous: PreviousEpoch,
  current: BootIdentity,
  options: { toleranceMs: number }
): PreviousEpochEnd {
  const before = previous.bootIdentity
  if (readableAndDifferent(before.bootId, current.bootId)) {
    return { kind: 'rebooted', rule: 'boot-id' }
  }
  if (readableAndDifferent(before.logonSessionId, current.logonSessionId)) {
    return { kind: 'logged-out', rule: 'logon-session' }
  }
  let degraded = false
  if (before.bootId === 'unknown' || current.bootId === 'unknown') {
    if (current.bootTimeMs === 'unknown') {
      degraded = true
    } else if (current.bootTimeMs - previous.startedAt > options.toleranceMs) {
      return { kind: 'rebooted', rule: 'boot-time' }
    }
  }
  const unreadable = degraded ? { degraded: true as const } : {}
  if (previous.marker !== null) {
    const reason = previous.marker.reason
    return {
      kind: 'clean',
      rule: reason === 'os-session-end' ? 'os-session-end' : 'none',
      cleanReason: reason,
      ...unreadable
    }
  }
  return { kind: 'crashed', rule: 'none', ...unreadable }
}
