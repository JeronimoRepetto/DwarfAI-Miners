// The crew application over its in-memory doubles, for L2 tests (17 §1.2): InMemoryDwarfRepository
// and InMemoryLifecycleFactLog under one fake transaction (a throwing `work` restores both), a
// RecordingEventBus that refuses a publish inside that transaction (16 §2.3), FakeClock,
// FakeScheduler and SequenceIdGenerator. Never imported by production code (R14).
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../../kernel/fakes/FakeScheduler'
import { InMemoryLifecycleFactLog } from '../../../kernel/fakes/InMemoryLifecycleFactLog'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { CrewArrivals, OpenAskMemory } from '../application/arrival'
import { CrewReadModel, type SessionLinks } from '../application/crewQueries'
import { StatusTimer } from '../application/statusTimer'
import type { CrewEvent } from '../domain/events'
import { InMemoryDwarfRepository } from './InMemoryDwarfRepository'

export const CREW_T0 = 1_790_000_000_000
export const CREW_EPOCH = 'epoch-0069'

export function inMemoryCrew() {
  let open = false
  const scope = { isInTransaction: () => open }
  const repository = new InMemoryDwarfRepository(scope)
  const facts = new InMemoryLifecycleFactLog(scope)
  let transactions = 0
  const transactionRunner: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      if (open) return work()
      const dwarfs = repository.snapshot()
      const factRows = facts.snapshot()
      open = true
      transactions += 1
      try {
        return work()
      } catch (error) {
        repository.restore(dwarfs)
        facts.restore(factRows)
        throw error
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<CrewEvent>({ transactionScope: scope })
  const clock = new FakeClock(CREW_T0)
  const scheduler = new FakeScheduler(clock)
  const ids = new SequenceIdGenerator()
  const statusTimer = new StatusTimer({ clock, scheduler, bus, ids, hostEpoch: CREW_EPOCH })
  /** Which dwarfs launching owns and which have a delivery route; all false until a test says so. */
  const owned = new Set<DwarfId>()
  const routed = new Set<DwarfId>()
  const links: SessionLinks = {
    owned: (dwarfId) => owned.has(dwarfId),
    hasDeliveryRoute: (dwarfId) => routed.has(dwarfId)
  }
  // As createCrew composes it: the front ask is Host memory beside the stored rows (09 §4.2).
  const remembered = new OpenAskMemory(repository)
  const commands = new CrewArrivals({
    repository: remembered,
    facts,
    transactions: transactionRunner,
    bus,
    clock,
    ids,
    hostEpoch: CREW_EPOCH,
    statusTimer
  })
  const queries = new CrewReadModel({
    repository: remembered,
    clock,
    links,
    presentDwarfs: repository
  })
  return {
    commands,
    queries,
    repository,
    facts,
    bus,
    clock,
    statusTimer,
    owned,
    routed,
    transactionRunner,
    transactions: () => transactions
  }
}
