// The Host recovery report of ADR-015 item 5 (canonical owner), copied field for field: ADR-015
// wins on any difference, and this copy is then a defect. `contracts/wire` carries the same type
// for the wire (`host.recovered`, 14 §3.6); the Host module states it here because a module's
// domain imports no `contracts` (05 §2.2, R1). Pure types and pure rules, no I/O, no clock.
//
// Machine 16 (07 §16, S16.01…S16.09) is `stepRecoveryReport`: one phase per Host epoch's report
// (INV-58), from the boot classification to `settled`, or `superseded` by another Host crash. A
// transition 07 does not list is refused (`not-listed`), never improvised. The per-item rules of
// the person's two actions (`planRetry`, `planDismiss`) read each listed dwarf's `processState`:
// - Retry (S16.05, S4.20; OQ-41 A) re-attempts the same provider session of every listed dwarf
//   still `unrecovered`; an item whose session runs (a `turn-lost` dwarf that resumed, informational)
//   or whose dwarf is gone has nothing to retry and settles as is.
// - Dismiss (S16.07, S2.13; OQ-43) walks out every listed dwarf still `unrecovered`; one whose
//   session runs stays (S2.19, CR-13-02), its item settled with the rest.
import type { DwarfId, Instant, Result } from '../../../kernel/domain/values'

/** ADR-015 item 5 `UnrecoveredReason`. */
export type UnrecoveredReason =
  | 'turn-lost' // a turn was in progress on a stdio driver; the session itself may have resumed
  | 'no-resume' // the driver has resume === 'none'
  | 'stale-ref' // the provider no longer knows the session id
  | 'resume-error' // the provider refused or failed the resume
  | 'end-failed' // a surviving stdio process could not be ended (item 4)

/** ADR-015 item 5 `HostRecoveryReport` (ids are spelled `string` by the owner). */
export interface HostRecoveryReport {
  hostEpoch: string
  at: number
  resumed: string[] // dwarfIds; diagnostics only, never shown
  unrecovered: Array<{
    dwarfId: string
    reason: UnrecoveredReason
    messageIds?: string[] // sends marked ✕ host-interrupted (ADR-022), listed here instead of their own notice
  }>
}

/**
 * The report with its display state, as 14 §3.6 `HostRecoveryReportView` carries it (06 `shownAt`,
 * `settledAt`, and the retry outcomes); `unrecovered` lists the items not settled yet.
 */
export interface RecoveryReportView extends HostRecoveryReport {
  state: 'pending-display' | 'shown' | 'retrying' | 'settled'
  shownAt?: Instant
  settledAt?: Instant
  retryOutcomes?: Array<{ dwarfId: DwarfId; outcome: 'resumed' | 'failed' }>
}

/** 07 §16 states; `none` is the diagram's `[*]` (no report for this epoch). */
export type RecoveryReportState =
  'none' | 'collecting' | 'pending-display' | 'shown' | 'retrying' | 'settled' | 'superseded'

/** One report's machine-16 phase and its display instants (14 §3.6 `shownAt`, `settledAt`). */
export interface RecoveryReportPhase {
  state: RecoveryReportState
  shownAt: Instant | null
  settledAt: Instant | null
}

/** What machine 16 reacts to (07 §16 "Trigger" column). */
export type RecoveryReportEvent =
  /** S16.01: the boot classification (S4.09–S4.19, S7.16) starts. */
  | { t: 'boot-classification' }
  /** S16.02 / S16.03: classification done and every initial resume settled. */
  | { t: 'classified'; unrecovered: number }
  /** S16.04: a `ui` client was written the report. */
  | { t: 'ui-attached'; at: Instant }
  /** S16.05: the person's Retry (`launching.retryRecovery`). */
  | { t: 'retry' }
  /** S16.06: every retried resume settled. */
  | { t: 'retries-settled'; at: Instant }
  /** S16.07: the person's Dismiss (`launching.dismissRecovery`). */
  | { t: 'dismiss'; at: Instant }
  /** S16.08: the window closed before the person acted. */
  | { t: 'window-closed' }
  /** S16.09: another Host crash before the report settled. */
  | { t: 'host-crashed' }

