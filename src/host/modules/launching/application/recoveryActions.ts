// `LaunchCommands.retryRecovery` and `dismissRecovery` (16 §4.5; ADR-015 item 5; OQ-41 A, OQ-43;
// CR-13-02; 07 machine 16 S16.04…S16.08, machine 4A S4.20…S4.22, machine 2 S2.10…S2.13, S2.19;
// UC-025), and the display phase of the one report of this Host epoch (INV-58).
//
// The display phase (`collecting` → `pending-display` → `shown` → `retrying` → `settled`) is Host
// memory beside the stored report (`RecoveryReportStore`): only this epoch's report can be offered,
// since the next boot's save supersedes an unsettled one (S16.09), and `retrying` lives exactly as
// long as the Host that runs the retry. The stored rows keep what must survive a restart: the
// items, the first display (`shown_at`) and each item's outcome (`retry_outcome`).
// - The boot pass tells `collecting()` and `classified(report)` (recoverAfterHostStart.ts); before
//   `classified` nothing is offered, even though the items known at classification are stored.
// - `report()` is the offered report not settled yet (the snapshot `recovery` section); `view()` the
//   latest, settled included (the `host.recovered` frame). Both list only the unsettled items.
// - `shown()` (a `ui` connection was written it, 14 §4.3 rule 5) marks it shown once (S16.04);
//   later attaches show it again unchanged (S16.08).
//
// Retry (`retryRecovery`, never automatic): by `hostEpoch`, `no-report` when that epoch has no
// offered unsettled report. One action for the group: a second call while it runs answers the same
// result. The items whose dwarf is not `unrecovered` any more (a `turn-lost` dwarf whose session
// resumed, informational) settle as they are; `RecoveryRetried` names the others, which resume
// spaced 500 ms through `SessionResumer`, the SAME provider session (S4.20). A resumed one settles
// `resumed`, silently (S2.11); a failed one settles `failed`, its record ends, and
// `RecoveryRetryFailed` walks it out through its route (S4.21, S2.12). Answered once every retried
// resume settled (S16.06), with the settled report.
//
// Dismiss (`dismissRecovery`): by `hostEpoch`, `no-report` likewise. Every item settles (the store
// deletes a dismissed one); each listed dwarf still `unrecovered` has its record ended, so no later
// boot resumes it, and `RecoveryDismissed` walks it out through its route (S4.22, S2.13); one whose
// session runs stays, its session untouched (S2.19). A Dismiss while a Retry runs changes nothing
// (07 lists no `retrying` → `settled` by dismissal; the window offers no Dismiss then).
//
// No path here raises a PO #62 toast (TC-174-02): the listed dwarfs are covered by the recovery
// (sessionExited.ts), and a walk-out departs `recovery-failed` / `recovery-dismissed`.
import type { DwarfId, EventId, HostEpoch, Result } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { CrewQueries } from '../../crew'
import {
  NO_REPORT,
  planDismiss,
  planRetry,
  stepRecoveryReport,
  type HostRecoveryReport,
  type RecoveryReportEvent,
  type RecoveryReportPhase,
  type RecoveryReportView
} from '../domain/recoveryReport'
import type { LaunchRecordStore } from '../ports/launchRecordStore'
import type { RecoveryReportStore } from '../ports/recoveryReportStore'
import type { LaunchingEvent } from './events'
import { RESUME_SPACING_MS } from './recoverAfterHostStart'
import type { SessionResumer } from './sessionResumer'

export interface RecoveryActionsDeps {
  reports: RecoveryReportStore
  records: LaunchRecordStore
  transactions: TransactionRunner
  resumer: SessionResumer
  /** Each listed dwarf's `processState` now (the launching → crew edge, 05 §1.3). */
  crew: Pick<CrewQueries, 'get'>
  bus: Pick<DomainEventBus<LaunchingEvent>, 'publish'>
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

type Outcome = NonNullable<RecoveryReportView['retryOutcomes']>[number]
type RetryResult = Result<RecoveryReportView, 'no-report'>

const OFFERED = new Set(['pending-display', 'shown', 'retrying'])

export class RecoveryActions {
  private phase: RecoveryReportPhase = NO_REPORT
  /** The report as offered (S16.02); its settled view keeps its epoch, instant and `resumed`. */
  private offered: HostRecoveryReport | null = null
  private readonly outcomes: Outcome[] = []
  private retrying: Promise<RetryResult> | null = null

