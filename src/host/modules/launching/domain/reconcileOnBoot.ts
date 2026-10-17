// The pure boot reconcile of ADR-015 item 4 (`reconcileOnBoot(records, liveness, evidence) →
// transitions`, HO-27; 07 machine 4A S4.09…S4.24, machine 5B S5.22/S5.23). No I/O, no clock read
// (05 §2.2, R1): the recovery pass (application/recoverAfterHostStart.ts) reads the stores, probes
// every recorded process identity and passes the answers in.
//
// The rows, first match wins:
// 1. Reboot or logout since the previous epoch (rules 1–3 of "Reboot detection", decided by the
//    kernel's `decidePreviousEpochEnd`), or a clean-shutdown marker `os-session-end` with the
//    session's process identity gone: ended while the app was closed (S4.24; OQ-55). This row
//    precedes every other one. A live identity under `os-session-end` (a cancelled OS shutdown)
//    follows the crash rows.
// 2. A record whose resume intent an earlier stop-all cleared: ended, nothing resumed (S4.23).
// 3. A process identity alive (INV-51: only a full probe identity within 2 000 ms of the recorded
//    start time, same boot id, counts; `'absent'` and `'unknown'` never do, the #231 polarity):
//    - a server-kind session whose driver has `adopt`: re-adopt it, falling back to a resume when
//      `adopt` answers null or fails (S4.10, S4.12);
//    - otherwise the Host that held its stdio is gone: end it identity-checked first, then resume
//      it, never while the old process runs (S4.13, S4.14; INV-56).
// 4. The process gone (or never recorded): resume by the stored provider session id when the
//    driver can (S4.16), else unrecovered `no-resume` (S4.17).
//
// A turn that was running on a stdio driver is lost with the Host: its session still resumes, and
// the dwarf is listed `turn-lost` for information (S4.18; FM-002). An in-flight launch settles
// `succeeded` with its dwarf when session evidence exists, else `lost` (S5.22, S5.23); after a
// reboot or logout always `lost`.
import type { PreviousEpochEnd } from '../../../kernel/domain/bootIdentity'
import {
  matchesRecorded,
  type ProbeResult,
  type ProcessIdentity
} from '../../../kernel/domain/processIdentity'
import type { DwarfId, LaunchId } from '../../../kernel/domain/values'

/** What the boot knows of one live owned record (06 §8.1 `LaunchRecord`, read at boot). */
export interface OwnedRecordFacts {
  dwarfId: DwarfId
  /** The recorded process identity, absent when none was recorded or it was already ended. */
  process?: ProcessIdentity
  /** The process's `ProcessPurpose` is `session-server` (a shared server, ADR-014 item 5). */
  serverKind: boolean
  resumeIntent: boolean
  /** The driver can resume the session by its provider session id (`resume !== 'none'`). */
  canResume: boolean
  /** The driver can re-attach a live server-kind session (`adopt`). */
  canAdopt: boolean
  /** A turn was open on a stdio driver when the Host stopped (S4.18; FM-002). */
  turnActive: boolean
}

/** A launch the previous epoch left `routing`, `resolving` or `spawned` (INV-53). */
export interface InFlightLaunchFacts {
  launchId: LaunchId
  /** The dwarf the session evidence names (S5.23), or null when there is none (S5.22). */
  evidence: DwarfId | null
}

export interface BootReconcileInput {
  /** How the previous epoch ended (ADR-015 item 4; kernel `decidePreviousEpochEnd`). */
  boot: PreviousEpochEnd
  records: readonly OwnedRecordFacts[]
  /** The probe answer per recorded pid (16 §3 `ProcessControl.probe`); a missing pid is `'absent'`. */
  probes: ReadonlyMap<number, ProbeResult>
  inFlight: readonly InFlightLaunchFacts[]
}

/** What follows a step that ends or re-adopts: the resume, or `no-resume` when there is none. */
export type AfterSurvivor = 'resume' | 'no-resume'

export type RecordTransition =
  /** S4.24: the machine rebooted or the person logged out; no resume, no report item, no toast. */
  | { t: 'ended-while-closed'; dwarfId: DwarfId }
  /** S4.23: a stop-all cleared its resume intent; nothing resumed. */
  | { t: 'not-resumed'; dwarfId: DwarfId }
  /** S4.10: re-adopt the live server-kind session; S4.12: `then` when adopt gives nothing. */
  | { t: 'adopt'; dwarfId: DwarfId; process: ProcessIdentity; then: AfterSurvivor; turnLost: false }
  /** S4.13: end the surviving process identity-checked, then `then` (S4.14) or `end-failed` (S4.15). */
  | {
      t: 'end-survivor'
      dwarfId: DwarfId
      process: ProcessIdentity
      then: AfterSurvivor
      turnLost: boolean
    }
  /** S4.16: resume by the stored provider session id. */
  | { t: 'resume'; dwarfId: DwarfId; turnLost: boolean }
  /** S4.17: the driver cannot resume. */
  | { t: 'unrecovered'; dwarfId: DwarfId; reason: 'no-resume' }

export type LaunchTransition =
  | { t: 'succeeded'; launchId: LaunchId; dwarfId: DwarfId } // S5.23
  | { t: 'lost'; launchId: LaunchId } // S5.22

export interface BootReconcileResult {
  records: RecordTransition[]
  launches: LaunchTransition[]
}

/** Rules 1–3 of "Reboot detection" matched: every owned process of the old OS session is gone. */
function rebootedOrLoggedOut(boot: PreviousEpochEnd): boolean {
  return boot.kind === 'rebooted' || boot.kind === 'logged-out'
}

/** The recorded identity is the running process (INV-51; #231 polarity: no answer is a mismatch). */
function alive(record: OwnedRecordFacts, probes: ReadonlyMap<number, ProbeResult>): boolean {
  if (record.process === undefined) return false
  return matchesRecorded(probes.get(record.process.pid) ?? 'absent', record.process)
}

function reconcileRecord(
  record: OwnedRecordFacts,
  boot: PreviousEpochEnd,
  probes: ReadonlyMap<number, ProbeResult>
): RecordTransition {
  const { dwarfId } = record
  if (rebootedOrLoggedOut(boot)) return { t: 'ended-while-closed', dwarfId }
  const live = alive(record, probes)
  if (boot.rule === 'os-session-end' && !live) return { t: 'ended-while-closed', dwarfId }
  if (!record.resumeIntent) return { t: 'not-resumed', dwarfId }
  const then: AfterSurvivor = record.canResume ? 'resume' : 'no-resume'
  if (live && record.process !== undefined) {
    if (record.serverKind && record.canAdopt) {
      return { t: 'adopt', dwarfId, process: record.process, then, turnLost: false }
    }
    const turnLost = record.turnActive && !record.serverKind
    return { t: 'end-survivor', dwarfId, process: record.process, then, turnLost }
  }
  if (!record.canResume) return { t: 'unrecovered', dwarfId, reason: 'no-resume' }
  return { t: 'resume', dwarfId, turnLost: record.turnActive && !record.serverKind }
}

/** ADR-015 item 4: one transition per stranded record and per in-flight launch, in input order. */
export function reconcileOnBoot(input: BootReconcileInput): BootReconcileResult {
  const { boot, probes } = input
  const closed = rebootedOrLoggedOut(boot)
  return {
    records: input.records.map((record) => reconcileRecord(record, boot, probes)),
    launches: input.inFlight.map((launch): LaunchTransition =>
      launch.evidence === null || closed
        ? { t: 'lost', launchId: launch.launchId }
        : { t: 'succeeded', launchId: launch.launchId, dwarfId: launch.evidence }
    )
  }
}
