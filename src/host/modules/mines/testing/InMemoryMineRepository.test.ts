import { describe } from 'vitest'
import type { MineId } from '../../../kernel/domain/values'
import type { MapSite } from '../domain/mine'
import { InMemoryMineRepository } from './InMemoryMineRepository'
import { runMineRepositoryContract } from './mineRepository.contract'
import { runPresentDwarfCountsContract } from './presentDwarfCounts.contract'

const SITES: readonly [MapSite, MapSite] = [
  { xPct: 31.14, yPct: 28.28 },
  { xPct: 29.43, yPct: 30.48 }
]

// The double runs the same contract as the SQLite adapter (17 §1.3). Its transaction is a
// TransactionScope fake: open while `work` runs, and a throwing `work` restores the rows it saw.
describe('InMemoryMineRepository', () => {
  runMineRepositoryContract(() => {
    let open = false
    const repository = new InMemoryMineRepository({
      scope: { isInTransaction: () => open },
      mapSites: SITES,
      random: () => 0
    })
    return {
      repository,
      mapSites: SITES,
      inTransaction: <T>(work: () => T): T => {
        const before = repository.snapshot()
        open = true
        try {
          return work()
        } catch (error) {
          repository.restore(before)
          throw error
        } finally {
          open = false
        }
      },
      credit: (mineId, material, tokens) => repository.credit(mineId, material, tokens),
      ledgerRows: (mineId) => repository.ledgerRows(mineId),
      dispose: () => undefined
    }
  })
})

// The interim present-dwarf read (until ISSUE-094): the same suite as the SQLite adapter's join.
describe('InMemoryMineRepository (interim present-dwarf counts)', () => {
  runPresentDwarfCountsContract(() => {
    const repository = new InMemoryMineRepository({
      scope: { isInTransaction: () => false },
      mapSites: SITES,
      random: () => 0
    })
    return {
      counts: repository,
      mineIds: [
        '00000000-0000-7000-8000-0000000000f1' as MineId,
        '00000000-0000-7000-8000-0000000000f2' as MineId,
        '00000000-0000-7000-8000-0000000000f3' as MineId
      ],
      seatDwarf: (mineId, present) => repository.seatDwarf(mineId, present),
      dispose: () => undefined
    }
  })
})