  constructor(private readonly deps: RecoveryActionsDeps) {}

  /** S16.01: the boot classification starts. */
  collecting(): void {
    this.step({ t: 'boot-classification' })
  }

  /** S16.02 / S16.03: classification done and every initial resume settled. */
  classified(report: HostRecoveryReport): void {
    if (this.step({ t: 'classified', unrecovered: report.unrecovered.length })) {
      this.offered = report.unrecovered.length > 0 ? report : null
    }
  }

  report(): RecoveryReportView | null {
    return OFFERED.has(this.phase.state) ? this.view() : null
  }

  view(): RecoveryReportView | null {
    const offered = this.offered
    if (offered === null || !(OFFERED.has(this.phase.state) || this.phase.state === 'settled')) {
      return null
    }
    const pending = this.deps.reports.pending()
    const view: RecoveryReportView = {
      hostEpoch: offered.hostEpoch,
      at: offered.at,
      resumed: [...offered.resumed],
      unrecovered:
        pending?.hostEpoch === offered.hostEpoch
          ? pending.unrecovered.map((item) => ({ ...item }))
          : [],
      state: this.phase.state as RecoveryReportView['state']
    }
    if (this.phase.shownAt !== null) view.shownAt = this.phase.shownAt
    if (this.phase.settledAt !== null) view.settledAt = this.phase.settledAt
    if (this.outcomes.length > 0) view.retryOutcomes = this.outcomes.map((o) => ({ ...o }))
    return view
  }

  /** S16.04: a `ui` connection was written the report; the first instant is stored once. */
  shown(): void {
    if (this.phase.state !== 'pending-display' || this.offered === null) return
    const at = this.deps.clock.now()
    const hostEpoch = this.offered.hostEpoch
    this.deps.transactions.inTransaction(() => this.deps.reports.markShown(hostEpoch, at))
    this.step({ t: 'ui-attached', at })
  }

  retryRecovery(hostEpoch: string, requestId: string): Promise<RetryResult> {
    if (this.retrying !== null && this.offered?.hostEpoch === hostEpoch) return this.retrying
    const pending = this.unsettled(hostEpoch)
    if (pending === null) return Promise.resolve({ ok: false, error: 'no-report' })
    this.shown()
    const plan = planRetry(pending.unrecovered, (id) => this.processOf(id))
    if (plan.settleAsIs.length > 0) {
      this.deps.transactions.inTransaction(() => {
        for (const dwarfId of plan.settleAsIs) {
          this.deps.reports.settleItem(hostEpoch, dwarfId, 'resumed')
        }
      })
    }
    this.step({ t: 'retry' })
    this.publish({
      type: 'RecoveryRetried',
      payload: { hostEpoch: hostEpoch as HostEpoch, requestId, dwarfIds: plan.retry }
    })
    const run = this.retryAll(hostEpoch, plan.retry).finally(() => {
      this.retrying = null
    })
    this.retrying = run
    return run
  }

  dismissRecovery(hostEpoch: string, requestId: string): Result<void, 'no-report'> {
    void requestId // the dispatcher's dedupe key (14 §1.6), not the module's
    const pending = this.unsettled(hostEpoch)
    if (pending === null) return { ok: false, error: 'no-report' }
    if (this.phase.state === 'retrying') return { ok: true, value: undefined }
    this.shown()
    const listed = pending.unrecovered.map((item) => item.dwarfId as DwarfId)
    const { walkOut } = planDismiss(pending.unrecovered, (id) => this.processOf(id))
    const at = this.deps.clock.now()
    this.deps.transactions.inTransaction(() => {
      for (const dwarfId of listed) this.deps.reports.settleItem(hostEpoch, dwarfId, 'dismissed')
      for (const dwarfId of walkOut) this.endRecord(dwarfId, at)
    })
    this.step({ t: 'dismiss', at })
    this.publish({
      type: 'RecoveryDismissed',
      payload: { hostEpoch: hostEpoch as HostEpoch, dwarfIds: listed }
    })
    return { ok: true, value: undefined }
  }

