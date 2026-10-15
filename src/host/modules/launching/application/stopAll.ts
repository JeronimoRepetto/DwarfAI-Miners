// `LaunchCommands.stopAll` (05 §3.5; 16 §4.5 row `stopAll`; ADR-002 D7 step 3; ADR-014 item 9;
// ADR-015 item 8; 07 S12.11, S12.21, S4.05, S4.07, S4.23; 11 F13; 13 FM-143, FM-144; 06 INV-120,
// INV-121): what `host.shutdown {mode:'stop-all'}` asks through the kernel StopAllPort. It ends every
// owned session — a live `LaunchRecord` — through crew's `endOwned` along the launching → crew edge
// (05 §1.3; AR-13 applied), and answers `StopAllOutcome` once every end settled. The transport
// decides from `failed` whether the Host exits (S12.12) or keeps running (S12.21).
//
// 1. A launch still in flight settles first (FM-144 (A)): `stopAll` waits until the launching drain
//    gate (`createLaunchDrainGate`, launchDrain.ts) reports no in-flight launch, re-reading it on
//    each settled launch (`DwarfLaunched`, `LaunchFailed`). It is bounded by the launches' own
//    timeouts (handshake, early window): every launch settles as one of those events.
// 2. One transaction marks every live record `stopped_by_person` and clears its resume intent
//    (ADR-015 item 8): a Host crash during the ends resumes nothing at the next boot (S4.23).
//    Observed sessions have no record and are never named (INV-120).
// 3. `crew.endOwned(dwarfIds, requestId)`: parallel identity-checked ends, each dwarf departs
//    `stopped` or stays as failed; no per-dwarf toast (ADR-014 item 9).
// 4. A failed dwarf's session is alive and the Host keeps running (INV-121): its record gets back
//    the `stopped_by_person` and resume intent it had (S4.07; 12 UC-023 "resume intent kept"), and
//    one `StopAllIncomplete{requestId, ended, failed}` is published, whose route is the one danger
//    toast (08 §2.5; wiring/routes/launching.ts). Nothing is published when every end succeeded.
//
// A launch accepted while the ends run (the Host is `ending-all`, S12.11) is not left alive: once
// the ends settled, `stopAll` waits for the launches in flight again and ends every live record it
// has not handled yet, in rounds, until none is left; only then does it answer, so the transport
// never exits with an owned session it did not try to end (US-RES-002.AC09; FM-144 (A) extended to
// a launch accepted during the ends). The wait is bounded only by the launches' own timeouts
// (handshake, early window, ADR-020): every launch settles as `DwarfLaunched` or `LaunchFailed`.
//
// One stop-all at a time (S12.11): a request while one runs, with the same `requestId` (the
// idempotency key, 16 §4.5) or another, joins it and gets its outcome, so no dwarf is ended twice
// and a failed record is restored once. A repeat after it settled is the transport's
// de-duplication (ADR-003 item 6); a new request runs again (S12.21: the person may press Stop
// everything and quit again).
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { DrainGate } from '../../../kernel/ports/drainGate'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { StopAllOutcome } from '../../../kernel/ports/stopAll'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { CrewOwnedEnds } from '../../crew'
import type { LaunchRecord, LaunchRecordStore } from '../ports/launchRecordStore'
import type { StopAllIncomplete } from './events'

/** Where `stopAll` hears that a launch settled (`DwarfLaunched`, `LaunchFailed`). */
export interface LaunchSettlements {
  /** Calls `listener` after each launch settled; returns the unsubscribe. */
  onSettled(listener: () => void): () => void
}

export interface StopAllDeps {
  records: Pick<LaunchRecordStore, 'live' | 'put'>
  transactions: TransactionRunner
  /** The launching drain gate: its `in-flight` blockers are the launches not settled yet. */
  inFlight: DrainGate
  settlements: LaunchSettlements
  /** Crew's `endOwned`, along the launching → crew edge (05 §1.3). */
  crew: Pick<CrewOwnedEnds, 'endOwned'>
  bus: Pick<DomainEventBus<StopAllIncomplete>, 'publish'>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
}

export class StopAll {
  /** The one stop-all in flight (S12.11: the Host is `ending-all` once), whatever its requestId. */
  private running: Promise<StopAllOutcome> | null = null

  constructor(private readonly deps: StopAllDeps) {}

  stopAll(requestId: string): Promise<StopAllOutcome> {
    if (this.running !== null) return this.running
    const run = this.run(requestId).finally(() => {
      this.running = null
    })
    this.running = run
    return run
  }

  private async run(requestId: string): Promise<StopAllOutcome> {
    const before: LaunchRecord[] = []
    const ended: DwarfId[] = []
    const failed: DwarfId[] = []
    // Rounds: a launch accepted while the ends run settles and is ended in the next round, so the
    // Host never answers (and never exits) with an owned session it did not try to end (FM-144).
    for (;;) {
      await this.launchesSettled()
      const handled = new Set(before.map((record) => record.dwarfId))
      const round = this.markStopped(handled)
      if (round.length === 0) break
      before.push(...round)
      const outcome = await this.deps.crew.endOwned(
        round.map((record) => record.dwarfId),
        requestId
      )
      ended.push(...outcome.ended)
      failed.push(...outcome.failed)
    }
    if (failed.length === 0) return { ended, failed }
    this.restore(before, failed)
    this.publish({ requestId, ended: [...ended], failed: [...failed] })
    return { ended, failed }
  }

  /** Resolves once the drain gate reports no launch in flight (FM-144 (A)). */
  private launchesSettled(): Promise<void> {
    const { inFlight, settlements } = this.deps
    const settled = (): boolean => !inFlight.blockers().some((b) => b.kind === 'in-flight')
    if (settled()) return Promise.resolve()
    return new Promise((resolve) => {
      const stop = settlements.onSettled(() => {
        if (!settled()) return
        stop()
        resolve()
      })
    })
  }

  /**
   * Every live record not handled yet stopped by the person, no resume intent (ADR-015 item 8);
   * those rows as they were.
   */
  private markStopped(handled: ReadonlySet<DwarfId>): LaunchRecord[] {
    const { records, transactions } = this.deps
    return transactions.inTransaction(() => {
      const live = records.live().filter((record) => !handled.has(record.dwarfId))
      for (const record of live) {
        records.put({ ...record, stoppedByPerson: true, resumeIntent: false })
      }
      return live
    })
  }

  /** S4.07: a session that could not be ended gets back what it had. */
  private restore(before: readonly LaunchRecord[], failed: readonly DwarfId[]): void {
    const { records, transactions } = this.deps
    const kept = new Set(failed)
    transactions.inTransaction(() => {
      for (const record of records.live()) {
        const was = before.find((r) => r.launchId === record.launchId)
        if (was === undefined || !kept.has(record.dwarfId)) continue
        records.put({
          ...record,
          stoppedByPerson: was.stoppedByPerson,
          resumeIntent: was.resumeIntent
        })
      }
    })
  }

  private publish(payload: StopAllIncomplete['payload']): void {
    const { bus, ids, clock, hostEpoch } = this.deps
    bus.publish({
      type: 'StopAllIncomplete',
      v: 1,
      id: ids.uuidv7() as EventId,
      at: clock.now(),
      hostEpoch,
      payload
    })
  }
}