/** The `[*]` phase: no report for the epoch. */
export const NO_REPORT: RecoveryReportPhase = Object.freeze({
  state: 'none',
  shownAt: null,
  settledAt: null
})

/** The 07 id of each transition, for traceability (S16.01…S16.09). */
export type RecoveryReportTransition =
  'S16.01' | 'S16.02' | 'S16.03' | 'S16.04' | 'S16.05' | 'S16.06' | 'S16.07' | 'S16.08' | 'S16.09'

type Step = Result<
  { phase: RecoveryReportPhase; transition: RecoveryReportTransition },
  'not-listed'
>

const to = (
  phase: RecoveryReportPhase,
  transition: RecoveryReportTransition,
  next: Partial<RecoveryReportPhase>
): Step => ({ ok: true, value: { phase: { ...phase, ...next }, transition } })

const NOT_LISTED: Step = { ok: false, error: 'not-listed' }

/** One transition of machine 16; a refusal means no transition (07 lists no such row). */
export function stepRecoveryReport(phase: RecoveryReportPhase, event: RecoveryReportEvent): Step {
  const { state } = phase
  switch (event.t) {
    case 'boot-classification':
      return state === 'none' ? to(NO_REPORT, 'S16.01', { state: 'collecting' }) : NOT_LISTED
    case 'classified':
      if (state !== 'collecting') return NOT_LISTED
      return event.unrecovered > 0
        ? to(phase, 'S16.02', { state: 'pending-display' })
        : to(NO_REPORT, 'S16.03', {})
    case 'ui-attached':
      return state === 'pending-display'
        ? to(phase, 'S16.04', { state: 'shown', shownAt: event.at })
        : NOT_LISTED
    case 'retry':
      return state === 'shown' ? to(phase, 'S16.05', { state: 'retrying' }) : NOT_LISTED
    case 'retries-settled':
      return state === 'retrying'
        ? to(phase, 'S16.06', { state: 'settled', settledAt: event.at })
        : NOT_LISTED
    case 'dismiss':
      return state === 'shown'
        ? to(phase, 'S16.07', { state: 'settled', settledAt: event.at })
        : NOT_LISTED
    case 'window-closed':
      return state === 'shown' ? to(phase, 'S16.08', {}) : NOT_LISTED
    case 'host-crashed':
      return state === 'pending-display' || state === 'shown' || state === 'retrying'
        ? to(phase, 'S16.09', { state: 'superseded' })
        : NOT_LISTED
  }
}

/** A listed dwarf's crew `processState` now (06 `DwarfProcessState`); null: no crew row. */
export type ListedProcessState = 'running' | 'unrecovered' | 'closed' | null

/** S16.05: which items a Retry re-attempts and which settle as they are. */
export function planRetry(
  items: HostRecoveryReport['unrecovered'],
  processOf: (dwarfId: DwarfId) => ListedProcessState
): { retry: DwarfId[]; settleAsIs: DwarfId[] } {
  const retry: DwarfId[] = []
  const settleAsIs: DwarfId[] = []
  for (const { dwarfId } of items) {
    const id = dwarfId as DwarfId
    if (processOf(id) === 'unrecovered') retry.push(id)
    else settleAsIs.push(id)
  }
  return { retry, settleAsIs }
}

/** S16.07: who walks out on a Dismiss (still `unrecovered`) and who stays (S2.19). */
export function planDismiss(
  items: HostRecoveryReport['unrecovered'],
  processOf: (dwarfId: DwarfId) => ListedProcessState
): { walkOut: DwarfId[]; stays: DwarfId[] } {
  const walkOut: DwarfId[] = []
  const stays: DwarfId[] = []
  for (const { dwarfId } of items) {
    const id = dwarfId as DwarfId
    if (processOf(id) === 'unrecovered') walkOut.push(id)
    else stays.push(id)
  }
  return { walkOut, stays }
}