  private async retryAll(hostEpoch: string, dwarfIds: readonly DwarfId[]): Promise<RetryResult> {
    await Promise.all(
      dwarfIds.map(
        (dwarfId, index) =>
          new Promise<void>((resolve) => {
            this.deps.scheduler.after(index * RESUME_SPACING_MS, () => {
              void this.retryOne(hostEpoch, dwarfId)
                .catch((error: unknown) => {
                  this.logFailure(dwarfId, error)
                  this.failed(hostEpoch, dwarfId)
                })
                .finally(resolve)
            })
          })
      )
    )
    this.step({ t: 'retries-settled', at: this.deps.clock.now() })
    const view = this.view()
    return view === null ? { ok: false, error: 'no-report' } : { ok: true, value: view }
  }

  /** S4.20: the SAME provider session resumed again, never a new one, never a prompt re-sent. */
  private async retryOne(hostEpoch: string, dwarfId: DwarfId): Promise<void> {
    const record = this.deps.records.live().find((r) => r.dwarfId === dwarfId)
    const resumed = record === undefined ? null : await this.deps.resumer.resume(record)
    if (resumed?.ok !== true) {
      this.failed(hostEpoch, dwarfId)
      return
    }
    // S2.11: silent; the item leaves the grouped message.
    this.deps.transactions.inTransaction(() =>
      this.deps.reports.settleItem(hostEpoch, dwarfId, 'resumed')
    )
    this.outcomes.push({ dwarfId, outcome: 'resumed' })
  }

  /** S4.21: the item settles `failed`, the record ends, and the dwarf walks out by its route. */
  private failed(hostEpoch: string, dwarfId: DwarfId): void {
    if (this.outcomes.some((o) => o.dwarfId === dwarfId)) return
    const at = this.deps.clock.now()
    this.deps.transactions.inTransaction(() => {
      this.deps.reports.settleItem(hostEpoch, dwarfId, 'failed')
      this.endRecord(dwarfId, at)
    })
    this.outcomes.push({ dwarfId, outcome: 'failed' })
    this.publish({
      type: 'RecoveryRetryFailed',
      payload: { hostEpoch: hostEpoch as HostEpoch, dwarfId }
    })
  }

  /** The dwarf's live record ends with no resume intent (ADR-015 item 8): no later boot resumes it. */
  private endRecord(dwarfId: DwarfId, at: number): void {
    const record = this.deps.records.live().find((r) => r.dwarfId === dwarfId)
    if (record !== undefined) this.deps.records.put({ ...record, endedAt: at, resumeIntent: false })
  }

  /** The offered report of `hostEpoch` while it still has an unsettled item; null otherwise. */
  private unsettled(hostEpoch: string): HostRecoveryReport | null {
    if (this.offered?.hostEpoch !== hostEpoch || !OFFERED.has(this.phase.state)) return null
    const pending = this.deps.reports.pending()
    return pending?.hostEpoch === hostEpoch ? pending : null
  }

  private processOf(dwarfId: DwarfId): 'running' | 'unrecovered' | 'closed' | null {
    return this.deps.crew.get(dwarfId)?.processState ?? null
  }

  /** One machine-16 transition; a transition 07 does not list changes nothing. */
  private step(event: RecoveryReportEvent): boolean {
    const next = stepRecoveryReport(this.phase, event)
    if (!next.ok) return false
    this.phase = next.value.phase
    return true
  }

  private publish(
    event:
      | Pick<Extract<LaunchingEvent, { type: 'RecoveryRetried' }>, 'type' | 'payload'>
      | Pick<Extract<LaunchingEvent, { type: 'RecoveryRetryFailed' }>, 'type' | 'payload'>
      | Pick<Extract<LaunchingEvent, { type: 'RecoveryDismissed' }>, 'type' | 'payload'>
  ): void {
    this.deps.bus.publish({
      ...event,
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch
    } as LaunchingEvent)
  }

  private logFailure(dwarfId: DwarfId, error: unknown): void {
    this.deps.log.record({
      level: 'error',
      event: 'recovery.retry',
      subsystem: 'launching',
      dwarfId,
      errCode: error instanceof Error ? error.name : 'UNKNOWN'
    })
  }
}
