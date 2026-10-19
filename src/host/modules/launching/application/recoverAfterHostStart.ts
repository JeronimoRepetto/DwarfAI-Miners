// `LaunchCommands.recoverAfterHostStart` (05 §3.5; 16 §4.5, §8.2 step 5; ADR-015 items 3–5, 7;
// 07 machine 4A S4.09…S4.24, 5B S5.22/S5.23, 7 S7.13…S7.16, 16 S16.01…S16.03; 11 F7; UC-025): the
// silent recovery of the owned sessions a stopped Host left behind.
//
// Classification (before `ready`, boot step 5; `classified` resolves when it is done):
// - It loads the live launch records, the live process records and the in-flight launches, probes
//   every recorded process identity (16 §3 `ProcessControl.probe`) and runs the pure
//   `reconcileOnBoot` table (domain/reconcileOnBoot.ts) with how the previous epoch ended
//   (`decidePreviousEpochEnd`, read at boot step 2).
// - In one transaction: every record the table ends (S4.23, S4.24) gets `endedAt` and loses its
//   resume intent (ADR-015 item 8), every in-flight launch settles `lost` or `succeeded` (S5.22,
//   S5.23), and the report is saved with the items known now (`no-resume`, `turn-lost`; INV-58).
//   After the commit, a dwarf ended while the app was closed leaves with `closed-elsewhere`, never
//   in a snapshot's crew and with no toast (S2.18), a stop-all dwarf still present leaves `stopped`,
//   and every `no-resume` dwarf is marked unrecovered and stays present (S2.10; INV-26).
// - Every dwarf the recovery resumes or lists is covered (`coverage`), so the exit of its old
//   process raises no `LaunchedSessionCrashed` (PO #62 suppressed, INV-58; sessionExited.ts).
//
// Resumes (after classification; `settled` resolves when every initial one settled):
// - One start per 500 ms on the `Scheduler` (ADR-015 item 5), in table order.
// - A survivor is ended first through crew's `SessionTerminator` with `why: 'host-recovery'`
//   (S4.13; INV-56): never resumed while the old process runs. A failed end lists `end-failed`
//   (S4.15).
// - A live server-kind session with `adopt` is re-adopted (S4.10, S4.11); `adopt` answering null or
//   failing falls back to the resume (S4.12).
// - The resume asks the session's own driver (the registry's driver of the record's transport) by
//   the stored provider session id (S4.16). A resumed session is bound to the same dwarf
//   (`SessionBindings.bind`, ADR-015 item 7); a new provider session id rebinds the dwarf (crew
//   `rebind`, S4.18, `previousProviderSessionId`), so its id and custom name stay. Its record now
//   names the new session, its new process and this epoch, so a later crash recovers it again. A
//   failed resume lists `stale-ref` or `resume-error` (S4.19; `DriverResumeError.reason`).
// - The messages left `sending` are reconciled beside the resumes (`deliveries`, 10 s evidence
//   window, S7.13…S7.16); one marked ✕ `host-interrupted` is listed on its dwarf's item, a dwarf
//   with no item then listed `turn-lost` (its turn was lost with the Host).
// - Once every initial resume settled, the report is saved again with every item and `resumed`,
//   and `HostRecovered` is published only when `unrecovered` is not empty (S16.02, S16.03); the
//   report's display phase (recoveryActions.ts `RecoveryActions`) is told first, so the frame and
//   the snapshot `recovery` section carry it from then on.
// - Another Host crash before the previous report settled (S16.09): the previous epoch's pending
//   report is read before this boot saves, its unsettled items' ✕ message ids are carried onto the
//   items this boot lists again, and this boot's save supersedes it (`RecoveryReportStore.save`).
//   A carried dwarf's record is still live, so this boot classifies it again; its new reason wins.
// - The resume itself is `SessionResumer`'s (sessionResumer.ts), the same one Retry uses.
//
// Nothing here throws into the Host after classification: a failed step is logged with ids only
// (ADR-026) and its dwarf listed.
import type { PreviousEpochEnd } from '../../../kernel/domain/bootIdentity'
import type { EndOutcome, ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId, EventId, HostEpoch, MessageId } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DiagnosticsLog } from '../../../kernel/ports/diagnosticsLog'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { ProcessControl } from '../../../kernel/ports/processControl'
import type { Scheduler } from '../../../kernel/ports/scheduler'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { CrewCommands, CrewQueries } from '../../crew'
import type { SupplierCatalogueQueries } from '../../suppliers'
import { applyLaunchEvent } from '../domain/launch'
import {
  reconcileOnBoot,
  type AfterSurvivor,
  type OwnedRecordFacts,
  type RecordTransition
} from '../domain/reconcileOnBoot'
import type { HostRecoveryReport, UnrecoveredReason } from '../domain/recoveryReport'
import type { LaunchRecord, LaunchRecordStore } from '../ports/launchRecordStore'
import type { LaunchStore } from '../ports/launchStore'
import type { ProcessRecordStore } from '../ports/processRecordStore'
import type { RecoveryReportStore } from '../ports/recoveryReportStore'
import type { LaunchingEvent } from './events'
import type { RecoveryCoverage } from './sessionExited'
import type { SessionResumer } from './sessionResumer'

