// The crediting transaction shared by `creditUsage` and `creditSealedUnits` (09 §5.3; 16 §4.10),
// and the events it owes once that transaction commits (16 §2.3).
//
// - A credit runs inside the caller's transaction when one is open (the observation batch's,
//   16 §4.3 `ObservedBatchSink`: the batch's facts, ledger rows and cursor advance commit together,
//   09 §5.2 step 5), and in its own otherwise. Its events are published only after a commit: at once
//   when the ledger opened the transaction itself, and when the caller says its transaction
//   committed (`publishCommitted`) when it joined one; a rolled-back caller drops them
//   (`discardUncommitted`), so a credit that never committed is never announced. Package gap: 16
//   §4.3 says the ledger's events of a batch are published after the batch commit but names no
//   hand-off; this pair is it, called by the bridge that runs the batch (later: ISSUE-096).
// - The credit itself is `decideCredit` over the facts read in that transaction, then one
//   `LedgerRepository.credit` with the mine's tier as material and `kind = 'live'`.
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DomainEventBus } from '../../../kernel/ports/domainEventBus'
import type { Clock } from '../../../kernel/ports/clock'
import type { IdGenerator } from '../../../kernel/ports/idGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { EventId, HostEpoch } from '../../../kernel/domain/values'
import { decideCredit, type UnitKey, type UsagePath } from '../domain/credit'
import type { LedgerEvent } from '../domain/events'
import type { LedgerStore } from '../ports/ledgerRepository'

export interface CreditingDeps {
  /** One store per usage path; each records the observations of its path (`usage_observations.path`). */
  stores: Readonly<Record<UsagePath, LedgerStore>>
  transactions: TransactionRunner
  /** The same transaction runner's probe: whether a caller's transaction is open. */
  scope: TransactionScope
  bus: Pick<DomainEventBus<LedgerEvent>, 'publish'>
  clock: Clock
  ids: IdGenerator
  hostEpoch: HostEpoch
}

export class Crediting {
  private pending: LedgerEvent[] = []

  constructor(readonly deps: CreditingDeps) {}

  /** Any store: the reads and the credit are path-independent. */
  get store(): LedgerStore {
    return this.deps.stores.transcript
  }

  /** Runs `work` in the caller's transaction or its own, then publishes once that one committed. */
  run<T>(work: () => T): T {
    if (this.deps.scope.isInTransaction()) return work()
    let result: T
    try {
      result = this.deps.transactions.inTransaction(work)
    } catch (error) {
      this.discardUncommitted()
      throw error
    }
    this.publishCommitted()
    return result
  }

  /** 09 §5.3 steps 2–3 for one stored unit; queues its events when it is credited. */
  creditIfCreditable(unitKey: UnitKey): boolean {
    const { store } = this
    const unit = store.unit(unitKey)
    if (unit === null) return false
    const subject = store.subjectOf(unit.dwarfId)
    const authoritative = subject === null ? undefined : unit.best[subject.usagePath]
    const decision = decideCredit({
      unit,
      installMomentAt: store.installMoment(),
      resetInProgress: store.resetInProgress(),
      tier: store.confirmedTier(unit.mineId),
      authoritativeTokens: authoritative?.tokens ?? null
    })
    if (!decision.creditable) return false
    const { material, tokens, units } = decision
    if (store.credit(unitKey, unit.mineId, material, tokens, units, 'live') === 'duplicate') {
      return false
    }
    const ledgerEntryId = store.entryOf(unitKey)
    if (ledgerEntryId === null) {
      throw new HostInvariantError('a credited unit has no ledger entry (09 §5.3 step 3)')
    }
    const mineId = unit.mineId
    this.queue({
      type: 'MaterialCredited',
      payload: { mineId, material, tokens, units, unitKey, kind: 'live' }
    })
    this.queue({
      type: 'LedgerTotalsChanged',
      payload: { mineId, ledgerEntryId, totals: store.totals(mineId) }
    })
    return true
  }

  publishCommitted(): void {
    const events = this.pending
    this.pending = []
    for (const event of events) this.deps.bus.publish(event)
  }

  discardUncommitted(): void {
    this.pending = []
  }

  private queue(event: Omit<LedgerEvent, 'v' | 'id' | 'at' | 'hostEpoch'>): void {
    this.pending.push({
      ...event,
      v: 1,
      id: this.deps.ids.uuidv7() as EventId,
      at: this.deps.clock.now(),
      hostEpoch: this.deps.hostEpoch
    } as LedgerEvent)
  }
}
