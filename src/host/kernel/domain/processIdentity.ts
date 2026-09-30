// The one process identity of the Host (ADR-014 item 1, 06 §0.1) and the one rule that compares
// two of them (ADR-015 item 1). Pure: no I/O, no clock read (05 §2.2, R1).

/** ADR-014 item 1: a bare pid is never evidence of a process (06 INV-51). */
export interface ProcessIdentity {
  pid: number
  processStartTimeMs: number
  bootId: string
}

/** ADR-014 item 1: how ending a session or a process tree turned out. */
export type EndOutcome =
  | { kind: 'ended' }
  | { kind: 'failed'; reason: 'access-denied' | 'still-alive' | 'protocol-error' | 'no-identity' }

/** What an OS probe of a pid answers (16 §3 `ProcessControl.probe`). */
export type ProbeResult = ProcessIdentity | 'absent' | 'unknown'

/**
 * The ONE tolerance between two readings of one process's start time (ADR-015 item 1, TM §2
 * inv. 2). Probes read start times in different units and resolutions; a recycled pid names a
 * process created seconds to days later, never within 2 s.
 */
export const PROCESS_START_TOLERANCE_MS = 2_000

/**
 * Whether two identities describe the same OS process (ADR-015 item 1): same boot, same pid, and
 * start times at most PROCESS_START_TOLERANCE_MS apart. A non-finite start time is no reading, so
 * it never matches (06 INV-51).
 */
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  if (a.pid !== b.pid || a.bootId !== b.bootId) return false
  const apart = Math.abs(a.processStartTimeMs - b.processStartTimeMs)
  return Number.isFinite(apart) && apart <= PROCESS_START_TOLERANCE_MS
}

/**
 * Whether a probe's answer is evidence that `recorded` is still the running process: only a full
 * identity can be. `'absent'` and `'unknown'` are both a mismatch for re-adoption and kill (#231
 * polarity, 06 INV-51): no answer is never treated as the same process.
 */
export function matchesRecorded(probed: ProbeResult, recorded: ProcessIdentity): boolean {
  if (probed === 'absent' || probed === 'unknown') return false
  return sameProcess(probed, recorded)
}