/** ADR-015 item 5 (herdr `startup_per_agent_delay_ms`): one resume start per 500 ms. */
export const RESUME_SPACING_MS = 500

/** The dwarfs the current Host recovery covers, filled by the recovery pass. */
export class HostRecoveryCoverage implements RecoveryCoverage {
  private readonly dwarfs = new Set<DwarfId>()

  add(dwarfId: DwarfId): void {
    this.dwarfs.add(dwarfId)
  }

  covers(dwarfId: DwarfId): boolean {
    return this.dwarfs.has(dwarfId)
  }
}

/** What the recovery pass needs from host/wiring, bound once crew and conversation exist. */
export interface LaunchingRecoveryDeps {
  /** The report store over the Host database (`SqliteRecoveryReportStore`). */
  reports: RecoveryReportStore
  /** How the previous epoch ended (boot step 2, `HostDatabase.previousEpochEnd`); null: none. */
  previousEpochEnd(): PreviousEpochEnd | null
  /** The probe of a recorded process identity (16 §3; INV-51). */
  processControl: Pick<ProcessControl, 'probe'>
  /** Calls along the launching → crew edge (05 §1.3; 16 §4.5 AR-13). */
  crew: Pick<CrewCommands, 'markUnrecovered' | 'rebind' | 'sessionClosed'> &
    Pick<CrewQueries, 'get'>
  /** Crew's `SessionTerminator.end(dwarfId, 'host-recovery')` (S4.13; ADR-014 item 1). */
  endSurvivor(dwarfId: DwarfId): Promise<EndOutcome>
  /** The effective capabilities of a provider (suppliers `catalogue.capabilities`, 15 §2). */
  catalogue: Pick<SupplierCatalogueQueries, 'capabilities'>
  /** The boot reconcile of the deliveries left `sending` (S7.13…S7.16): the ✕ ids per dwarf. */
  deliveries: {
    reconcileSending(
      dwarfIds: readonly DwarfId[]
    ): Promise<ReadonlyMap<DwarfId, readonly MessageId[]>>
  }
}

export interface RecoverAfterHostStartDeps extends LaunchingRecoveryDeps {
  records: LaunchRecordStore
  processes: ProcessRecordStore
  launches: LaunchStore
  transactions: TransactionRunner
  coverage: HostRecoveryCoverage
  /** The resume of one owned session (sessionResumer.ts), shared with Retry. */
  resumer: SessionResumer
  /** The report's display phase (07 machine 16), told before `HostRecovered` is published. */
  display: { collecting(): void; classified(report: HostRecoveryReport): void }
  bus: Pick<DomainEventBus<LaunchingEvent>, 'publish'>
  clock: Clock
  scheduler: Scheduler
  ids: IdGenerator
  hostEpoch: HostEpoch
  log: DiagnosticsLog
}

/** One recovery pass: `classified` before `ready`, `settled` once every initial resume settled. */
export interface RecoveryRun {
  classified: Promise<void>
  settled: Promise<HostRecoveryReport>
}

type Item = HostRecoveryReport['unrecovered'][number]

/** A step of the resume queue: what runs for one dwarf after classification. */
type Job = Extract<RecordTransition, { t: 'adopt' | 'end-survivor' | 'resume' }>

const CRASHED: PreviousEpochEnd = { kind: 'crashed', rule: 'none' }

export class RecoverAfterHostStart {
  private readonly items = new Map<DwarfId, Item>()
  private readonly resumed: DwarfId[] = []
  /** S16.09: the unsettled items of a previous epoch's report this boot replaces. */
  private carried: HostRecoveryReport['unrecovered'] = []
  private run: RecoveryRun | null = null
  /** `HostRecoveryReport.at`: when the boot classified (10 §`host_recovery_reports`). */
  private classifiedAt: number | null = null

  constructor(private readonly deps: RecoverAfterHostStartDeps) {}

  /** Runs the pass once per Host boot; a second call answers the same run (`hostEpoch`). */
  start(): RecoveryRun {
    if (this.run !== null) return this.run
    this.deps.display.collecting()
    const jobs = this.classify()
    this.run = {
      classified: jobs.then(() => undefined),
      settled: jobs.then((queued) => this.resumeAll(queued))
    }
    return this.run
  }

