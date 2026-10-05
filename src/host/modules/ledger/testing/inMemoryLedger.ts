// The ledger's in-memory doubles assembled for L2 and L3 tests (17 §1.2, §1.3): one shared
// `InMemoryLedgerWorld`, a transaction double that restores it on rollback (as `BEGIN IMMEDIATE …
// ROLLBACK` does), and seeding helpers for the facts other modules own (`dwarfs`, `mines`,
// `install_moment`, `reset_journal`). Never imported by production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { UsagePath } from '../domain/credit'
import type { LedgerEvent } from '../domain/events'
import type { LiveMaterial } from '../domain/materials'
import { InMemoryLedgerRepository, InMemoryLedgerWorld } from './InMemoryLedgerRepository'
import { createLedger } from '../index'
import type { LedgerStore } from '../ports/ledgerRepository'
import type { LedgerRepositorySubject, StoredEntry } from './ledgerRepository.contract'

/** A transaction over the world: joins an open one, restores the world when `work` throws. */
export class InMemoryLedgerTransactions implements TransactionRunner, TransactionScope {
  private open = false
  /** Transactions committed so far (a joined call is not one). */
  committed = 0

  constructor(private readonly world: InMemoryLedgerWorld) {}

  isInTransaction(): boolean {
    return this.open
  }

  inTransaction<T>(work: () => T): T {
    if (this.open) return work()
    const snapshot = this.world.snapshot()
    this.open = true
    try {
      const result = work()
      if (result instanceof Promise) {
        throw new HostInvariantError('inTransaction work must be synchronous (16 §2.2)')
      }
      this.committed += 1
      return result
    } catch (error) {
      this.world.restore(snapshot)
      throw error
    } finally {
      this.open = false
    }
  }
}

/** The in-memory ledger storage with its seeding helpers. */
export function inMemoryLedgerStorage(clock: FakeClock = new FakeClock(0)) {
  const world = new InMemoryLedgerWorld()
  const transactions = new InMemoryLedgerTransactions(world)
  const ids = new SequenceIdGenerator()
  let mines = 0
  let dwarfs = 0
  const stores = new Map<UsagePath, LedgerStore>()
  const storeFor = (path: UsagePath): LedgerStore => {
    let store = stores.get(path)
    if (store === undefined) {
      store = new InMemoryLedgerRepository({ world, path, scope: transactions, ids, clock })
      stores.set(path, store)
    }
    return store
  }
  return {
    world,
    transactions,
    clock,
    storeFor,
    addMine(tier: LiveMaterial | null): MineId {
      mines += 1
      const id = `00000000-0000-7000-8000-${mines.toString(16).padStart(12, '0')}` as MineId
      world.rows.tiers.set(id, tier)
      return id
    },
    /** A measured mine's tier arriving (`MineMeasured`, 08 §2.1). */
    measure(mineId: MineId, tier: LiveMaterial): void {
      world.rows.tiers.set(mineId, tier)
    },
    addDwarf(mineId: MineId, usagePath: UsagePath): DwarfId {
      dwarfs += 1
      const id = `00000000-0000-7000-9000-${dwarfs.toString(16).padStart(12, '0')}` as DwarfId
      world.rows.dwarfs.set(id, { mineId, usagePath })
      return id
    },
    setInstallMoment(at: Instant | null): void {
      world.rows.installMomentAt = at
    },
    setResetInProgress(inProgress: boolean): void {
      world.rows.resetInProgress = inProgress
    },
    entries(mineId: MineId): StoredEntry[] {
      return [...world.rows.entries.values()]
        .filter((entry) => entry.mineId === mineId)
        .map(({ unitKey, material, tokens, units, kind }) => ({
          unitKey,
          material,
          tokens,
          units,
          kind
        }))
    }
  }
}

/** The contract subject over the in-memory storage. */
export function inMemoryLedgerSubject(): LedgerRepositorySubject {
  const storage = inMemoryLedgerStorage()
  return {
    storeFor: storage.storeFor,
    inTransaction: (work) => storage.transactions.inTransaction(work),
    addMine: storage.addMine,
    addDwarf: storage.addDwarf,
    setInstallMoment: storage.setInstallMoment,
    setResetInProgress: storage.setResetInProgress,
    entries: storage.entries,
    dispose: () => undefined
  }
}

export const LEDGER_EPOCH = 'epoch-0076'

/** The ledger module over the in-memory storage, with a bus that refuses an in-transaction publish. */
export function inMemoryLedger(clock: FakeClock = new FakeClock(1_760_000_000_000)) {
  const storage = inMemoryLedgerStorage(clock)
  const bus = new RecordingEventBus<LedgerEvent>({ transactionScope: storage.transactions })
  const ledger = createLedger({
    stores: { driver: storage.storeFor('driver'), transcript: storage.storeFor('transcript') },
    transactions: storage.transactions,
    scope: storage.transactions,
    bus,
    clock,
    ids: new SequenceIdGenerator(),
    hostEpoch: LEDGER_EPOCH
  })
  return { ...storage, bus, ledger }
}
