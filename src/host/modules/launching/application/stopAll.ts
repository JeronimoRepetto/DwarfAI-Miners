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
// `requestId` is the idempotency key (16 §4.5): a repeat while the first is in flight joins it. A
// repeat after it settled is the transport's de-duplication (ADR-003 item 6); a new request runs
// again (S12.21: the person may press Stop everything and quit again).
import type { DomainEvent } from '../../../kernel/domain/domainEvent'
import type { DwarfId, EventId, HostEpoch } from '../../../kernel/domain/values'
import type { Clock } from '../../../kernel/ports/clock'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { DrainGate } from '../../../kernel/ports/drainGate'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { StopAllOutcome } from '../../../kernel/ports/stopAll'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { CrewOwnedEnds } from '../../crew'
import type { LaunchRecord, LaunchRecordStore } from '../ports/launchRecordStore'

/** 08 §0 `StopAllIncomplete` (launching): published only with `failed ≠ ∅` (16 §4.5). */
export type StopAllIncomplete = DomainEvent<
  'StopAllIncomplete',
  { requestId: string; ended: DwarfId[]; failed: DwarfId[] }
>

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
  /** The stop-alls in flight, by `requestId`. */
  private readonly running = new Map<string, Promise<StopAllOutcome>>()

  constructor(private readonly deps: StopAllDeps) {}

  stopAll(requestId: string): Promise<StopAllOutcome> {
    const joined = this.running.get(requestId)
    if (joined !== undefined) return joined
    const run = this.run(requestId).finally(() => this.running.delete(requestId))
    this.running.set(requestId, run)
    return run
  }

  private async run(requestId: string): Promise<StopAllOutcome> {
    await this.launchesSettled()
    const before = this.markStopped()
    const outcome = await this.deps.crew.endOwned(
      before.map((record) => record.dwarfId),
      requestId
    )
    if (outcome.failed.length === 0) return outcome
    this.restore(before, outcome.failed)
    this.publish({ requestId, ended: [...outcome.ended], failed: [...outcome.failed] })
    return outcome
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

  /** Every live record stopped by the person, no resume intent (ADR-015 item 8); the rows before. */
  private markStopped(): LaunchRecord[] {
    const { records, transactions } = this.deps
    return transactions.inTransaction(() => {
      const live = records.live()
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