  private async classify(): Promise<Job[]> {
    const { records, processes, launches } = this.deps
    const live = records.live()
    const inFlight = launches.inFlight()
    const previous = this.deps.previousEpochEnd()
    const earlier = this.deps.reports.pending()
    if (earlier !== null && earlier.hostEpoch !== this.deps.hostEpoch) {
      this.carried = earlier.unrecovered
    }
    if (live.length === 0 && inFlight.length === 0) {
      // Nothing to classify, but an earlier report is still replaced by this boot's (S16.09).
      if (this.carried.length > 0) {
        this.classifiedAt = this.deps.clock.now()
        this.deps.transactions.inTransaction(() => this.deps.reports.save(this.report()))
      }
      return []
    }
    const boot = previous ?? CRASHED
    const purposes = processes.live()
    const probes = new Map<number, Awaited<ReturnType<ProcessControl['probe']>>>()
    for (const record of live) {
      if (record.process === undefined || probes.has(record.process.pid)) continue
      probes.set(record.process.pid, await this.deps.resumer.probe(record.process.pid))
    }
    const facts = live.map((record): OwnedRecordFacts => {
      const driver = this.deps.resumer.driverOf(record)
      const capabilities = this.capabilitiesOf(record)
      const process = record.process
      const serverKind =
        process !== undefined &&
        purposes.some(
          (p) =>
            p.purpose === 'session-server' &&
            p.identity.pid === process.pid &&
            p.identity.processStartTimeMs === process.processStartTimeMs
        )
      return {
        dwarfId: record.dwarfId,
        ...(process === undefined ? {} : { process }),
        serverKind,
        resumeIntent: record.resumeIntent,
        canResume: driver?.resume !== undefined && capabilities.resume !== 'none',
        canAdopt: driver?.adopt !== undefined && capabilities.adopt,
        turnActive: this.deps.crew.get(record.dwarfId)?.status === 'working'
      }
    })
    const evidence = new Map(live.map((record) => [record.launchId, record.dwarfId]))
    const result = reconcileOnBoot({
      boot,
      records: facts,
      probes,
      inFlight: inFlight.map((launch) => ({
        launchId: launch.id,
        evidence: evidence.get(launch.id) ?? null
      }))
    })

    const byDwarf = new Map(live.map((record) => [record.dwarfId, record]))
    const now = this.deps.clock.now()
    this.classifiedAt = now
    const ended: Array<{ dwarfId: DwarfId; cause: 'closed-elsewhere' | 'stopped' }> = []
    const unrecovered: DwarfId[] = []
    const jobs: Job[] = []
    for (const transition of result.records) {
      const { dwarfId } = transition
      switch (transition.t) {
        case 'ended-while-closed':
          ended.push({ dwarfId, cause: 'closed-elsewhere' })
          break
        case 'not-resumed':
          ended.push({ dwarfId, cause: 'stopped' })
          break
        case 'unrecovered':
          this.list(dwarfId, transition.reason)
          unrecovered.push(dwarfId)
          this.deps.coverage.add(dwarfId)
          break
        default:
          if (transition.turnLost) this.list(dwarfId, 'turn-lost')
          this.deps.coverage.add(dwarfId)
          jobs.push(transition)
      }
    }
    this.deps.transactions.inTransaction(() => {
      for (const { dwarfId } of ended) {
        const record = byDwarf.get(dwarfId)
        if (record !== undefined) records.put({ ...record, endedAt: now, resumeIntent: false })
      }
      for (const launch of inFlight) {
        const outcome = result.launches.find((l) => l.launchId === launch.id)
        const step = applyLaunchEvent(launch, {
          t: 'boot-reconciled',
          evidence: outcome?.t === 'succeeded' ? outcome.dwarfId : null
        })
        if (step.ok) launches.put(step.value.launch)
      }
      if (live.length > 0) this.deps.reports.save(this.report())
    })
    for (const { dwarfId, cause } of ended) this.deps.crew.sessionClosed(dwarfId, cause)
    for (const dwarfId of unrecovered) this.deps.crew.markUnrecovered(dwarfId)
    return jobs
  }

