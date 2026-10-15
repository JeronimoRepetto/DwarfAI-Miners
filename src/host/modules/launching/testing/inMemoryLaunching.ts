// The launching store doubles wired as one in-memory "database" for the contract suites and the
// application tests (17 §1.3): one TransactionScope fake that is open while `work` runs, and a
// throwing `work` restores every store's rows. Never imported by production code (R14).
import type { TransactionScope } from '../../../kernel/ports/transactionScope'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { InMemoryLaunchRecordStore } from './InMemoryLaunchRecordStore'
import { InMemoryLaunchStore } from './InMemoryLaunchStore'
import { InMemoryProcessRecordStore } from './InMemoryProcessRecordStore'

export interface InMemoryLaunching {
  clock: FakeClock
  launches: InMemoryLaunchStore
  processes: InMemoryProcessRecordStore
  records: InMemoryLaunchRecordStore
  inTransaction<T>(work: () => T): T
}

export function inMemoryLaunching(start = 1_790_000_000_000): InMemoryLaunching {
  let open = false
  const scope: TransactionScope = { isInTransaction: () => open }
  const clock = new FakeClock(start)
  const launches = new InMemoryLaunchStore(scope, clock)
  const processes = new InMemoryProcessRecordStore(scope, clock)
  const records = new InMemoryLaunchRecordStore(scope, processes)
  return {
    clock,
    launches,
    processes,
    records,
    inTransaction: <T>(work: () => T): T => {
      if (open) return work()
      const before = {
        launches: launches.snapshot(),
        processes: processes.snapshot(),
        records: records.snapshot()
      }
      open = true
      try {
        return work()
      } catch (error) {
        launches.restore(before.launches)
        processes.restore(before.processes)
        records.restore(before.records)
        throw error
      } finally {
        open = false
      }
    }
  }
}
