// The ledger's in-memory doubles assembled for L2 and L3 tests (17 §1.2, §1.3): one shared
// `InMemoryLedgerWorld`, a transaction double that restores it on rollback (as `BEGIN IMMEDIATE …
// ROLLBACK` does), and seeding helpers for the facts other modules own (`dwarfs`, `mines`,
// `install_moment`, `reset_journal`). Never imported by production code (R14).
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId, Instant, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingDiagnosticsLog } from '../../../kernel/fakes/RecordingDiagnosticsLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import type { UsagePath } from '../domain/credit'
import type { LedgerEvent } from '../domain/events'
import type { LiveMaterial } from '../domain/materials'
import { InMemoryLedgerRepository, InMemoryLedgerWorld } from './InMemoryLedgerRepository'
import { createLedger } from '../index'
import { FakeHistoricalUsageScanner } from '../ports/fakes/FakeHistoricalUsageScanner'
import type { HistoricalUsageScanner } from '../ports/historicalUsageScanner'
import type { LedgerRepository } from '../ports/ledgerRepository'
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
  const repository: LedgerRepository = new InMemoryLedgerRepository({
    world,
    scope: transactions,
    ids,
    clock
  })
  return {
    world,
    transactions,
    clock,
    repository,
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
      world.writeInstallMoment(at)
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
    },
    entryIds(mineId: MineId): string[] {
      return [...world.rows.entries.values()]
        .filter((entry) => entry.mineId === mineId)
        .map((entry) => entry.id)
    }
  }
}

/** The contract subject over the in-memory storage. */
export function inMemoryLedgerSubject(): LedgerRepositorySubject {
  const storage = inMemoryLedgerStorage()
  return {
    repository: storage.repository,
    inTransaction: (work) => storage.transactions.inTransaction(work),
    addMine: storage.addMine,
    addDwarf: storage.addDwarf,
    setInstallMoment: storage.setInstallMoment,
    setResetInProgress: storage.setResetInProgress,
    entries: storage.entries,
    entryIds: storage.entryIds,
    dispose: () => undefined
  }
}

export const LEDGER_EPOCH = 'epoch-0076'

type InMemoryLedgerStorage = ReturnType<typeof inMemoryLedgerStorage>

/** The parts a second ledger over the same storage shares with the first. */
interface SharedLedgerParts extends InMemoryLedgerStorage {
  bus: RecordingEventBus<LedgerEvent>
  log: RecordingDiagnosticsLog
  scanner: FakeHistoricalUsageScanner
  eventIds: SequenceIdGenerator
}

export interface InMemoryLedgerOptions {
  /** Another in-memory ledger whose storage, bus, log and event ids this one shares (a restart). */
  storage?: SharedLedgerParts
  /** A repository over the same storage (for example one that fails at a chosen write). */
  repository?: LedgerRepository
  /** The scanner of the coal backfill; the shared or a new `FakeHistoricalUsageScanner` otherwise. */
  scanner?: HistoricalUsageScanner
}

/**
 * The ledger module over the in-memory storage, with a bus that refuses an in-transaction publish,
 * a recording log and a `FakeHistoricalUsageScanner` with no history.
 */
export function inMemoryLedger(
  clock: FakeClock = new FakeClock(1_760_000_000_000),
  options: InMemoryLedgerOptions = {}
) {
  const shared = options.storage
  const storage: InMemoryLedgerStorage = shared ?? inMemoryLedgerStorage(clock)
  const bus =
    shared?.bus ?? new RecordingEventBus<LedgerEvent>({ transactionScope: storage.transactions })
  const log = shared?.log ?? new RecordingDiagnosticsLog()
  const scanner = shared?.scanner ?? new FakeHistoricalUsageScanner()
  const eventIds = shared?.eventIds ?? new SequenceIdGenerator()
  const ledger = createLedger({
    repository: options.repository ?? storage.repository,
    transactions: storage.transactions,
    scope: storage.transactions,
    bus,
    clock: storage.clock,
    ids: eventIds,
    hostEpoch: LEDGER_EPOCH,
    scanner: options.scanner ?? scanner,
    log
  })
  return { ...storage, bus, log, scanner, eventIds, ledger }
}