  private async resumeAll(jobs: readonly Job[]): Promise<HostRecoveryReport> {
    const records = new Map(this.deps.records.live().map((r) => [r.dwarfId, r]))
    const deliveries = this.deps.deliveries
      .reconcileSending([...records.keys()])
      .catch((error: unknown) => {
        this.logFailure('recovery.deliveries', undefined, error)
        return new Map<DwarfId, readonly MessageId[]>()
      })
    const runs = jobs.map(
      (job, index) =>
        new Promise<void>((resolve) => {
          this.deps.scheduler.after(index * RESUME_SPACING_MS, () => {
            const record = records.get(job.dwarfId)
            const work = record === undefined ? Promise.resolve() : this.runJob(job, record)
            void work
              .catch((error: unknown) => {
                this.logFailure('recovery.resume', job.dwarfId, error)
                this.unrecovered(job.dwarfId, 'resume-error')
              })
              .finally(resolve)
          })
        })
    )
    await Promise.all(runs)
    for (const [dwarfId, messageIds] of await deliveries) {
      if (messageIds.length === 0) continue
      const item = this.items.get(dwarfId) ?? { dwarfId, reason: 'turn-lost' as const }
      this.items.set(dwarfId, { ...item, messageIds: [...(item.messageIds ?? []), ...messageIds] })
    }
    this.carryOver()
    const report = this.report()
    if (records.size > 0 || report.unrecovered.length > 0) {
      this.deps.transactions.inTransaction(() => this.deps.reports.save(report))
    }
    this.deps.display.classified(report)
    if (report.unrecovered.length > 0) {
      this.deps.bus.publish({
        type: 'HostRecovered',
        v: 1,
        id: this.deps.ids.uuidv7() as EventId,
        at: this.deps.clock.now(),
        hostEpoch: this.deps.hostEpoch,
        payload: { report }
      })
    }
    return report
  }

  private async runJob(job: Job, record: LaunchRecord): Promise<void> {
    const driver = this.deps.resumer.driverOf(record)
    if (job.t === 'end-survivor') {
      const outcome = await this.deps.endSurvivor(job.dwarfId)
      if (outcome.kind !== 'ended') {
        this.unrecovered(job.dwarfId, 'end-failed')
        return
      }
      this.processEnded(job.process)
      await this.afterSurvivor(job.then, record)
      return
    }
    if (job.t === 'adopt') {
      const adopted = await driver?.adopt?.(record.ref).catch(() => null)
      if (adopted !== undefined && adopted !== null) {
        this.deps.resumer.owned(record, adopted)
        this.resumed.push(record.dwarfId)
        return
      }
      await this.afterSurvivor(job.then, record)
      return
    }
    await this.resume(record)
  }

  private async afterSurvivor(then: AfterSurvivor, record: LaunchRecord): Promise<void> {
    if (then === 'no-resume') this.unrecovered(record.dwarfId, 'no-resume')
    else await this.resume(record)
  }

  private async resume(record: LaunchRecord): Promise<void> {
    const resumed = await this.deps.resumer.resume(record)
    if (resumed.ok) this.resumed.push(record.dwarfId)
    else this.unrecovered(record.dwarfId, resumed.error)
  }

  private processEnded(process: ProcessIdentity): void {
    const at = this.deps.clock.now()
    this.deps.transactions.inTransaction(() => this.deps.processes.ended(process.pid, at))
  }

  private unrecovered(dwarfId: DwarfId, reason: UnrecoveredReason): void {
    this.list(dwarfId, reason)
    this.deps.crew.markUnrecovered(dwarfId)
  }

  /** One item per dwarf (the report's key, 10 §`host_recovery_items`): its first reason stays. */
  private list(dwarfId: DwarfId, reason: UnrecoveredReason): void {
    if (!this.items.has(dwarfId)) this.items.set(dwarfId, { dwarfId, reason })
  }

  /** S16.09: a carried item's ✕ message ids join the item this boot lists for the same dwarf. */
  private carryOver(): void {
    for (const earlier of this.carried) {
      const item = this.items.get(earlier.dwarfId as DwarfId)
      if (item === undefined || earlier.messageIds === undefined) continue
      const messageIds = [...new Set([...earlier.messageIds, ...(item.messageIds ?? [])])]
      this.items.set(earlier.dwarfId as DwarfId, { ...item, messageIds })
    }
  }

  private report(): HostRecoveryReport {
    return {
      hostEpoch: this.deps.hostEpoch,
      at: this.classifiedAt ?? this.deps.clock.now(),
      resumed: [...this.resumed],
      unrecovered: [...this.items.values()].map((item) => ({ ...item }))
    }
  }

  private capabilitiesOf(record: LaunchRecord): { resume: string; adopt: boolean } {
    try {
      return this.deps.catalogue.capabilities(record.ref.providerId)
    } catch {
      return { resume: 'none', adopt: false }
    }
  }

  private logFailure(event: string, dwarfId: DwarfId | undefined, error: unknown): void {
    this.deps.log.record({
      level: 'error',
      event,
      subsystem: 'launching',
      ...(dwarfId === undefined ? {} : { dwarfId }),
      errCode: error instanceof Error ? error.name : 'UNKNOWN'
    })
  }
}
